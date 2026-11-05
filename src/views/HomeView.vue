<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { supabase } from '../lib/supabaseClient'
import { getCurrentSession } from '../lib/authStore'
import { withTimeout, makeSafeLoader } from '../lib/withTimeout'
import { checkModeration } from '../lib/moderation'
import { recordAndCheckSpam } from '../lib/spam'

const router = useRouter()
function goToProfile(userId) {
  const session = getCurrentSession()
  if (userId === session?.user?.id) router.push('/profile')
  else router.push(`/profile/${userId}`)
}

const posts          = ref([])
const loading        = ref(true)
const file           = ref(null)
const caption        = ref('')
const previewUrl     = ref(null)
const commentText    = ref({})
const uploading      = ref(false)
const currentUser    = ref(null)
const userProfile    = ref(null)
const deletingId     = ref(null)
const expandedComments = ref({})
const likedPosts     = ref(new Set())
let realtimeSub = null
let visibilityHandler = null

// Lightbox
const lightboxUrl    = ref(null)
const lightboxCaption = ref('')

// Admin announcements
const adminAnnouncements = ref([])
const adminBroadcast = ref(null)

// Spam prevention — per-action timestamps
const lastCommentTime = ref({})  // postId → timestamp
const lastPostTime    = ref(0)
const COMMENT_COOLDOWN = 10000   // 10s between comments on same post
const POST_COOLDOWN    = 30000   // 30s between new posts

function openLightbox(url, cap) {
  lightboxUrl.value = url
  lightboxCaption.value = cap || ''
}
function closeLightbox() { lightboxUrl.value = null }

const _safeLoad = makeSafeLoader(loading)
async function fetchPosts() {
  await _safeLoad(async () => {
    const { data } = await withTimeout(
      supabase
        .from('posts')
        .select(`*, profiles(id, username, avatar_url, is_premium, is_official, username_color, is_anonymous), likes(id, user_id), comments(id, content, created_at, profiles(username, is_official))`)
        .order('created_at', { ascending: false }),
      10000
    )
    if (data) {
      posts.value = data
      if (currentUser.value) {
        const liked = new Set()
        data.forEach(p => { if (p.likes?.some(l => l.user_id === currentUser.value.id)) liked.add(p.id) })
        likedPosts.value = liked
      }
    }
  })
}

// Track posts we're currently liking so realtime doesn't double-count
const pendingLikes = new Set()

async function toggleLike(postId) {
  if (!currentUser.value || pendingLikes.has(postId)) return
  pendingLikes.add(postId)
  const isLiked = likedPosts.value.has(postId)
  const post = posts.value.find(p => p.id === postId)
  if (isLiked) {
    likedPosts.value.delete(postId)
    if (post) post.likes = (post.likes || []).filter(l => l.user_id !== currentUser.value.id)
    await supabase.from('likes').delete().match({ user_id: currentUser.value.id, post_id: postId })
  } else {
    likedPosts.value.add(postId)
    if (post) post.likes = [...(post.likes || []), { user_id: currentUser.value.id, post_id: postId }]
    await supabase.from('likes').insert({ user_id: currentUser.value.id, post_id: postId })
  }
  // Short delay so realtime events for this action are ignored
  setTimeout(() => pendingLikes.delete(postId), 1500)
}

async function deletePost(postId) {
  if (!confirm('Delete this post?')) return
  deletingId.value = postId
  await supabase.from('likes').delete().eq('post_id', postId)
  await supabase.from('comments').delete().eq('post_id', postId)
  const { error } = await supabase.from('posts').delete().eq('id', postId).eq('user_id', currentUser.value.id)
  if (!error) posts.value = posts.value.filter(p => p.id !== postId)
  else alert('Could not delete post: ' + error.message)
  deletingId.value = null
}

