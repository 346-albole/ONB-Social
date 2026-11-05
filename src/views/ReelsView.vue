<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { supabase } from '../lib/supabaseClient'
import { getCurrentSession } from '../lib/authStore'
import { withTimeout, makeSafeLoader } from '../lib/withTimeout'

const reels        = ref([])
const originalReels= ref([])
const loading      = ref(true)
const currentUser  = ref(null)
const likedPosts   = ref(new Set())
const commentText  = ref({})
const showComments = ref({})
const activeIdx    = ref(0)
const uploading    = ref(false)
const videoRefs    = ref([])
const mutedMap     = ref({})
const viewedReels  = new Set()

function formatCount(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M'
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k'
  return num
}

const _safeLoad = makeSafeLoader(loading)
async function fetchReels() {
  await _safeLoad(async () => {
    const { data } = await withTimeout(
      supabase
        .from('posts')
        .select('*, profiles(id, username, avatar_url, is_official, is_premium, username_color, custom_badge_url, is_anonymous), likes(id, user_id), comments(id, content, profiles(username))')
        .or('media_url.ilike.%.mp4,media_url.ilike.%.webm,media_url.ilike.%.mov,media_url.ilike.%.m4v')
        .order('created_at', { ascending: false })
        .limit(30),
      10000
    )
    if (data) {
      originalReels.value = data
      reels.value = [...data]
      // Si la liste est petite (< 5), on la duplique immédiatement pour amorcer la boucle
      if (data.length > 0 && data.length < 5) {
        reels.value = [...data, ...data, ...data, ...data, ...data]
      }
      if (currentUser.value) {
        const liked = new Set()
        data.forEach(p => { if (p.likes?.some(l => l.user_id === currentUser.value.id)) liked.add(p.id) })
        likedPosts.value = liked
      }
      data.forEach(p => { mutedMap.value[p.id] = true })
    }
  })
}

async function toggleLike(postId) {
  if (!currentUser.value) return
  const isLiked = likedPosts.value.has(postId)
  const postsToUpdate = reels.value.filter(p => p.id === postId)
  
  if (isLiked) {
    likedPosts.value.delete(postId)
    postsToUpdate.forEach(p => {
      p.likes = (p.likes || []).filter(l => l.user_id !== currentUser.value.id)
    })
    await supabase.from('likes').delete().match({ user_id: currentUser.value.id, post_id: postId })
  } else {
    likedPosts.value.add(postId)
    postsToUpdate.forEach(p => {
      p.likes = [...(p.likes || []), { user_id: currentUser.value.id }]
    })
    await supabase.from('likes').insert({ user_id: currentUser.value.id, post_id: postId })
  }
}

async function sendComment(postId) {
  const content = commentText.value[postId]?.trim()
  if (!content || !currentUser.value) return
  const { data: c } = await supabase
    .from('comments').insert({ user_id: currentUser.value.id, post_id: postId, content })
    .select('id, content, profiles(username)').single()
  
  const postsToUpdate = reels.value.filter(p => p.id === postId)
  if (postsToUpdate.length && c) {
    postsToUpdate.forEach(p => {
      p.comments = [...(p.comments || []), c]
    })
  }
  commentText.value[postId] = ''
}

async function uploadReel(e) {
  const file = e.target.files[0]
  if (!file || !currentUser.value) return
  if (!file.type.startsWith('video/')) { alert('Reels n\'accepte que des vidéos.'); return }
  if (file.size > 50 * 1024 * 1024) { alert('La vidéo est trop volumineuse (limite: 50 Mo).'); return }
  uploading.value = true
  try {
    const ext = file.name.split('.').pop()
    const fileName = `${currentUser.value.id}/reel_${Date.now()}.${ext}`
    
    // Timeout de 2 minutes pour éviter que ça ne charge à l'infini en cas de micro-coupure
    const { error: upErr } = await withTimeout(
      supabase.storage.from('media').upload(fileName, file),
      120000
    )
    if (upErr) throw upErr

    const { data: { publicUrl } } = supabase.storage.from('media').getPublicUrl(fileName)
    const { error: insertErr } = await supabase.from('posts').insert([{ user_id: currentUser.value.id, media_url: publicUrl, caption: '' }])
    if (insertErr) throw insertErr
    e.target.value = ''
    fetchReels()
  } catch (err) {
    alert('Erreur: ' + (err.message || 'Le téléchargement a échoué (vidéo trop lourde ou connexion instable)'))
  } finally {
    uploading.value = false
  }
}

