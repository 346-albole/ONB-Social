<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { supabase } from '../lib/supabaseClient'
import { getCurrentSession } from '../lib/authStore'
import { withTimeout, makeSafeLoader } from '../lib/withTimeout'
import { useRouter } from 'vue-router'
import { checkModeration } from '../lib/moderation'
import { recordAndCheckSpam } from '../lib/spam'

const router = useRouter()
function goToProfile(userId) {
  const session = getCurrentSession()
  if (userId === session?.user?.id) router.push('/profile')
  else router.push(`/profile/${userId}`)
}

const currentUser    = ref(null)
const currentProfile = ref(null)
const loading        = ref(true)

// View state: 'list' | 'post'
const view = ref('list')
const activePost = ref(null)

// Forum categories
const categories = ref([
  { id: 'general',      label: 'Général',       color: '#6366f1', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' },
  { id: 'tech',         label: 'Tech & Code',    color: '#0ea5e9', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>' },
  { id: 'gaming',       label: 'Gaming',         color: '#22c55e', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="12" x2="10" y2="12"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="15" y1="13" x2="15.01" y2="13"/><line x1="18" y1="11" x2="18.01" y2="11"/><rect x="2" y="6" width="20" height="12" rx="2"/></svg>' },
  { id: 'musique',      label: 'Musique',        color: '#f59e0b', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>' },
  { id: 'sport',        label: 'Sport',          color: '#ef4444', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M6.7 6.7l10.6 10.6M6.7 17.3L17.3 6.7"/></svg>' },
  { id: 'art',          label: 'Art & Créa',     color: '#ec4899', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>' },
  { id: 'aide',         label: 'Aide',           color: '#8b5cf6', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0-3-3 3 3 0 0 0-3 3c0 3 4.5 6 4.5 6s4.5-3 4.5-6z"/><path d="M12 13V22"/><path d="M9 18l3 3 3-3"/></svg>' },
  { id: 'off-topic',    label: 'Off-topic',      color: '#94a3b8', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-8 0 4 4 0 0 0-8 0"/></svg>' },
])

// Posts list
const posts          = ref([])
const loadingPosts   = ref(false)
const activeCategory = ref(null) // null = all
const sortBy         = ref('hot') // 'hot' | 'new' | 'top'
const searchQ        = ref('')

// Create post
const showCreate     = ref(false)
const newTitle       = ref('')
const newContent     = ref('')
const newCategory    = ref('general')
const newImageFile   = ref(null)
const newImagePreview= ref(null)
const creating       = ref(false)

// Post detail
const postComments   = ref([])
const loadingComments= ref(false)
const newComment     = ref('')
const replyTo        = ref(null) // {id, username}
const sendingComment = ref(false)
const likedPosts     = ref(new Set())
const likedComments  = ref(new Set())
const pendingLikes   = ref(new Set())

let realtimeSub = null

// ── LOAD ──────────────────────────────────────────────────────
onMounted(async () => {
  const _safeLoad = makeSafeLoader(loading)
  await _safeLoad(async () => {
    const session = getCurrentSession()
    currentUser.value = session?.user || null
    if (currentUser.value) {
      const { data: p } = await withTimeout(
        supabase.from('profiles')
          .select('id, username, avatar_url, username_color, is_premium, is_official, is_admin, warnings_count, is_banned')
          .eq('id', currentUser.value.id).maybeSingle(),
        8000
      )
      currentProfile.value = p
    }
    await loadPosts()
  })
})

onUnmounted(() => { realtimeSub?.unsubscribe() })

// ── POSTS ─────────────────────────────────────────────────────
async function loadPosts() {
  loadingPosts.value = true
  try {
    let q = supabase.from('forum_posts')
      .select('id, title, content, category, image_url, created_at, user_id, profiles(id, username, avatar_url, username_color, is_premium, is_official), forum_votes(count), forum_comments(count)')
      .order('created_at', { ascending: false })
      .limit(50)
    if (activeCategory.value) q = q.eq('category', activeCategory.value)

    const result = await withTimeout(q, 10000)
    if (result?.data) {
      posts.value = result.data
      if (currentUser.value) {
        const votesResult = await withTimeout(
          supabase.from('forum_votes')
            .select('post_id').eq('user_id', currentUser.value.id).is('comment_id', null),
          8000
        )
        likedPosts.value = new Set(votesResult?.data?.map(v => v.post_id) || [])
      }
    }
  } catch (e) {
    console.warn('loadPosts error:', e)
  } finally {
    loadingPosts.value = false
  }
}

const filteredPosts = computed(() => {
  let arr = posts.value
  if (searchQ.value.trim()) {
    const q = searchQ.value.toLowerCase()
    arr = arr.filter(p => p.title?.toLowerCase().includes(q) || p.content?.toLowerCase().includes(q))
  }
  if (sortBy.value === 'hot') {
    return [...arr].sort((a, b) => {
      const scoreA = (a.forum_votes?.[0]?.count || 0) * 2 + (a.forum_comments?.[0]?.count || 0)
      const scoreB = (b.forum_votes?.[0]?.count || 0) * 2 + (b.forum_comments?.[0]?.count || 0)
      if (scoreA !== scoreB) return scoreB - scoreA
      return new Date(b.created_at) - new Date(a.created_at)
    })
  }
  if (sortBy.value === 'top') {
    return [...arr].sort((a, b) => (b.forum_votes?.[0]?.count || 0) - (a.forum_votes?.[0]?.count || 0))
  }
  return arr // 'new' = already sorted by created_at desc
})

// ── OPEN POST ─────────────────────────────────────────────────
async function openPost(post) {
  activePost.value = post
  view.value = 'post'
  await loadComments(post.id)
  subscribePost(post.id)
}

function backToList() {
  view.value = 'list'
  activePost.value = null
  realtimeSub?.unsubscribe()
  replyTo.value = null
  newComment.value = ''
}

// ── COMMENTS ──────────────────────────────────────────────────
async function loadComments(postId) {
  loadingComments.value = true
  try {
    const [commentsRes, votesRes] = await Promise.all([
      withTimeout(
        supabase.from('forum_comments')
          .select('id, content, created_at, user_id, parent_id, profiles(id, username, avatar_url, username_color, is_premium, is_official), forum_votes(count)')
          .eq('post_id', postId)
          .order('created_at', { ascending: true }),
        8000
      ),
      currentUser.value
        ? withTimeout(
            supabase.from('forum_votes')
              .select('comment_id').eq('user_id', currentUser.value.id).not('comment_id', 'is', null),
            8000
          )
        : Promise.resolve(null),
    ])
    if (!commentsRes?.error) {
      postComments.value = commentsRes?.data || []
      likedComments.value = new Set(votesRes?.data?.map(v => v.comment_id) || [])
    }
  } catch (e) {
    console.warn('loadComments error:', e)
  } finally {
    loadingComments.value = false
  }
}

function subscribePost(postId) {
  realtimeSub?.unsubscribe()
  realtimeSub = supabase.channel(`forum-post-${postId}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'forum_comments',
      filter: `post_id=eq.${postId}`
    }, async payload => {
      if (postComments.value.find(c => c.id === payload.new.id)) return
      const { data } = await supabase.from('forum_comments')
        .select('id, content, created_at, user_id, parent_id, profiles(id, username, avatar_url, username_color, is_premium, is_official), forum_votes(count)')
        .eq('id', payload.new.id).single()
      if (data) postComments.value.push(data)
    })
    .subscribe()
}

// ── VOTE ON POST ───────────────────────────────────────────────
async function votePost(post) {
  if (!currentUser.value || pendingLikes.value.has('p' + post.id)) return
  pendingLikes.value.add('p' + post.id)
  const isLiked = likedPosts.value.has(post.id)
  if (isLiked) {
    likedPosts.value.delete(post.id)
    if (post.forum_votes?.[0]) post.forum_votes[0].count = Math.max(0, (post.forum_votes[0].count || 1) - 1)
    await supabase.from('forum_votes').delete()
      .eq('post_id', post.id).eq('user_id', currentUser.value.id).is('comment_id', null)
  } else {
    likedPosts.value.add(post.id)
    if (!post.forum_votes) post.forum_votes = [{ count: 0 }]
    post.forum_votes[0].count = (post.forum_votes[0].count || 0) + 1
    await supabase.from('forum_votes').insert({ post_id: post.id, user_id: currentUser.value.id })
  }
  pendingLikes.value.delete('p' + post.id)
}

async function voteComment(comment) {
  if (!currentUser.value || pendingLikes.value.has('c' + comment.id)) return
  pendingLikes.value.add('c' + comment.id)
  const isLiked = likedComments.value.has(comment.id)
  if (isLiked) {
    likedComments.value.delete(comment.id)
    if (comment.forum_votes?.[0]) comment.forum_votes[0].count = Math.max(0, (comment.forum_votes[0].count || 1) - 1)
    await supabase.from('forum_votes').delete()
      .eq('comment_id', comment.id).eq('user_id', currentUser.value.id)
  } else {
    likedComments.value.add(comment.id)
    if (!comment.forum_votes) comment.forum_votes = [{ count: 0 }]
    comment.forum_votes[0].count = (comment.forum_votes[0].count || 0) + 1
    await supabase.from('forum_votes').insert({ comment_id: comment.id, user_id: currentUser.value.id })
  }
  pendingLikes.value.delete('c' + comment.id)
}

// ── SEND COMMENT ──────────────────────────────────────────────
async function sendComment() {
  const content = newComment.value.trim()
  if (!content || !currentUser.value || sendingComment.value) return

  const mod = await checkModeration(content, currentProfile.value)
  if (mod.blocked) {
    alert(mod.reason)
    if (mod.banned) router.push('/auth')
    else {
      newComment.value = ''
      const { data } = await supabase.from('profiles').select('warnings_count, is_banned').eq('id', currentUser.value.id).maybeSingle()
      if (data) Object.assign(currentProfile.value, data)
    }
    return
  }

  sendingComment.value = true
  const { data, error } = await supabase.from('forum_comments').insert({
    post_id: activePost.value.id,
    user_id: currentUser.value.id,
    content,
    parent_id: replyTo.value?.id || null,
  }).select('id, content, created_at, user_id, parent_id, profiles(id, username, avatar_url, username_color, is_premium, is_official), forum_votes(count)').single()
  if (!error && data) {
    if (!postComments.value.find(c => c.id === data.id)) postComments.value.push(data)
    // Update comment count on active post
    if (activePost.value.forum_comments?.[0]) {
      activePost.value.forum_comments[0].count = (activePost.value.forum_comments[0].count || 0) + 1
    }

    // Anti-spam check
    const spam = await recordAndCheckSpam(currentProfile.value, data.id, 'forum_comments', content)
    if (spam.blocked) {
      alert(spam.reason)
      if (spam.banned) router.push('/auth')
      else {
        const { data: p } = await supabase.from('profiles').select('warnings_count, is_banned').eq('id', currentUser.value.id).maybeSingle()
        if (p) Object.assign(currentProfile.value, p)
      }
    }
  }
  newComment.value = ''
  replyTo.value = null
  sendingComment.value = false
}

// ── DELETE ────────────────────────────────────────────────────
async function deletePost(post) {
  if (!confirm('Delete this post?')) return
  await supabase.from('forum_votes').delete().eq('post_id', post.id)
  await supabase.from('forum_comments').delete().eq('post_id', post.id)
  await supabase.from('forum_posts').delete().eq('id', post.id)
  posts.value = posts.value.filter(p => p.id !== post.id)
  if (view.value === 'post') backToList()
}

async function deleteComment(comment) {
  if (!confirm('Delete this comment?')) return
  await supabase.from('forum_votes').delete().eq('comment_id', comment.id)
  await supabase.from('forum_comments').delete().eq('id', comment.id)
  postComments.value = postComments.value.filter(c => c.id !== comment.id)
}

// ── CREATE POST ───────────────────────────────────────────────
async function createPost() {
  if (!newTitle.value.trim() || !currentUser.value) return

  const modTitle = await checkModeration(newTitle.value.trim(), currentProfile.value)
  if (modTitle.blocked) {
    alert(modTitle.reason)
    if (modTitle.banned) router.push('/auth')
    else {
      newTitle.value = ''
      const { data } = await supabase.from('profiles').select('warnings_count, is_banned').eq('id', currentUser.value.id).maybeSingle()
      if (data) Object.assign(currentProfile.value, data)
    }
    return
  }
  const modContent = await checkModeration(newContent.value.trim(), currentProfile.value)
  if (modContent.blocked) {
    alert(modContent.reason)
    if (modContent.banned) router.push('/auth')
    else {
      newContent.value = ''
      const { data } = await supabase.from('profiles').select('warnings_count, is_banned').eq('id', currentUser.value.id).maybeSingle()
      if (data) Object.assign(currentProfile.value, data)
    }
    return
  }

  creating.value = true
  let imageUrl = null
  if (newImageFile.value) {
    const fn = `forum/${currentUser.value.id}_${Date.now()}`
    const { error: upErr } = await supabase.storage.from('media').upload(fn, newImageFile.value)
    if (!upErr) {
      const { data: { publicUrl } } = supabase.storage.from('media').getPublicUrl(fn)
      imageUrl = publicUrl
    }
  }
  const { data, error } = await supabase.from('forum_posts').insert({
    user_id: currentUser.value.id,
    title: newTitle.value.trim(),
    content: newContent.value.trim() || null,
    category: newCategory.value,
    image_url: imageUrl,
  }).select('id, title, content, category, image_url, created_at, user_id, profiles(id, username, avatar_url, username_color, is_premium, is_official), forum_votes(count), forum_comments(count)').single()

  if (!error && data) {
    posts.value.unshift(data)
    
    // Anti-spam check
    const spam = await recordAndCheckSpam(currentProfile.value, data.id, 'forum_posts', newTitle.value + ' ' + (newContent.value || ''))
    if (spam.blocked) {
      alert(spam.reason)
      if (spam.banned) router.push('/auth')
      else {
        const { data: p } = await supabase.from('profiles').select('warnings_count, is_banned').eq('id', currentUser.value.id).maybeSingle()
        if (p) Object.assign(currentProfile.value, p)
      }
    }

    newTitle.value = ''; newContent.value = ''; newImageFile.value = null; newImagePreview.value = null
    showCreate.value = false
    openPost(data)
  }
  creating.value = false
}

function handleImageFile(e) {
  const f = e.target.files[0]; if (!f) return
  newImageFile.value = f
  newImagePreview.value = URL.createObjectURL(f)
}

// ── TREE COMMENTS ─────────────────────────────────────────────
const topLevelComments = computed(() =>
  postComments.value.filter(c => !c.parent_id)
)
function getReplies(parentId) {
  return postComments.value.filter(c => c.parent_id === parentId)
}

// ── UTILS ─────────────────────────────────────────────────────
function getCatInfo(id) {
  return categories.value.find(c => c.id === id) || { label: id, color: '#888', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>' }
}
function fmtTime(ts) {
  const diff = Date.now() - new Date(ts)
  const m = Math.floor(diff / 60000)
  if (m < 1) return "à l'instant"
  if (m < 60) return `il y a ${m}min`
  const h = Math.floor(m / 60)
  if (h < 24) return `il y a ${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `il y a ${d}j`
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

const isAdmin = computed(() => currentProfile.value?.is_admin)
</script>

<template>
  <div class="forum-page">

    <!-- ── LIST VIEW ── -->
    <template v-if="view === 'list'">
      <!-- Header -->
      <div class="forum-header">
        <div class="fh-left">
          <div class="fh-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="9" y1="10" x2="15" y2="10"/><line x1="9" y1="14" x2="13" y2="14"/></svg>
          </div>
          <div>
            <h1 class="fh-title">Forum</h1>
            <p class="fh-sub">{{ posts.length }} discussions</p>
          </div>
        </div>
        <button v-if="currentUser" class="btn-create" @click="showCreate = !showCreate">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New post
        </button>
      </div>

      <!-- Create form -->
      <Transition name="slide-down">
        <div v-if="showCreate" class="create-card">
          <h3 class="create-title">Create a post</h3>
          <input v-model="newTitle" placeholder="Titre *" class="create-input" maxlength="200" />
          <textarea v-model="newContent" placeholder="Contenu (optionnel)…" rows="4" class="create-textarea"></textarea>
          <div class="create-row">
            <select v-model="newCategory" class="create-select">
              <option v-for="cat in categories" :key="cat.id" :value="cat.id">{{ cat.label }}</option>
            </select>
            <label class="create-img-label">
              <input type="file" accept="image/*" @change="handleImageFile" hidden />
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
              Image
            </label>
            <img v-if="newImagePreview" :src="newImagePreview" class="create-img-preview" />
          </div>
          <div class="create-actions">
            <button class="btn-ghost" @click="showCreate = false">Cancel</button>
            <button class="btn-purple" @click="createPost" :disabled="!newTitle.trim() || creating">
              <span v-if="creating" class="mini-spin"></span>
              Publish
            </button>
          </div>
        </div>
      </Transition>

      <!-- Filters -->
      <div class="filters-row">
        <div class="cat-pills">
          <button class="cat-pill" :class="{ active: !activeCategory }" @click="activeCategory = null; loadPosts()">
            Tout
          </button>
          <button
            v-for="cat in categories" :key="cat.id"
            class="cat-pill"
            :class="{ active: activeCategory === cat.id }"
            :style="activeCategory === cat.id ? { background: cat.color, color: 'white', borderColor: cat.color } : {}"
            @click="activeCategory = cat.id; loadPosts()"
          >
            <span class="cat-pill-icon" v-html="cat.icon"></span>
            {{ cat.label }}
          </button>
        </div>
        <div class="sort-tabs">
          <button class="sort-tab" :class="{ active: sortBy === 'hot' }" @click="sortBy = 'hot'">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;margin-right:4px"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.5 4 6.5 2 2 3 5.5 3 8.5a7 7 0 1 1-14 0c0-1.15.3-2.35.9-3.5 1.1 2.6 1.1 2.1 2.6 3.5z"/></svg>
            Populaire
          </button>
          <button class="sort-tab" :class="{ active: sortBy === 'new' }" @click="sortBy = 'new'">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;margin-right:4px"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            Récent
          </button>
          <button class="sort-tab" :class="{ active: sortBy === 'top' }" @click="sortBy = 'top'">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;margin-right:4px"><polyline points="17 11 12 6 7 11"/><polyline points="17 18 12 13 7 18"/></svg>
            Top
          </button>
        </div>
      </div>

      <!-- Search -->
      <div class="search-row">
        <div class="search-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input v-model="searchQ" placeholder="Search the forum…" />
        </div>
      </div>

      <!-- Loading -->
      <div v-if="loadingPosts" class="center-spinner"><div class="spinner"></div></div>

      <!-- Posts list -->
      <div v-else class="posts-list">
        <div v-if="!filteredPosts.length" class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" style="width:48px;height:48px;opacity:.2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <p>No posts yet</p>
          <button v-if="currentUser" class="btn-purple" style="margin-top:10px" @click="showCreate = true">Create the first post</button>
        </div>

        <div v-for="post in filteredPosts" :key="post.id" class="post-row" @click="openPost(post)">
          <!-- Vote column -->
          <div class="post-vote-col">
            <button class="vote-btn" :class="{ voted: likedPosts.has(post.id) }" @click.stop="votePost(post)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"/></svg>
            </button>
            <span class="vote-count">{{ post.forum_votes?.[0]?.count || 0 }}</span>
          </div>

          <!-- Content -->
          <div class="post-content-col">
            <div class="post-meta-row">
              <span class="cat-tag" :style="{ background: getCatInfo(post.category).color + '22', color: getCatInfo(post.category).color }">
                <span class="cat-tag-icon" v-html="getCatInfo(post.category).icon"></span>
                {{ getCatInfo(post.category).label }}
              </span>
              <div class="post-author">
                <div class="author-av">
                  <img v-if="post.profiles?.avatar_url" :src="post.profiles.avatar_url" />
                  <span v-else>{{ post.profiles?.username?.charAt(0)?.toUpperCase() }}</span>
                </div>
                <span class="author-name" :style="post.profiles?.username_color ? { color: post.profiles.username_color } : {}" @click.stop="goToProfile(post.user_id)" style="cursor:pointer">
                  @{{ post.profiles?.username }}
                </span>
                <span class="post-time">· {{ fmtTime(post.created_at) }}</span>
              </div>
            </div>
            <h2 class="post-title">{{ post.title }}</h2>
            <p v-if="post.content" class="post-excerpt">{{ post.content.slice(0, 160) }}{{ post.content.length > 160 ? '…' : '' }}</p>
            <img v-if="post.image_url" :src="post.image_url" class="post-thumb" loading="lazy" />
            <div class="post-stats">
              <span class="post-stat">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                {{ post.forum_comments?.[0]?.count || 0 }} commentaires
              </span>
            </div>
          </div>

          <!-- Actions (owner / admin) -->
          <button
            v-if="post.user_id === currentUser?.id || isAdmin"
            class="post-del-btn"
            @click.stop="deletePost(post)"
            title="Delete"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
          </button>
        </div>
      </div>
    </template>

    <!-- ── POST DETAIL VIEW ── -->
    <template v-else-if="view === 'post' && activePost">
      <!-- Back bar -->
      <div class="post-topbar">
        <button class="back-btn" @click="backToList">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
          Retour au forum
        </button>
        <span class="cat-tag" :style="{ background: getCatInfo(activePost.category).color + '22', color: getCatInfo(activePost.category).color }">
          <span class="cat-tag-icon" v-html="getCatInfo(activePost.category).icon"></span>
          {{ getCatInfo(activePost.category).label }}
        </span>
      </div>

      <!-- Post detail -->
      <div class="post-detail">
        <div class="pd-vote">
          <button class="vote-btn lg" :class="{ voted: likedPosts.has(activePost.id) }" @click="votePost(activePost)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"/></svg>
          </button>
          <span class="vote-count lg">{{ activePost.forum_votes?.[0]?.count || 0 }}</span>
        </div>
        <div class="pd-body">
          <h1 class="pd-title">{{ activePost.title }}</h1>
          <div class="pd-author-row">
            <div class="author-av">
              <img v-if="activePost.profiles?.avatar_url" :src="activePost.profiles.avatar_url" />
              <span v-else>{{ activePost.profiles?.username?.charAt(0) }}</span>
            </div>
            <span class="author-name" :style="activePost.profiles?.username_color ? { color: activePost.profiles.username_color } : {}" @click="goToProfile(activePost.user_id)" style="cursor:pointer">
              @{{ activePost.profiles?.username }}
            </span>
            <span class="post-time">· {{ fmtTime(activePost.created_at) }}</span>
            <button
              v-if="activePost.user_id === currentUser?.id || isAdmin"
              class="del-sm" @click="deletePost(activePost)"
            >Delete</button>
          </div>
          <p v-if="activePost.content" class="pd-content">{{ activePost.content }}</p>
          <img v-if="activePost.image_url" :src="activePost.image_url" class="pd-image" loading="lazy" />
        </div>
      </div>

      <!-- Comment input -->
      <div v-if="currentUser" class="comment-form">
        <div class="comment-form-av">
          <img v-if="currentProfile?.avatar_url" :src="currentProfile.avatar_url" />
          <span v-else>{{ currentProfile?.username?.charAt(0) }}</span>
        </div>
        <div class="comment-form-body">
          <div v-if="replyTo" class="reply-to-badge">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>
            Reply to @{{ replyTo.username }}
            <button @click="replyTo = null">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:14px;height:14px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <textarea
            v-model="newComment"
            :placeholder="replyTo ? `Reply to @${replyTo.username}…` : 'Write a comment…'"
            rows="3"
            class="comment-input"
            @keydown.ctrl.enter="sendComment"
          ></textarea>
          <div class="comment-form-foot">
            <span class="hint-text">Ctrl+Entrée pour envoyer</span>
            <button class="btn-purple" @click="sendComment" :disabled="!newComment.trim() || sendingComment">
              <span v-if="sendingComment" class="mini-spin"></span>
              Commenter
            </button>
          </div>
        </div>
      </div>

      <!-- Comments -->
      <div class="comments-section">
        <h3 class="comments-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          {{ postComments.length }} commentaire{{ postComments.length > 1 ? 's' : '' }}
        </h3>

        <div v-if="loadingComments" class="center-spinner"><div class="spinner"></div></div>

        <template v-else>
          <div v-if="!topLevelComments.length" class="empty-comments">
            <p>No comments yet — be the first!</p>
          </div>
          <!-- Recursive-style tree (2 levels) -->
          <div v-for="comment in topLevelComments" :key="comment.id" class="comment-thread">
            <div class="comment-card">
              <div class="cc-vote">
                <button class="vote-btn sm" :class="{ voted: likedComments.has(comment.id) }" @click="voteComment(comment)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"/></svg>
                </button>
                <span class="vote-count sm">{{ comment.forum_votes?.[0]?.count || 0 }}</span>
              </div>
              <div class="cc-body">
                <div class="cc-meta">
                  <div class="author-av xs">
                    <img v-if="comment.profiles?.avatar_url" :src="comment.profiles.avatar_url" />
                    <span v-else>{{ comment.profiles?.username?.charAt(0) }}</span>
                  </div>
                  <span class="author-name sm" :style="comment.profiles?.username_color ? { color: comment.profiles.username_color } : {}">
                    @{{ comment.profiles?.username }}
                  </span>
                  <span class="post-time">{{ fmtTime(comment.created_at) }}</span>
                </div>
                <p class="cc-content">{{ comment.content }}</p>
                <div class="cc-actions">
                  <button class="cc-action-btn" @click="replyTo = { id: comment.id, username: comment.profiles?.username }; newComment = ''">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>
                    Reply
                  </button>
                  <button
                    v-if="comment.user_id === currentUser?.id || isAdmin"
                    class="cc-action-btn danger"
                    @click="deleteComment(comment)"
                  >Delete</button>
                </div>
              </div>
            </div>
            <!-- Replies -->
            <div v-if="getReplies(comment.id).length" class="replies-list">
              <div v-for="reply in getReplies(comment.id)" :key="reply.id" class="comment-card reply">
                <div class="cc-vote">
                  <button class="vote-btn sm" :class="{ voted: likedComments.has(reply.id) }" @click="voteComment(reply)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"/></svg>
                  </button>
                  <span class="vote-count sm">{{ reply.forum_votes?.[0]?.count || 0 }}</span>
                </div>
                <div class="cc-body">
                  <div class="cc-meta">
                    <div class="author-av xs">
                      <img v-if="reply.profiles?.avatar_url" :src="reply.profiles.avatar_url" />
                      <span v-else>{{ reply.profiles?.username?.charAt(0) }}</span>
                    </div>
                    <span class="author-name sm" :style="reply.profiles?.username_color ? { color: reply.profiles.username_color } : {}">
                      @{{ reply.profiles?.username }}
                    </span>
                    <span class="post-time">{{ fmtTime(reply.created_at) }}</span>
                  </div>
                  <p class="cc-content">{{ reply.content }}</p>
                  <div class="cc-actions">
                    <button
                      v-if="reply.user_id === currentUser?.id || isAdmin"
                      class="cc-action-btn danger"
                      @click="deleteComment(reply)"
                    >Delete</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </template>

  </div>
</template>

<style scoped>
.forum-page { min-height: 100%; background: #faf9ff; padding: 0 0 48px; }

/* Header */
.forum-header { display:flex; align-items:center; justify-content:space-between; padding:20px 28px 16px; background:white; border-bottom:1px solid #ede8ff; flex-shrink:0; }
.fh-left { display:flex; align-items:center; gap:12px; }
.fh-icon { width:42px; height:42px; border-radius:12px; background:linear-gradient(135deg,#4C10E0,#7c3aed); display:flex; align-items:center; justify-content:center; color:white; }
.fh-icon svg { width:20px; height:20px; }
.fh-title { font-family:'Epilogue',sans-serif; font-size:1.1rem; font-weight:800; color:var(--text); }
.fh-sub { font-size:.75rem; color:var(--text-2); margin-top:1px; }
.btn-create { display:flex; align-items:center; gap:6px; padding:9px 18px; background:var(--purple); color:white; border:none; border-radius:10px; font-weight:700; font-size:.85rem; cursor:pointer; transition:all .18s; }
.btn-create svg { width:14px; height:14px; }
.btn-create:hover { background:var(--purple-d); }

/* Create card */
.create-card { margin:16px 28px; background:white; border-radius:16px; padding:20px; box-shadow:0 4px 24px rgba(76,16,224,.1); border:1.5px solid #e2d9ff; }
.create-title { font-family:'Epilogue',sans-serif; font-weight:800; font-size:.95rem; color:var(--text); margin-bottom:12px; }
.create-input { width:100%; padding:10px 14px; border:1.5px solid #e2d9ff; border-radius:10px; font-size:.92rem; font-family:'Instrument Sans',sans-serif; outline:none; margin-bottom:8px; transition:border-color .18s; }
.create-input:focus { border-color:var(--purple); }
.create-textarea { width:100%; padding:10px 14px; border:1.5px solid #e2d9ff; border-radius:10px; font-size:.87rem; font-family:'Instrument Sans',sans-serif; outline:none; resize:vertical; margin-bottom:8px; transition:border-color .18s; }
.create-textarea:focus { border-color:var(--purple); }
.create-row { display:flex; align-items:center; gap:10px; margin-bottom:12px; flex-wrap:wrap; }
.create-select { padding:8px 12px; border:1.5px solid #e2d9ff; border-radius:9px; font-size:.85rem; font-family:'Instrument Sans',sans-serif; outline:none; background:white; }
.create-img-label { display:inline-flex; align-items:center; gap:5px; padding:7px 13px; border:1.5px solid #e2d9ff; border-radius:9px; font-size:.82rem; font-weight:600; color:var(--text-2); cursor:pointer; transition:all .15s; }
.create-img-label:hover { border-color:var(--purple); color:var(--purple); }
.create-img-label svg { width:14px; height:14px; }
.create-img-preview { width:48px; height:48px; border-radius:8px; object-fit:cover; }
.create-actions { display:flex; gap:8px; justify-content:flex-end; }
.btn-ghost { padding:8px 16px; background:none; border:1.5px solid #e2d9ff; border-radius:9px; font-family:'Instrument Sans',sans-serif; font-size:.84rem; font-weight:600; cursor:pointer; color:var(--text-2); }
.btn-ghost:hover { border-color:var(--purple); color:var(--purple); }
.btn-purple { padding:9px 20px; background:var(--purple); color:white; border:none; border-radius:9px; font-weight:700; font-size:.85rem; cursor:pointer; display:inline-flex; align-items:center; gap:6px; transition:background .18s; }
.btn-purple:hover:not(:disabled) { background:var(--purple-d); }
.btn-purple:disabled { opacity:.4; cursor:not-allowed; }

/* Filters */
.filters-row { display:flex; align-items:center; justify-content:space-between; padding:12px 28px; background:white; border-bottom:1px solid #f0ecff; gap:12px; flex-wrap:wrap; }
.cat-pills { display:flex; gap:6px; flex-wrap:wrap; }
.cat-pill { padding:5px 12px; border:1.5px solid #e2d9ff; border-radius:20px; font-size:.78rem; font-weight:600; cursor:pointer; background:white; color:var(--text-2); transition:all .15s; white-space:nowrap; }
.cat-pill:hover { border-color:var(--purple); color:var(--purple); }
.cat-pill.active { background:var(--purple); color:white; border-color:var(--purple); }
.sort-tabs { display:flex; gap:4px; background:#f0eeff; padding:3px; border-radius:10px; }
.sort-tab { padding:5px 12px; border:none; border-radius:8px; font-size:.78rem; font-weight:600; cursor:pointer; background:transparent; color:var(--text-2); transition:all .15s; white-space:nowrap; }
.sort-tab.active { background:white; color:var(--purple); box-shadow:0 1px 4px rgba(76,16,224,.12); }

.search-row { padding:10px 28px; }
.search-box { display:flex; align-items:center; gap:8px; padding:9px 14px; border:1.5px solid #e2d9ff; border-radius:12px; background:white; }
.search-box svg { width:15px; height:15px; color:var(--text-2); flex-shrink:0; }
.search-box input { border:none; outline:none; font-size:.87rem; font-family:'Instrument Sans',sans-serif; flex:1; color:var(--text); }

/* Posts list */
.posts-list { display:flex; flex-direction:column; gap:6px; padding:10px 28px; }
.empty-state { text-align:center; padding:60px 20px; color:var(--text-2); display:flex; flex-direction:column; align-items:center; gap:10px; font-size:.87rem; }

.post-row { display:flex; align-items:flex-start; gap:12px; background:white; border-radius:14px; padding:16px; box-shadow:0 1px 6px rgba(76,16,224,.06); cursor:pointer; transition:all .18s; position:relative; border:1.5px solid transparent; }
.post-row:hover { border-color:#e2d9ff; box-shadow:0 4px 16px rgba(76,16,224,.1); transform:translateY(-1px); }

.cat-pill {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 16px; border-radius: 20px;
  background: white; border: 1px solid var(--divider);
  font-size: 0.88rem; font-weight: 600; color: var(--text-2);
  white-space: nowrap; transition: all .2s;
}
.cat-pill-icon svg { width: 14px; height: 14px; display: block; }
.cat-pill:hover { border-color: var(--purple); color: var(--purple); background: #f8f6ff; }
.cat-pill.active { border-color: transparent !important; }

.cat-tag {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 10px; border-radius: 12px; font-size: 0.72rem; font-weight: 700;
}
.cat-tag-icon svg { width: 12px; height: 12px; display: block; }

/* Vote column */
.post-vote-col { display:flex; flex-direction:column; align-items:center; gap:3px; flex-shrink:0; width:36px; }
.vote-btn { width:32px; height:32px; border-radius:8px; border:none; background:#f0eeff; color:var(--purple); cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all .18s; }
.vote-btn:hover { background:#e2d5ff; }
.vote-btn.voted { background:var(--purple); color:white; }
.vote-btn svg { width:14px; height:14px; }
.vote-btn.lg { width:38px; height:38px; }
.vote-btn.sm { width:26px; height:26px; }
.vote-btn.lg svg { width:16px; height:16px; }
.vote-btn.sm svg { width:11px; height:11px; }
.vote-count { font-weight:800; font-size:.82rem; color:var(--text); }
.vote-count.lg { font-size:1rem; }
.vote-count.sm { font-size:.72rem; }

/* Post content */
.post-content-col { flex:1; min-width:0; }
.post-meta-row { display:flex; align-items:center; gap:10px; margin-bottom:6px; flex-wrap:wrap; }
.cat-tag { padding:3px 10px; border-radius:20px; font-size:.72rem; font-weight:700; flex-shrink:0; }
.post-author { display:flex; align-items:center; gap:5px; }
.author-av { width:20px; height:20px; border-radius:50%; background:var(--purple); color:white; font-size:.6rem; font-weight:700; display:flex; align-items:center; justify-content:center; overflow:hidden; flex-shrink:0; }
.author-av img { width:100%; height:100%; object-fit:cover; }
.author-av.xs { width:22px; height:22px; }
.author-name { font-size:.78rem; font-weight:700; color:var(--purple); }
.author-name.sm { font-size:.76rem; }
.post-time { font-size:.72rem; color:var(--text-2); }
.post-title { font-family:'Epilogue',sans-serif; font-size:1rem; font-weight:800; color:var(--text); margin-bottom:5px; line-height:1.3; }
.post-excerpt { font-size:.84rem; color:var(--text-2); line-height:1.5; margin-bottom:8px; }
.post-thumb { max-height:200px; width:100%; object-fit:cover; border-radius:10px; margin:8px 0; }
.post-stats { display:flex; gap:14px; }
.post-stat { display:flex; align-items:center; gap:4px; font-size:.74rem; color:var(--text-2); font-weight:600; }
.post-stat svg { width:13px; height:13px; }
.post-del-btn { position:absolute; top:10px; right:10px; width:28px; height:28px; border-radius:7px; background:#fff0f0; border:none; color:#e74c3c; cursor:pointer; display:flex; align-items:center; justify-content:center; opacity:0; transition:opacity .15s; }
.post-row:hover .post-del-btn { opacity:1; }
.post-del-btn svg { width:12px; height:12px; }

/* Post detail */
.post-topbar { display:flex; align-items:center; gap:12px; padding:14px 28px; background:white; border-bottom:1px solid #ede8ff; flex-shrink:0; }
.back-btn { display:flex; align-items:center; gap:5px; padding:7px 14px; background:#f0eeff; border:none; border-radius:9px; font-size:.84rem; font-weight:600; color:var(--purple); cursor:pointer; transition:all .18s; }
.back-btn:hover { background:#e2d5ff; }
.back-btn svg { width:14px; height:14px; }

.post-detail { display:flex; gap:14px; background:white; padding:24px 28px; border-bottom:1px solid #f0ecff; }
.pd-vote { display:flex; flex-direction:column; align-items:center; gap:4px; flex-shrink:0; }
.pd-body { flex:1; }
.pd-title { font-family:'Epilogue',sans-serif; font-size:1.3rem; font-weight:800; color:var(--text); margin-bottom:10px; line-height:1.3; }
.pd-author-row { display:flex; align-items:center; gap:7px; margin-bottom:14px; flex-wrap:wrap; }
.pd-content { font-size:.92rem; color:var(--text); line-height:1.65; white-space:pre-wrap; }
.pd-image { max-width:100%; border-radius:12px; margin-top:14px; }
.del-sm { margin-left:auto; padding:4px 10px; background:#fff0f0; color:#e74c3c; border:none; border-radius:6px; font-size:.75rem; cursor:pointer; }

/* Comment form */
.comment-form { display:flex; gap:12px; padding:16px 28px; background:white; border-bottom:1px solid #f0ecff; }
.comment-form-av { width:36px; height:36px; border-radius:50%; background:var(--purple); color:white; font-size:.85rem; font-weight:700; display:flex; align-items:center; justify-content:center; overflow:hidden; flex-shrink:0; margin-top:2px; }
.comment-form-av img { width:100%; height:100%; object-fit:cover; }
.comment-form-body { flex:1; display:flex; flex-direction:column; gap:8px; }
.reply-to-badge { display:flex; align-items:center; gap:6px; padding:5px 10px; background:#f0eeff; border-radius:7px; font-size:.78rem; color:var(--purple); font-weight:600; }
.reply-to-badge svg { width:12px; height:12px; }
.reply-to-badge button { margin-left:auto; background:none; border:none; cursor:pointer; color:var(--text-2); font-size:.8rem; }
.comment-input { width:100%; padding:10px 14px; border:1.5px solid #e2d9ff; border-radius:12px; font-size:.87rem; font-family:'Instrument Sans',sans-serif; outline:none; resize:vertical; transition:border-color .18s; }
.comment-input:focus { border-color:var(--purple); }
.comment-form-foot { display:flex; align-items:center; justify-content:space-between; }
.hint-text { font-size:.73rem; color:var(--text-2); }

/* Comments */
.comments-section { padding:20px 28px; }
.comments-title { display:flex; align-items:center; gap:7px; font-family:'Epilogue',sans-serif; font-size:.95rem; font-weight:800; color:var(--text); margin-bottom:16px; }
.comments-title svg { width:17px; height:17px; color:var(--purple); }
.empty-comments { text-align:center; color:var(--text-2); font-size:.85rem; padding:24px 0; }
.center-spinner { display:flex; justify-content:center; padding:40px; }

.comment-thread { margin-bottom:10px; }
.replies-list { margin-left:36px; margin-top:6px; display:flex; flex-direction:column; gap:6px; border-left:2px solid #e8e0ff; padding-left:12px; }

.comment-card { display:flex; gap:10px; background:white; border-radius:12px; padding:12px 14px; box-shadow:0 1px 5px rgba(76,16,224,.06); }
.comment-card.reply { background:#faf8ff; box-shadow:none; border:1px solid #f0ecff; }
.cc-vote { display:flex; flex-direction:column; align-items:center; gap:2px; flex-shrink:0; }
.cc-body { flex:1; min-width:0; }
.cc-meta { display:flex; align-items:center; gap:5px; margin-bottom:5px; flex-wrap:wrap; }
.cc-content { font-size:.87rem; color:var(--text); line-height:1.5; white-space:pre-wrap; word-break:break-word; }
.cc-actions { display:flex; gap:10px; margin-top:6px; }
.cc-action-btn { background:none; border:none; font-size:.75rem; font-weight:600; color:var(--text-2); cursor:pointer; padding:2px 0; display:flex; align-items:center; gap:3px; transition:color .15s; }
.cc-action-btn:hover { color:var(--purple); }
.cc-action-btn svg { width:11px; height:11px; }
.cc-action-btn.danger:hover { color:#e74c3c; }

/* Transitions */
.slide-down-enter-active, .slide-down-leave-active { transition: all .25s ease; max-height:600px; overflow:hidden; }
.slide-down-enter-from, .slide-down-leave-to { opacity:0; max-height:0; padding-top:0; padding-bottom:0; }

/* Misc */
.spinner { width:28px; height:28px; border:3px solid #e2d9ff; border-top-color:var(--purple); border-radius:50%; animation:spin .7s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
.mini-spin { width:12px; height:12px; border:2px solid rgba(255,255,255,.4); border-top-color:white; border-radius:50%; animation:spin .6s linear infinite; display:inline-block; }

@media (max-width: 680px) {
  .forum-header, .filters-row, .search-row, .posts-list, .post-detail, .comment-form, .comments-section, .post-topbar { padding-left:14px; padding-right:14px; }
  .create-card { margin-left:14px; margin-right:14px; }
  .filters-row { flex-direction:column; align-items:flex-start; }
}
</style>