async function sendComment(postId) {
  const content = commentText.value[postId]?.trim()
  if (!content || !currentUser.value) return

  const mod = await checkModeration(content, userProfile.value)
  if (mod.blocked) {
    alert(mod.reason)
    if (mod.banned) router.push('/auth')
    else {
      commentText.value[postId] = ''
      const { data } = await supabase.from('profiles').select('warnings_count, is_banned').eq('id', currentUser.value.id).maybeSingle()
      if (data) Object.assign(userProfile.value, data)
    }
    return
  }

  // ── Spam prevention ──
  const now = Date.now()
  const last = lastCommentTime.value[postId] || 0
  if (now - last < COMMENT_COOLDOWN) {
    const wait = Math.ceil((COMMENT_COOLDOWN - (now - last)) / 1000)
    alert(`Please wait ${wait}s before commenting again on this post.`)
    return
  }

  // Duplicate comment check
  const post = posts.value.find(p => p.id === postId)
  const isDuplicate = post?.comments?.some(c =>
    c.profiles?.username === (post.profiles?.username) ? false :
    c.content?.toLowerCase() === content.toLowerCase()
  )
  // More reliable: check if current user's last comment is identical
  const myLastComment = post?.comments?.slice().reverse().find(c =>
    c.profiles?.username && currentUser.value
  )
  // Just check recent duplication from any user perspective:
  const recentDupe = post?.comments?.slice(-5).some(c => c.content?.toLowerCase() === content.toLowerCase())
  if (recentDupe) {
    alert('This comment was already posted recently.')
    return
  }

  lastCommentTime.value[postId] = now

  const { data: newComment } = await supabase
    .from('comments')
    .insert({ user_id: currentUser.value.id, post_id: postId, content })
    .select('id, content, created_at, profiles(username, is_official)')
    .single()
  if (newComment) {
    if (post) post.comments = [...(post.comments || []), newComment]
    expandedComments.value[postId] = true

    // Anti-spam check
    const spam = await recordAndCheckSpam(userProfile.value, newComment.id, 'comments', content)
    if (spam.blocked) {
      alert(spam.reason)
      if (spam.banned) router.push('/auth')
      else {
        // Refresh local profile for warning count
        const { data: p } = await supabase.from('profiles').select('warnings_count, is_banned').eq('id', currentUser.value.id).maybeSingle()
        if (p) Object.assign(userProfile.value, p)
      }
    }
  }
  commentText.value[postId] = ''
}

async function deleteComment(postId, commentId) {
  await supabase.from('comments').delete().eq('id', commentId)
  const post = posts.value.find(p => p.id === postId)
  if (post) post.comments = post.comments.filter(c => c.id !== commentId)
}

const handleFile = (e) => {
  const f = e.target.files[0]
  if (!f) return
  if (!f.type.startsWith('image/') || f.type.toLowerCase().includes('gif')) {
    alert("Seules les images statiques (JPEG, PNG, WebP) sont autorisées.")
    return
  }
  file.value = f
  previewUrl.value = URL.createObjectURL(f)
}