function setVideoRef(el, i) { if (el) videoRefs.value[i] = el }

function toggleMute(reelId) {
  mutedMap.value[reelId] = !mutedMap.value[reelId]
  reels.value.forEach((r, i) => {
    if (r.id === reelId && videoRefs.value[i]) {
      videoRefs.value[i].muted = mutedMap.value[reelId]
    }
  })
}

function togglePlayPause(i) {
  const v = videoRefs.value[i]
  if (!v) return
  v.paused ? v.play() : v.pause()
}

watch(activeIdx, (newIdx) => {
  videoRefs.value.forEach((v, i) => {
    if (!v) return
    if (i === newIdx) {
      v.currentTime = 0
      v.muted = mutedMap.value[reels.value[i]?.id] ?? true
      v.play().catch(() => {})
    } else { v.pause() }
  })
  
  
  // Record view for the new active reel
  const reel = reels.value[newIdx]
  if (reel) recordView(reel.id)
})

async function recordView(postId) {
  if (viewedReels.has(postId)) return
  viewedReels.add(postId)
  
  // Optimistic update locally
  const r = reels.value.find(x => x.id === postId)
  if (r) r.views = (Number(r.views) || 0) + 1

  try {
    await supabase.rpc('increment_post_views', { post_id: postId })
  } catch (e) {
    console.warn('recordView error:', e)
  }
}

let observer = null
function setupObserver() {
  observer = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting && e.intersectionRatio > 0.6)
        activeIdx.value = Number(e.target.dataset.idx)
    })
  }, { threshold: 0.6 })
}
function observeCard(el, idx) {
  if (el && observer) { el.dataset.idx = idx; observer.observe(el) }
}


function handleKeydown(e) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    scrollByDir(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    scrollByDir(-1)
  }
}

let keyboardTargetIdx = 0
let keyboardTimeout = null

function scrollByDir(dir) {
  const feed = document.querySelector('.reels-feed')
  if (!feed) return
  const items = feed.querySelectorAll('.reel-row')
  if (!items.length) return
  
  if (!keyboardTimeout) {
    keyboardTargetIdx = activeIdx.value
  }
  
  keyboardTargetIdx += dir
  if (keyboardTargetIdx < 0) keyboardTargetIdx = 0
  if (keyboardTargetIdx >= items.length) keyboardTargetIdx = items.length - 1
  
  feed.scrollTo({ top: items[keyboardTargetIdx].offsetTop, behavior: 'smooth' })
  
  clearTimeout(keyboardTimeout)
  keyboardTimeout = setTimeout(() => { keyboardTimeout = null }, 600)
}

onMounted(async () => {
  const session = getCurrentSession()
  currentUser.value = session?.user || null
  await fetchReels()
  setupObserver()
  window.addEventListener('keydown', handleKeydown)
})
onUnmounted(() => { 
  if (observer) observer.disconnect() 
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div class="reels-page">
    <div class="reels-header">
      <div class="header-left">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" class="reels-icon"><polygon points="5,3 19,12 5,21"/></svg>
        <h1>Reels</h1>
      </div>
      <label class="upload-btn" :class="{ uploading }">
        <input type="file" accept="video/*" @change="uploadReel" hidden :disabled="uploading" />
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
        {{ uploading ? 'Envoi…' : 'Ajouter' }}
      </label>
    </div>

    <div v-if="loading" class="main-loader"><div class="spinner"></div><p>Préparez-vous pour les Reels...</p></div>
    <div v-else-if="reels.length === 0" class="status-msg">
      <span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:40px;height:40px"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
      </span>
      <p>No reels yet.</p>
      <p class="hint">Uploadez une vidéo pour commencer !</p>
    </div>

    <div v-else class="reels-feed">
      <div v-for="(reel, i) in reels" :key="reel.id + '-' + i" class="reel-row" :ref="el => observeCard(el, i)">

        <!-- Portrait card -->
        <div class="reel-card">
          <div class="reel-video-wrap" @dblclick="toggleLike(reel.id)">
            <video
              :ref="el => setVideoRef(el, i)"
              :src="reel.media_url"
              loop playsinline preload="metadata"
              class="reel-video"
              :muted="mutedMap[reel.id] ?? true"
              @click="togglePlayPause(i)"
            ></video>
            <div class="reel-gradient"></div>

            <button class="mute-btn" @click.stop="toggleMute(reel.id)" :title="mutedMap[reel.id] ? 'Activer le son' : 'Couper le son'">
              <svg v-if="mutedMap[reel.id]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                <line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
              </svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
              </svg>
            </button>

            <div class="reel-meta">
              <div class="reel-author">
                <div class="reel-av">
                  <template v-if="reel.profiles?.is_anonymous">
                    <span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                    </span>
                  </template>
                  <template v-else>
                    <img v-if="reel.profiles?.avatar_url" :src="reel.profiles.avatar_url" />
                    <span v-else>{{ reel.profiles?.username?.charAt(0)?.toUpperCase() }}</span>
                  </template>
                </div>
                <span class="reel-username" :style="!reel.profiles?.is_anonymous && reel.profiles?.username_color ? { color: reel.profiles.username_color } : {}">
                  @{{ reel.profiles?.is_anonymous ? 'Anonyme' : (reel.profiles?.username || 'user') }}
                </span>
                <template v-if="!reel.profiles?.is_anonymous">
                  <span v-if="reel.profiles?.is_official" class="badge official">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"/></svg>
                  </span>
                  <span v-if="reel.profiles?.is_premium" class="badge premium">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                  </span>
                </template>
              </div>
              <p v-if="reel.caption" class="reel-caption">{{ reel.caption }}</p>
            </div>
          </div>

          <!-- Comments slide-up -->
          <transition name="slide-up">
            <div v-if="showComments[reel.id]" class="comments-panel">
              <div class="comments-head">
                <span>Commentaires</span>
                <button class="close-btn" @click="showComments[reel.id] = false">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
              <div class="comments-list">
                <div v-if="!reel.comments?.length" class="no-comments">No comments yet — be the first!</div>
                <div v-for="c in reel.comments" :key="c.id" class="comment-row">
                  <div class="c-av">{{ c.profiles?.username?.charAt(0)?.toUpperCase() }}</div>
                  <div class="c-body">
                    <strong>{{ c.profiles?.username }}</strong>
                    <span>{{ c.content }}</span>
                  </div>
                </div>
              </div>
              <div class="comment-input-row">
                <input v-model="commentText[reel.id]" placeholder="Ajouter un commentaire…" @keyup.enter="sendComment(reel.id)" class="c-input" />
                <button class="c-send" @click="sendComment(reel.id)" :disabled="!commentText[reel.id]?.trim()">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                </button>
              </div>
            </div>
          </transition>
        </div>

        <!-- Action buttons — outside card, YouTube Shorts style -->
        <div class="reel-actions">

          <button class="action-btn" :class="{ liked: likedPosts.has(reel.id) }" @click="toggleLike(reel.id)">
            <div class="action-circle" :class="{ liked: likedPosts.has(reel.id) }">
              <svg viewBox="0 0 24 24" :fill="likedPosts.has(reel.id) ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
              </svg>
            </div>
            <span>{{ formatCount(reel.likes?.length || 0) }}</span>
          </button>

          <button class="action-btn" :class="{ active: showComments[reel.id] }" @click="showComments[reel.id] = !showComments[reel.id]">
            <div class="action-circle" :class="{ active: showComments[reel.id] }">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
            </div>
            <span>{{ formatCount(reel.comments?.length || 0) }}</span>
          </button>

          <button class="action-btn">
            <div class="action-circle">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
              </svg>
            </div>
            <span>Partager</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.reels-page { display: flex; flex-direction: column; flex: 1; min-height: 0; background: #0a0a0a; }

.reels-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 20px; background: #111;
  border-bottom: 1px solid rgba(255,255,255,0.07); flex-shrink: 0;
}
.header-left { display: flex; align-items: center; gap: 8px; }
.reels-icon { width: 16px; height: 16px; color: white; }
.reels-header h1 { font-size: 1.1rem; font-weight: 800; color: white; margin: 0; }

.upload-btn {
  display: flex; align-items: center; gap: 6px; padding: 8px 16px;
  background: var(--purple, #7c3aed); color: white; border-radius: 20px;
  font-size: 0.82rem; font-weight: 600; cursor: pointer; transition: background .18s;
}
.upload-btn:hover { background: var(--purple-d, #6d28d9); }
.upload-btn.uploading { opacity: 0.6; cursor: not-allowed; }
.upload-btn svg { width: 14px; height: 14px; }

.main-loader { display:flex; flex-direction:column; align-items:center; justify-content:center; flex:1; gap:16px; color:rgba(255,255,255,0.4); font-size:0.9rem; }
.spinner { width:32px; height:32px; border:3px solid rgba(255,255,255,0.1); border-top-color: var(--purple, #7c3aed); border-radius: 50%; animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* Feed */
.reels-feed {
  position: relative;
  flex: 1; overflow-y: scroll;
  scroll-snap-type: y mandatory;
  -webkit-overflow-scrolling: touch;
}
.reels-feed::-webkit-scrollbar { display: none; }

/* One snap unit — centered row */
.reel-row {
  scroll-snap-align: start;
  min-height: calc(100vh - 57px);
  display: flex; align-items: center; justify-content: center;
  gap: 16px; padding: 20px;
  box-sizing: border-box; background: #0a0a0a;
}

/* Portrait card — YouTube Shorts style */
.reel-card {
  /* 9:16 ratio, sized to fit the viewport height */
  width: clamp(200px, calc((100vh - 97px) * 9 / 16), 360px);
  height: clamp(355px, calc(100vh - 97px), 640px);
  border-radius: 18px; overflow: hidden;
  position: relative; background: #111;
  box-shadow: 0 8px 40px rgba(0,0,0,0.7);
  flex-shrink: 0;
}

.reel-video-wrap { position: absolute; inset: 0; overflow: hidden; cursor: pointer; }
.reel-video { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; object-position: center; display: block; }
.reel-gradient {
  position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(to top, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.05) 40%, transparent 70%);
}

.mute-btn {
  position: absolute; top: 12px; right: 12px; z-index: 5;
  background: rgba(0,0,0,0.5); backdrop-filter: blur(4px);
  border: none; color: white; width: 32px; height: 32px;
  border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer;
}
.mute-btn svg { width: 14px; height: 14px; }

.reel-meta { position: absolute; bottom: 16px; left: 14px; right: 14px; z-index: 5; }
.reel-author { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; }
.reel-av {
  width: 34px; height: 34px; border-radius: 50%; border: 2px solid white;
  background: var(--purple, #7c3aed); color: white; font-weight: 700; font-size: 0.8rem;
  display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0;
}
.reel-av img { width: 100%; height: 100%; object-fit: cover; }
.reel-username { color: white; font-weight: 700; font-size: 0.84rem; text-shadow: 0 1px 5px rgba(0,0,0,0.7); }
.badge { width: 15px; height: 15px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.badge.official { background: #1d9bf0; color: white; }
.badge.premium  { background: linear-gradient(135deg,#fbbf24,#f97316); color: white; }
.badge svg { width: 8px; height: 8px; }
.reel-caption { color: rgba(255,255,255,0.88); font-size: 0.78rem; line-height: 1.4; text-shadow: 0 1px 4px rgba(0,0,0,0.7); }

/* Action buttons — right side */
.reel-actions { display: flex; flex-direction: column; align-items: center; gap: 20px; }
.action-btn {
  display: flex; flex-direction: column; align-items: center; gap: 5px;
  background: none; border: none; cursor: pointer; color: rgba(255,255,255,0.7); transition: color .15s;
}
.action-btn:hover, .action-btn.liked, .action-btn.active { color: white; }
.action-btn.liked { color: #ff4d6d; }
.action-btn span { font-size: 0.72rem; font-weight: 700; }
.action-circle {
  width: 50px; height: 50px; border-radius: 50%;
  background: rgba(255,255,255,0.1);
  display: flex; align-items: center; justify-content: center;
  transition: background .18s, transform .15s;
}
.action-circle:hover { background: rgba(255,255,255,0.18); transform: scale(1.06); }
.action-circle.no-hover:hover { transform: none; background: rgba(255,255,255,0.1); }
.action-circle svg { width: 22px; height: 22px; }
.action-circle.liked  { background: rgba(255,77,109,0.2); color: #ff4d6d; }
.action-circle.active { background: rgba(124,58,237,0.25); color: var(--purple, #7c3aed); }

/* Comments panel */
.comments-panel {
  position: absolute; bottom: 0; left: 0; right: 0; z-index: 10;
  background: rgba(8,8,8,0.97); backdrop-filter: blur(16px);
  border-radius: 14px 14px 0 0; border-top: 1px solid rgba(255,255,255,0.1);
  max-height: 60%; display: flex; flex-direction: column;
}
.comments-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 14px 8px; border-bottom: 1px solid rgba(255,255,255,0.07); flex-shrink: 0;
}
.comments-head span { color: white; font-weight: 700; font-size: 0.85rem; }
.close-btn { background: none; border: none; color: rgba(255,255,255,0.45); cursor: pointer; display: flex; align-items: center; }
.close-btn svg { width: 15px; height: 15px; }
.comments-list { flex: 1; overflow-y: auto; padding: 8px 12px; display: flex; flex-direction: column; gap: 10px; }
.comments-list::-webkit-scrollbar { display: none; }
.no-comments { color: rgba(255,255,255,0.3); font-size: 0.77rem; text-align: center; padding: 16px; }
.comment-row { display: flex; align-items: flex-start; gap: 8px; }
.c-av { width: 26px; height: 26px; border-radius: 50%; background: rgba(255,255,255,0.12); color: white; font-size: 0.68rem; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.c-body { display: flex; flex-direction: column; gap: 1px; }
.c-body strong { color: white; font-size: 0.77rem; }
.c-body span { color: rgba(255,255,255,0.68); font-size: 0.77rem; line-height: 1.4; }
.comment-input-row { display: flex; gap: 8px; align-items: center; padding: 10px 12px; flex-shrink: 0; border-top: 1px solid rgba(255,255,255,0.06); }
.c-input { flex: 1; padding: 8px 12px; border: 1.5px solid rgba(255,255,255,0.12); border-radius: 20px; background: rgba(255,255,255,0.07); color: white; font-size: 0.78rem; outline: none; }
.c-input::placeholder { color: rgba(255,255,255,0.3); }
.c-input:focus { border-color: var(--purple, #7c3aed); }
.c-send { width: 32px; height: 32px; border-radius: 50%; background: var(--purple, #7c3aed); border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; }
.c-send svg { width: 13px; height: 13px; color: white; }
.c-send:disabled { opacity: 0.3; cursor: not-allowed; }

.slide-up-enter-active, .slide-up-leave-active { transition: all .26s cubic-bezier(.4,0,.2,1); }
.slide-up-enter-from, .slide-up-leave-to { opacity: 0; transform: translateY(100%); }

@media (max-width: 520px) {
  .reel-row { flex-direction: column; gap: 12px; padding: 12px; }
  .reel-card { width: min(88vw, calc((100vh - 200px) * 9 / 16)); height: min(calc(88vw * 16 / 9), calc(100vh - 200px)); }
  .reel-actions { flex-direction: row; gap: 14px; }
}
</style>