async function uploadPost() {
  if (!file.value || !currentUser.value) return

  const mod = await checkModeration(caption.value.trim(), userProfile.value)
  if (mod.blocked) {
    alert(mod.reason)
    if (mod.banned) router.push('/auth')
    else {
      caption.value = ''
      const { data } = await supabase.from('profiles').select('warnings_count, is_banned').eq('id', currentUser.value.id).maybeSingle()
      if (data) Object.assign(userProfile.value, data)
    }
    return
  }

  // ── Spam prevention: post cooldown ──
  const now = Date.now()
  if (now - lastPostTime.value < POST_COOLDOWN) {
    const wait = Math.ceil((POST_COOLDOWN - (now - lastPostTime.value)) / 1000)
    alert(`Please wait ${wait}s before posting again.`)
    return
  }
  lastPostTime.value = now

  uploading.value = true
  try {
    const ext = file.value.type === 'image/png' ? 'png' : file.value.type === 'image/webp' ? 'webp' : 'jpg'
    const fileName = `${currentUser.value.id}/${Date.now()}.${ext}`
    const { error: uploadErr } = await supabase.storage.from('media').upload(fileName, file.value)
    if (uploadErr) throw uploadErr
    const { data: { publicUrl } } = supabase.storage.from('media').getPublicUrl(fileName)
    const { data: insertedPost, error: insertErr } = await supabase.from('posts').insert([{ user_id: currentUser.value.id, caption: caption.value, media_url: publicUrl }]).select().single()
    if (insertErr) throw insertErr
    
    // Anti-spam check
    const spam = await recordAndCheckSpam(userProfile.value, insertedPost.id, 'posts', caption.value)
    if (spam.blocked) {
      alert(spam.reason)
      if (spam.banned) router.push('/auth')
      else {
        const { data: p } = await supabase.from('profiles').select('warnings_count, is_banned').eq('id', currentUser.value.id).maybeSingle()
        if (p) Object.assign(userProfile.value, p)
      }
    }

    caption.value = ''
    file.value = null
    previewUrl.value = null
    // Realtime subscription will add the new post automatically
  } catch (err) {
    alert('Failed to post: ' + err.message)
    lastPostTime.value = 0 // reset cooldown so they can retry
  } finally {
    uploading.value = false
  }
}

function formatTime(ts) {
  const diff = Date.now() - new Date(ts)
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

async function freezeIfGif(img, url) {
  if (!img || img.dataset.frozen) return
  img.dataset.frozen = 'true'
  
  let isGif = url.toLowerCase().includes('.gif')
  // Check Content-Type for older uploads without extension
  if (!isGif && url.includes('supabase.co')) {
    try {
      const resp = await fetch(url, { method: 'HEAD' })
      if (resp.headers.get('content-type') === 'image/gif') isGif = true
    } catch {}
  }
  
  if (isGif) {
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth || img.width
    canvas.height = img.naturalHeight || img.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    try {
      img.src = canvas.toDataURL('image/jpeg', 0.9)
    } catch {}
  }
}

const viewedPosts = new Set()
async function recordView(postId) {
  if (viewedPosts.has(postId)) return
  viewedPosts.add(postId)
  
  // Optimistic update locally
  const p = posts.value.find(x => x.id === postId)
  if (p) p.views = (Number(p.views) || 0) + 1

  try {
    await supabase.rpc('increment_post_views', { post_id: postId })
  } catch (e) {
    console.warn('recordView error:', e)
  }
}

onMounted(async () => {
  const session = getCurrentSession()
  currentUser.value = session?.user || null
  if (currentUser.value) {
    const { data } = await supabase.from('profiles').select('warnings_count, is_banned').eq('id', currentUser.value.id).maybeSingle()
    userProfile.value = data
  }
  fetchPosts()

  // Realtime: new posts
  realtimeSub = supabase.channel('home-feed')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts' }, async payload => {
      const { data } = await supabase
        .from('posts')
        .select(`*, profiles(id, username, avatar_url, is_premium, is_official, username_color), likes(id, user_id), comments(id, content, created_at, profiles(username, is_official))`)
        .eq('id', payload.new.id).single()
      if (data && !posts.value.find(p => p.id === data.id)) {
        posts.value.unshift(data)
      }
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'posts' }, payload => {
      posts.value = posts.value.filter(p => p.id !== payload.old.id)
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'likes' }, payload => {
      // Skip if we triggered this (already optimistically updated)
      if (payload.new.user_id === currentUser.value?.id && pendingLikes.has(payload.new.post_id)) return
      const post = posts.value.find(p => p.id === payload.new.post_id)
      if (post && !post.likes?.find(l => l.user_id === payload.new.user_id && l.post_id === payload.new.post_id)) {
        post.likes = [...(post.likes || []), payload.new]
        if (payload.new.user_id === currentUser.value?.id) likedPosts.value.add(payload.new.post_id)
      }
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'likes' }, payload => {
      if (payload.old.user_id === currentUser.value?.id && pendingLikes.has(payload.old.post_id)) return
      const post = posts.value.find(p => p.id === payload.old.post_id)
      if (post) {
        post.likes = (post.likes || []).filter(l => !(l.user_id === payload.old.user_id && l.post_id === payload.old.post_id))
        if (payload.old.user_id === currentUser.value?.id) likedPosts.value.delete(payload.old.post_id)
      }
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comments' }, async payload => {
      const post = posts.value.find(p => p.id === payload.new.post_id)
      if (post) {
        const { data } = await supabase
          .from('comments')
          .select('id, content, created_at, profiles(username, is_official)')
          .eq('id', payload.new.id).single()
        if (data && !post.comments?.find(c => c.id === data.id)) {
          post.comments = [...(post.comments || []), data]
        }
      }
    })
    .subscribe()

  // Refresh when returning to tab
  let homeHiddenAt = 0
  visibilityHandler = () => {
    if (document.visibilityState === 'visible') {
      const hiddenFor = Date.now() - homeHiddenAt
      if (homeHiddenAt > 0 && hiddenFor > 5 * 60 * 1000) fetchPosts()
      homeHiddenAt = 0
    } else {
      homeHiddenAt = Date.now()
    }
  }
  document.addEventListener('visibilitychange', visibilityHandler)

  // Load admin announcements
  try {
    const { data: ann } = await supabase
      .from('announcements')
      .select('*')
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(3)
    adminAnnouncements.value = ann || []
  } catch {}

  // Load latest admin broadcast (HTML/JS)
  try {
    const { data: bc } = await supabase
      .from('admin_broadcasts')
      .select('*')
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(1)
    if (bc?.[0]) {
      adminBroadcast.value = bc[0]
      // Execute JS if present
      if (bc[0].js_content?.trim()) {
        try {
          // eslint-disable-next-line no-new-func
          new Function(bc[0].js_content)()
        } catch (err) {
          console.warn('Admin broadcast JS error:', err)
        }
      }
    }
  } catch {}
})

onUnmounted(() => {
  realtimeSub?.unsubscribe()
  if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler)
})
</script>

<template>
  <div class="home">
    <!-- Admin Announcements -->
    <div v-if="adminAnnouncements.length" class="announcements-bar">
      <div v-for="ann in adminAnnouncements" :key="ann.id" class="ann-banner" :class="ann.type">
        <span class="ann-icon">
          <svg v-if="ann.type === 'info'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
          <svg v-else-if="ann.type === 'success'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="20 6 9 17 4 12"/></svg>
          <svg v-else-if="ann.type === 'warning'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>
        </span>
        <span>{{ ann.content }}</span>
      </div>
    </div>

    <!-- Admin HTML Broadcast -->
    <div v-if="adminBroadcast" class="admin-broadcast-wrap">
      <div v-if="adminBroadcast.broadcast_type === 'banner'" class="broadcast-banner" v-html="adminBroadcast.html_content"></div>
      <div v-else-if="adminBroadcast.broadcast_type === 'inline'" class="broadcast-inline" v-html="adminBroadcast.html_content"></div>
      <!-- Modal broadcast -->
      <div v-else-if="adminBroadcast.broadcast_type === 'modal'" class="broadcast-modal-wrap" @click.self="adminBroadcast = null">
        <div class="broadcast-modal">
          <button class="bm-close" @click="adminBroadcast = null">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:14px;height:14px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
          <div v-html="adminBroadcast.html_content"></div>
        </div>
      </div>
    </div>
    <div class="topbar">
      <h1 class="page-title">Feed</h1>
      <label class="upload-trigger">
        <input type="file" @change="handleFile" accept="image/jpeg,image/png,image/webp" hidden />
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
        New Post
      </label>
    </div>

    <!-- Create bar -->
    <div v-if="previewUrl" class="create-bar">
      <img :src="previewUrl" class="post-preview-thumb" />
      <div class="create-bar-fields">
        <textarea v-model="caption" placeholder="Write a caption..." rows="2" class="caption-input" />
        <div class="create-bar-actions">
          <button class="btn-ghost" @click="previewUrl = null; file = null">Cancel</button>
          <button class="btn-primary" @click="uploadPost" :disabled="uploading">
            <span v-if="uploading" class="btn-spin"></span>
            {{ uploading ? 'Posting...' : 'Share Post' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="loading" class="main-loader"><div class="spinner"></div><p>Fetching your feed...</p></div>

    <div v-else-if="posts.length === 0" class="status-msg">
      <div class="empty-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:48px;height:48px;margin-bottom:16px;opacity:0.3"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
      </div>
      <p>No posts yet. Be the first to share!</p>
    </div>

    <div v-else class="bento-grid">
      <article v-for="post in posts" :key="post.id" class="card" :class="{ deleting: deletingId === post.id }">

        <!-- Media — click opens lightbox -->
        <div class="card-media" @click="openLightbox(post.media_url, post.caption); recordView(post.id)" @dblclick.stop="toggleLike(post.id)">
          <img :src="post.media_url" :alt="post.caption || 'post'" loading="lazy" crossorigin="anonymous" @load="freezeIfGif($event.target, post.media_url); recordView(post.id)" />
          <div class="media-hint">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
          </div>
          <div class="heart-anim" v-if="likedPosts.has(post.id)">
            <svg viewBox="0 0 24 24" fill="white" style="width:50px;height:50px"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          </div>
        </div>

        <!-- Body -->
        <div class="card-body">
          <div class="author-row">
            <div class="av-xs">
              <template v-if="post.profiles?.is_anonymous">
                <div class="anon-icon-xs">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
                </div>
              </template>
              <template v-else>
                <img v-if="post.profiles?.avatar_url" :src="post.profiles.avatar_url" />
                <span v-else>{{ post.profiles?.username?.charAt(0)?.toUpperCase() }}</span>
              </template>
            </div>

            <span v-if="post.profiles?.is_anonymous" class="author-name">
              Anonyme
            </span>
            <span v-else class="author-name profile-link" :style="post.profiles?.username_color ? { color: post.profiles.username_color } : {}" @click="goToProfile(post.user_id)" style="cursor:pointer">
              @{{ post.profiles?.username || 'user' }}
            </span>

            <!-- Official badge -->
            <span v-if="!post.profiles?.is_anonymous && post.profiles?.is_official" class="official-badge" title="Official Account">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"/></svg>
            </span>

            <!-- Premium icon -->
            <span v-else-if="!post.profiles?.is_anonymous && post.profiles?.is_premium" class="prem-icon" title="Premium">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            </span>

            <span class="post-time">{{ formatTime(post.created_at) }}</span>

            <button v-if="post.user_id === currentUser?.id" class="delete-btn" @click="deletePost(post.id)" title="Delete post">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
            </button>
          </div>

          <div class="post-stats-row">
            <div class="view-count" title="Views">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              <span>{{ (post.views || 0).toLocaleString() }}</span>
            </div>
          </div>

          <p v-if="post.caption" class="caption">{{ post.caption }}</p>

          <div class="actions-row">
            <button class="action-btn" :class="{ liked: likedPosts.has(post.id) }" @click="toggleLike(post.id)">
              <svg viewBox="0 0 24 24" :fill="likedPosts.has(post.id) ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
              {{ post.likes?.length || 0 }}
            </button>
            <button class="action-btn" @click="expandedComments[post.id] = !expandedComments[post.id]">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              {{ post.comments?.length || 0 }}
            </button>
          </div>

          <!-- Comments -->
          <div v-if="expandedComments[post.id] && post.comments?.length" class="comments-list">
            <div v-for="c in post.comments" :key="c.id" class="comment">
              <span class="comment-body">
                <strong>{{ c.profiles?.username || 'user' }}</strong>
                <span v-if="c.profiles?.is_official" class="comment-official" title="Official">
                  <svg viewBox="0 0 24 24" fill="currentColor" style="width:10px;height:10px"><path d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"/></svg>
                </span>
                {{ c.content }}
              </span>
              <button
                v-if="currentUser?.id === post.user_id"
                class="del-comment"
                @click="deleteComment(post.id, c.id)"
              >×</button>
            </div>
          </div>

          <!-- Comment input -->
          <div class="comment-input-row">
            <input
              v-model="commentText[post.id]"
              placeholder="Add a comment…"
              @keyup.enter="sendComment(post.id)"
              class="comment-input"
            />
            <button class="send-btn" @click="sendComment(post.id)" :disabled="!commentText[post.id]?.trim()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </div>
        </div>
      </article>
    </div>

    <!-- ── LIGHTBOX ── -->
    <Teleport to="body">
      <div v-if="lightboxUrl" class="lightbox" @click.self="closeLightbox">
        <button class="lb-close" @click="closeLightbox">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <div class="lb-content" @click.stop>
          <img :src="lightboxUrl" class="lb-img" />
          <p v-if="lightboxCaption" class="lb-caption">{{ lightboxCaption }}</p>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.home { padding: 28px 32px; max-width: 960px; }

/* Admin announcements */
.announcements-bar { display: flex; flex-direction: column; gap: 8px; margin-bottom: 18px; }
.ann-banner {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 16px; border-radius: 10px;
  font-size: 0.88rem; font-weight: 500;
  border-left: 4px solid;
}
.ann-banner.info { background: #eff6ff; border-color: #3b82f6; color: #1d4ed8; }
.ann-banner.success { background: #f0fdf4; border-color: #22c55e; color: #15803d; }
.ann-banner.warning { background: #fffbeb; border-color: #f59e0b; color: #92400e; }
.ann-banner.danger { background: #fff0f0; border-color: #ef4444; color: #b91c1c; }
.ann-icon { font-size: 1rem; }

/* Broadcasts */
.admin-broadcast-wrap { margin-bottom: 20px; }
.broadcast-banner { border-radius: 12px; overflow: hidden; }
.broadcast-inline { background: white; border-radius: 14px; padding: 16px; box-shadow: 0 2px 12px rgba(76,16,224,0.07); margin-bottom: 4px; }
.broadcast-modal-wrap {
  position: fixed; inset: 0; z-index: 900;
  background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
}
.broadcast-modal {
  background: white; border-radius: 18px;
  padding: 24px; max-width: 540px; width: 100%;
  max-height: 80vh; overflow-y: auto; position: relative;
  box-shadow: 0 20px 60px rgba(0,0,0,0.25);
}
.bm-close {
  position: absolute; top: 12px; right: 12px;
  width: 30px; height: 30px; border-radius: 50%;
  background: #f0eeff; border: none; cursor: pointer;
  font-size: 0.9rem; color: var(--text-2);
  display: flex; align-items: center; justify-content: center;
}
.bm-close:hover { background: #e0d5ff; }

.topbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
.page-title { font-family: 'Epilogue', sans-serif; font-size: 1.6rem; font-weight: 800; color: var(--text); }

.upload-trigger { display: flex; align-items: center; gap: 8px; padding: 10px 18px; background: var(--purple); color: white; border-radius: 12px; font-size: 0.88rem; font-weight: 600; cursor: pointer; transition: background .18s; }
.upload-trigger:hover { background: var(--purple-d); }
.upload-trigger svg { width: 18px; height: 18px; }

.create-bar { display: flex; gap: 16px; background: white; border-radius: 16px; padding: 16px; margin-bottom: 24px; box-shadow: 0 2px 12px rgba(76,16,224,0.08); }
.post-preview-thumb { width: 90px; height: 90px; object-fit: cover; border-radius: 10px; flex-shrink: 0; }
.create-bar-fields { flex: 1; display: flex; flex-direction: column; gap: 10px; }
.caption-input { width: 100%; border: 1.5px solid #e2d9ff; border-radius: 10px; padding: 10px 14px; font-family: 'Instrument Sans', sans-serif; font-size: 0.9rem; resize: none; outline: none; transition: border-color .18s; }
.caption-input:focus { border-color: var(--purple); }
.create-bar-actions { display: flex; gap: 8px; justify-content: flex-end; }
.btn-ghost { padding: 8px 16px; border: 1.5px solid #ddd; border-radius: 9px; background: none; font-size: 0.85rem; cursor: pointer; }
.btn-primary { display: flex; align-items: center; gap: 8px; padding: 8px 18px; background: var(--purple); color: white; border: none; border-radius: 9px; font-weight: 600; font-size: 0.85rem; cursor: pointer; transition: background .18s; }
.btn-primary:hover { background: var(--purple-d); }
.btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
.btn-spin { width: 13px; height: 13px; border: 2px solid rgba(255,255,255,0.4); border-top-color: white; border-radius: 50%; animation: spin .6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.status-msg { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 80px 0; color: var(--text-2); }
.empty-icon { font-size: 2.5rem; }
.spinner { width: 36px; height: 36px; border: 3px solid #e2d9ff; border-top-color: var(--purple); border-radius: 50%; animation: spin .7s linear infinite; }

.bento-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; }

.card { background: var(--card); border-radius: 18px; overflow: hidden; box-shadow: 0 2px 16px rgba(76,16,224,0.07); transition: transform .2s, box-shadow .2s, opacity .2s; }
.card:hover { transform: translateY(-2px); box-shadow: 0 6px 24px rgba(76,16,224,0.12); }
.card.deleting { opacity: 0.4; pointer-events: none; }

/* Media with lightbox hint */
.card-media { position: relative; cursor: pointer; overflow: hidden; }
.card-media img { width: 100%; height: 260px; object-fit: cover; display: block; transition: transform .3s; }
.card-media:hover img { transform: scale(1.02); }
.media-hint {
  position: absolute; top: 8px; right: 8px;
  width: 28px; height: 28px;
  background: rgba(0,0,0,0.45); border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  opacity: 0; transition: opacity .2s;
}
.media-hint svg { width: 14px; height: 14px; color: white; }
.card-media:hover .media-hint { opacity: 1; }

.heart-anim { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); font-size: 3rem; pointer-events: none; animation: heartpop .5s ease forwards; }
@keyframes heartpop {
  0%   { opacity: 0; transform: translate(-50%,-50%) scale(0.3); }
  50%  { opacity: 1; transform: translate(-50%,-50%) scale(1.3); }
  100% { opacity: 0; transform: translate(-50%,-50%) scale(1); }
}
.card-body { padding: 14px 16px 12px; }

.post-stats-row { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.view-count { display: flex; align-items: center; gap: 4px; font-size: 0.75rem; color: var(--text-2); opacity: 0.8; }
.view-count svg { opacity: 0.7; }

.author-row { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
.anon-icon-xs { display:flex; align-items:center; justify-content:center; width:100%; height:100%; color:white; background:linear-gradient(135deg, #1e293b, #0f172a); border-radius:50%; }
.anon-icon-xs svg { width:14px; height:14px; }
.av-xs { width: 28px; height: 28px; border-radius: 50%; background: var(--purple); color: white; font-size: 0.75rem; font-weight: 700; display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0; }
.av-xs img { width: 100%; height: 100%; object-fit: cover; }
.author-name { font-weight: 700; font-size: 0.85rem; flex: 1; transition: color .2s; }

/* Official badge — blue checkmark */
.official-badge {
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px;
  background: #1d9bf0; border-radius: 50%; color: white; flex-shrink: 0;
}
.official-badge svg { width: 10px; height: 10px; }

/* Premium lightning */
.prem-icon { display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; background: linear-gradient(135deg,#fbbf24,#f97316); border-radius: 50%; color: white; flex-shrink: 0; }
.prem-icon svg { width: 9px; height: 9px; }

.post-time { color: var(--text-2); font-size: 0.75rem; margin-left: auto; }
.delete-btn { padding: 4px; background: none; border: none; cursor: pointer; color: #ccc; border-radius: 6px; display: flex; transition: color .15s, background .15s; }
.delete-btn svg { width: 15px; height: 15px; }
.delete-btn:hover { color: #e74c3c; background: #fff0f0; }

.caption { font-size: 0.85rem; color: var(--text-2); margin-bottom: 10px; line-height: 1.4; }

.actions-row { display: flex; gap: 12px; margin-bottom: 10px; }
.action-btn { display: flex; align-items: center; gap: 5px; background: none; border: none; color: var(--text-2); font-size: 0.83rem; font-family: 'Instrument Sans', sans-serif; cursor: pointer; padding: 4px; border-radius: 6px; transition: color .15s; }
.action-btn svg { width: 16px; height: 16px; }
.action-btn:hover { color: var(--purple); }
.action-btn.liked { color: #e74c3c; }

.comments-list { background: #f7f4ff; border-radius: 10px; padding: 8px 10px; margin-bottom: 10px; max-height: 120px; overflow-y: auto; }
.comment { display: flex; align-items: flex-start; justify-content: space-between; gap: 6px; margin-bottom: 5px; }
.comment-body { font-size: 0.8rem; color: var(--text-2); line-height: 1.4; flex: 1; display: flex; align-items: center; gap: 3px; flex-wrap: wrap; }
.comment-body strong { color: var(--text); }
.comment-official { display: inline-flex; align-items: center; justify-content: center; width: 12px; height: 12px; background: #1d9bf0; border-radius: 50%; color: white; flex-shrink: 0; }
.del-comment { background: none; border: none; color: #ccc; cursor: pointer; font-size: 1rem; line-height: 1; padding: 0 2px; flex-shrink: 0; transition: color .15s; }
.del-comment:hover { color: #e74c3c; }

.comment-input-row { display: flex; gap: 8px; align-items: center; }
.comment-input { flex: 1; padding: 8px 14px; border: 1.5px solid #e8e0ff; border-radius: 20px; font-size: 0.82rem; font-family: 'Instrument Sans', sans-serif; outline: none; transition: border-color .18s; }
.comment-input:focus { border-color: var(--purple); }
.send-btn { width: 34px; height: 34px; border-radius: 50%; background: var(--purple); border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background .18s; }
.send-btn svg { width: 14px; height: 14px; color: white; }
.send-btn:hover { background: var(--purple-d); }
.send-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* ── LIGHTBOX ── */
.lightbox {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(0,0,0,0.88);
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
  animation: lbIn .2s ease;
  backdrop-filter: blur(6px);
}
@keyframes lbIn { from { opacity: 0 } to { opacity: 1 } }

.lb-close {
  position: absolute; top: 16px; right: 16px;
  width: 40px; height: 40px;
  background: rgba(255,255,255,0.15); border: none; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; color: white; transition: background .15s;
}
.lb-close:hover { background: rgba(255,255,255,0.25); }
.lb-close svg { width: 18px; height: 18px; }

.lb-content { display: flex; flex-direction: column; align-items: center; gap: 14px; max-width: min(90vw, 900px); }
.lb-img {
  max-width: 100%; max-height: 80vh;
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  object-fit: contain;
}
.lb-caption { color: rgba(255,255,255,0.75); font-size: 0.9rem; text-align: center; max-width: 600px; }

@media (max-width: 600px) {
  .home { padding: 16px; }
  .bento-grid { grid-template-columns: 1fr; }
}
</style>
