<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { supabase } from '../lib/supabaseClient'
import { getCurrentSession } from '../lib/authStore'
import { withTimeout } from '../lib/withTimeout'

const route  = useRoute()
const router = useRouter()

const profile        = ref(null)
const userPosts      = ref([])
const loading        = ref(true)
const notFound       = ref(false)
const followersCount = ref(0)
const followingCount = ref(0)
const followersList  = ref([])
const followingList  = ref([])
const showModal      = ref(null)
const loadingModal   = ref(false)
const isFollowing    = ref(false)
const followLoading  = ref(false)
const currentUserId  = ref(null)

const BANNER_PRESETS_DEFAULT = 'linear-gradient(135deg, #4C10E0 0%, #9b5cf6 100%)'

// ── Load ────────────────────────────────────────────────────────────────────
onMounted(async () => {
  const session = getCurrentSession()
  currentUserId.value = session?.user?.id || null

  const userId = route.params.userId

  // If viewing own profile, redirect to /profile
  if (currentUserId.value && userId === currentUserId.value) {
    router.replace('/profile')
    return
  }

  try {
    const [profileRes, postsRes, fcRes, ingRes] = await Promise.all([
      withTimeout(
        supabase.from('profiles')
          .select('id, username, avatar_url, bio, is_premium, is_official, username_color, banner_color, banner_url, custom_badge_url, is_anonymous')
          .eq('id', userId).maybeSingle(),
        8000
      ),
      withTimeout(
        supabase.from('posts').select('*, likes(count)').eq('user_id', userId).order('created_at', { ascending: false }),
        10000
      ),
      withTimeout(
        supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', userId),
        8000
      ),
      withTimeout(
        supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', userId),
        8000
      ),
    ])

    if (!profileRes?.data) { notFound.value = true; return }
    profile.value        = profileRes.data
    userPosts.value      = postsRes?.data || []
    followersCount.value = fcRes?.count  || 0
    followingCount.value = ingRes?.count || 0

    // Check if current user follows this profile
    if (currentUserId.value) {
      const { data: fRow } = await supabase.from('follows')
        .select('id').eq('follower_id', currentUserId.value).eq('following_id', userId).maybeSingle()
      isFollowing.value = !!fRow
    }
  } catch (e) {
    console.warn('UserProfileView load error:', e)
    notFound.value = true
  } finally {
    loading.value = false
  }
})

// ── Follow / Unfollow ───────────────────────────────────────────────────────
async function toggleFollow() {
  if (!currentUserId.value || followLoading.value) return
  followLoading.value = true
  try {
    const targetId = route.params.userId
    if (isFollowing.value) {
      await supabase.from('follows')
        .delete().eq('follower_id', currentUserId.value).eq('following_id', targetId)
      followersCount.value = Math.max(0, followersCount.value - 1)
      isFollowing.value = false
    } else {
      await supabase.from('follows')
        .insert({ follower_id: currentUserId.value, following_id: targetId })
      followersCount.value += 1
      isFollowing.value = true
    }
  } catch (e) {
    console.warn('toggleFollow error:', e)
  } finally {
    followLoading.value = false
  }
}

// ── Message ─────────────────────────────────────────────────────────────────
function goToMessage() {
  router.push({ path: '/chat', query: { friend: route.params.userId } })
}

// ── Followers / Following modal ─────────────────────────────────────────────
async function openModal(type) {
  showModal.value = type
  loadingModal.value = true
  try {
    const userId = route.params.userId
    if (type === 'followers') {
      const { data } = await supabase.from('follows')
        .select('follower:profiles!follower_id(id, username, avatar_url, is_premium, is_official)')
        .eq('following_id', userId)
      followersList.value = data?.map(r => r.follower).filter(Boolean) || []
    } else {
      const { data } = await supabase.from('follows')
        .select('following:profiles!following_id(id, username, avatar_url, is_premium, is_official)')
        .eq('follower_id', userId)
      followingList.value = data?.map(r => r.following).filter(Boolean) || []
    }
  } catch (e) {
    console.warn('openModal error:', e)
  } finally {
    loadingModal.value = false
  }
}

function goToUserProfile(userId) {
  showModal.value = null
  if (userId === currentUserId.value) router.push('/profile')
  else router.push(`/profile/${userId}`)
}

// ── Computed ─────────────────────────────────────────────────────────────────
const isPremium     = computed(() => profile.value?.is_premium === true)
const isAnonymous   = computed(() => profile.value?.is_anonymous === true)
const avatarIsVideo = computed(() => !isAnonymous.value && profile.value?.avatar_url && /\.(mp4|webm|mov)(\?|$)/i.test(profile.value.avatar_url))
const displayName   = computed(() => isAnonymous.value ? 'Anonyme' : (profile.value?.username || 'User'))
const totalLikes    = computed(() => userPosts.value.reduce((s, p) => s + (p.likes?.[0]?.count || 0), 0))
const bannerStyle   = computed(() => {
  if (profile.value?.banner_url) return { backgroundImage: `url(${profile.value.banner_url})`, backgroundSize: 'cover', backgroundPosition: 'center' }
  return { background: profile.value?.banner_color || BANNER_PRESETS_DEFAULT }
})
const usernameStyle = computed(() => profile.value?.username_color ? { color: profile.value.username_color } : {})
const modalList     = computed(() => showModal.value === 'followers' ? followersList.value : followingList.value)

const rootBgStyle = computed(() => {
  return { background: 'var(--app-bg)' }
})
</script>

<template>
  <div class="up-root" :style="rootBgStyle">

    <!-- Loading -->
    <div v-if="loading" class="up-loading">
      <div class="up-spinner"></div>
    </div>

    <!-- Not found -->
    <div v-else-if="notFound" class="up-notfound">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
      <h2>User not found</h2>
      <p>This profile doesn't exist or has been removed.</p>
      <button class="btn-back" @click="router.back()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:14px;height:14px;display:inline;vertical-align:middle;margin-right:4px"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        Go back
      </button>
    </div>

    <!-- Profile -->
    <div v-else-if="profile" class="up-page">

      <!-- Back button -->
      <button class="up-back-btn" @click="router.back()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        Back
      </button>

      <!-- Banner + Avatar hero -->
      <div class="up-hero">
        <div class="up-banner" :style="bannerStyle"></div>
        <div class="up-hero-body">
          <div class="up-av-wrap">
            <div class="up-av" :class="{ 'up-av-anon': isAnonymous }">
              <template v-if="isAnonymous">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:48px;height:48px;color:white"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
              </template>
              <template v-else>
                <video v-if="avatarIsVideo" :src="profile.avatar_url" autoplay loop muted playsinline class="up-av-media" />
                <img   v-else-if="profile.avatar_url" :src="profile.avatar_url" alt="avatar" class="up-av-media" />
                <span  v-else class="up-av-initial">{{ displayName.charAt(0).toUpperCase() }}</span>
              </template>
            </div>
            <div v-if="isPremium" class="up-crown" title="Premium">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M2 19l2-9 5 4 3-8 3 8 5-4 2 9H2z"/></svg>
            </div>
          </div>

          <div class="up-info">
            <div class="up-name-row">
              <h2 class="up-name" :style="!isAnonymous ? usernameStyle : {}">{{ displayName }}</h2>
              <template v-if="!isAnonymous">
                <span v-if="profile.is_official" class="up-badge official" title="Official Account">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"/></svg>
                </span>
                <span v-if="isPremium" class="up-badge premium" title="Premium member">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                </span>
                <img v-if="isPremium && profile.custom_badge_url" :src="profile.custom_badge_url" class="up-custom-badge" alt="badge" />
              </template>
            </div>

            <p v-if="isAnonymous" class="up-bio muted">Cet utilisateur a choisi de rester anonyme.</p>
            <p v-else-if="profile.bio" class="up-bio">{{ profile.bio }}</p>
            <p v-else class="up-bio muted">No bio yet.</p>

            <div class="up-stats">
              <div class="up-stat"><span class="up-sv">{{ userPosts.length }}</span><span class="up-sl">Posts</span></div>
              <div class="up-stat-div"></div>
              <div class="up-stat"><span class="up-sv">{{ totalLikes }}</span><span class="up-sl">Likes</span></div>
              <div class="up-stat-div"></div>
              <button class="up-stat up-stat-btn" @click="openModal('followers')"><span class="up-sv">{{ followersCount }}</span><span class="up-sl">Followers</span></button>
              <div class="up-stat-div"></div>
              <button class="up-stat up-stat-btn" @click="openModal('following')"><span class="up-sv">{{ followingCount }}</span><span class="up-sl">Following</span></button>
            </div>

            <!-- Action buttons -->
            <div v-if="currentUserId" class="up-actions">
              <button
                class="up-follow-btn"
                :class="{ following: isFollowing }"
                :disabled="followLoading"
                @click="toggleFollow"
              >
                <span v-if="followLoading" class="btn-spin"></span>
                <template v-else>
                  <svg v-if="isFollowing" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>
                  <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
                  {{ isFollowing ? 'Following' : 'Follow' }}
                </template>
              </button>
              <button class="up-msg-btn" @click="goToMessage">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                Message
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Posts section -->
      <div class="up-posts-section">
        <div class="up-posts-header">
           <h3 class="up-posts-title">Posts</h3>
           <div class="up-posts-count">{{ userPosts.length }} publications</div>
        </div>

        <div v-if="userPosts.length === 0" class="up-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 21V9"/></svg>
          <p>Désolé, aucun post n'a été publié pour le moment.</p>
        </div>
        <div v-else class="up-posts-grid">
          <div v-for="post in userPosts" :key="post.id" class="up-post-card">
            <div class="up-post-media">
               <img v-if="post.media_url" :src="post.media_url" class="up-post-img" alt="post image" />
               <div v-else class="up-post-no-img">Texto</div>
               <div class="up-post-overlay">
                  <div class="up-overlay-stat">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                    {{ post.likes?.[0]?.count || 0 }}
                  </div>
               </div>
            </div>
            <div class="up-post-info">
              <p class="up-post-caption">{{ post.caption || post.content || '' }}</p>
              <span class="up-post-date">{{ new Date(post.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) }}</span>
            </div>
          </div>
        </div>
      </div>

    </div>

    <!-- Followers / Following Modal -->
    <div v-if="showModal" class="up-modal-backdrop" @click.self="showModal = null">
      <div class="up-modal">
        <div class="up-modal-header">
          <span class="up-modal-title">{{ showModal === 'followers' ? 'Followers' : 'Following' }}</span>
          <button class="up-modal-close" @click="showModal = null">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div v-if="loadingModal" class="up-modal-loading"><div class="up-spinner"></div></div>
        <div v-else-if="modalList.length === 0" class="up-modal-empty">Nobody here yet</div>
        <div v-else class="up-modal-list">
          <button v-for="u in modalList" :key="u.id" class="up-modal-user" @click="goToUserProfile(u.id)">
            <div class="up-modal-av">
              <img v-if="u.avatar_url" :src="u.avatar_url" alt="avatar" />
              <span v-else>{{ (u.username || '?').charAt(0).toUpperCase() }}</span>
            </div>
            <span class="up-modal-name">@{{ u.username }}</span>
            <span v-if="u.is_premium" class="up-modal-premium" title="Premium member">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            </span>
            <span v-if="u.is_official" class="up-modal-official" title="Official account">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"/></svg>
            </span>
          </button>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
.up-root { min-height: 100vh; background: var(--app-bg); color: var(--text); }

/* Loading */
.up-loading { display: flex; justify-content: center; align-items: center; height: 60vh; }
.up-spinner {
  width: 36px; height: 36px; border-radius: 50%;
  border: 3px solid rgba(76,16,224,0.1);
  border-top-color: var(--purple);
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* Not found */
.up-notfound {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  height: 70vh; gap: 12px; color: var(--text-2); text-align: center; padding: 24px;
}
.up-notfound svg { width: 64px; height: 64px; opacity: 0.4; }
.up-notfound h2 { font-size: 1.4rem; font-weight: 700; color: var(--text); margin: 0; }
.up-notfound p  { font-size: 0.9rem; margin: 0; }
.btn-back {
  margin-top: 8px; padding: 9px 20px; background: var(--purple); color: white;
  border: none; border-radius: 10px; font-weight: 700; font-size: 0.875rem; cursor: pointer;
  font-family: 'Instrument Sans', sans-serif; transition: background .18s;
}
.btn-back:hover { background: var(--purple-d); }

/* Page */
.up-page { max-width: 800px; margin: 0 auto; padding: 20px 20px 48px; }

/* Back button */
.up-back-btn {
  display: inline-flex; align-items: center; gap: 6px;
  margin-bottom: 16px; padding: 7px 14px;
  background: white; border: 1px solid #e2d9ff;
  border-radius: 10px; color: var(--text-2); font-size: 0.85rem; font-weight: 600;
  cursor: pointer; transition: all .18s;
  font-family: 'Instrument Sans', sans-serif;
}
.up-back-btn:hover { background: #f8f7ff; border-color: var(--purple); color: var(--purple); }
.up-back-btn svg { width: 15px; height: 15px; }

/* Hero */
.up-hero { background: white; border-radius: 24px; margin-bottom: 24px; overflow: hidden; border: 1px solid #ede8ff; box-shadow: 0 10px 30px rgba(76, 16, 224, 0.05); }
.up-banner { height: 180px; width: 100%; position: relative; }
.up-banner::after { content: ''; position: absolute; inset: 0; background: linear-gradient(to bottom, transparent, rgba(0,0,0,0.2)); }
.up-hero-body { display: flex; gap: 24px; padding: 0 30px 30px; align-items: flex-end; flex-wrap: wrap; }

/* Avatar */
.up-av-wrap { position: relative; margin-top: -60px; flex-shrink: 0; z-index: 2; }
.up-av {
  width: 130px; height: 130px; border-radius: 38px;
  border: 5px solid white;
  background: var(--purple);
  overflow: hidden; display: flex; align-items: center; justify-content: center;
  font-size: 3.5rem; font-weight: 800; color: white;
  box-shadow: 0 10px 25px rgba(76, 16, 224, 0.15);
}
.up-av-anon { background: linear-gradient(135deg, #1e293b, #0f172a); }
.up-av-media { width: 100%; height: 100%; object-fit: cover; }
.up-crown {
  position: absolute; top: -12px; right: -12px;
  width: 36px; height: 36px; background: linear-gradient(135deg, #fbbf24, #f59e0b);
  border-radius: 12px; display: flex; align-items: center; justify-content: center;
  border: 3px solid white; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  transform: rotate(12deg);
}
.up-crown svg { width: 20px; height: 20px; color: white; }

/* Info */
.up-info { flex: 1; min-width: 250px; padding-top: 15px; }
.up-name-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 4px; }
.up-name { font-family: 'Epilogue', sans-serif; font-size: 1.85rem; font-weight: 900; color: var(--text); margin: 0; letter-spacing: -0.02em; }
.up-badge { display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; }
.up-badge.official { background: #1d9bf0; }
.up-badge.official svg { width: 12px; height: 12px; color: white; }
.up-badge.premium { background: var(--purple); }
.up-badge.premium svg { width: 12px; height: 12px; color: white; }
.up-custom-badge { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; }
.up-bio { font-size: 0.98rem; color: var(--text-2); margin: 8px 0 20px; line-height: 1.6; max-width: 520px; }
.up-bio.muted { font-style: italic; opacity: 0.6; }

/* Stats */
.up-stats { display: flex; align-items: center; gap: 4px; margin-bottom: 24px; flex-wrap: wrap; background: #f8f7ff; padding: 12px; border-radius: 18px; border: 1px solid #ede8ff; }
.up-stat { display: flex; flex-direction: column; align-items: center; padding: 4px 18px; gap: 2px; }
.up-stat-btn { background: none; border: none; cursor: pointer; transition: all 0.2s; border-radius: 12px; }
.up-stat-btn:hover { background: white; transform: translateY(-2px); box-shadow: 0 4px 12px rgba(76,16,224,0.06); }
.up-sv { font-size: 1.15rem; font-weight: 800; color: var(--text); }
.up-sl { font-size: 0.68rem; color: var(--text-2); font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
.up-stat-div { width: 1px; height: 28px; background: #e2d9ff; }

/* Action buttons */
.up-actions { display: flex; gap: 12px; flex-wrap: wrap; }
.up-follow-btn, .up-msg-btn {
  display: inline-flex; align-items: center; gap: 10px;
  padding: 12px 28px; border-radius: 16px; font-size: 0.95rem; font-weight: 800;
  border: none; cursor: pointer; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  font-family: 'Instrument Sans', sans-serif;
}
.up-follow-btn { background: var(--purple); color: white; box-shadow: 0 10px 20px rgba(76, 16, 224, 0.15); }
.up-follow-btn.following { background: white; color: var(--purple); border: 2px solid var(--purple); box-shadow: none; }
.up-follow-btn:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 12px 24px rgba(76, 16, 224, 0.2); }
.up-follow-btn.following:hover { background: #f8f7ff; }
.up-follow-btn:active { transform: translateY(0); }
.up-follow-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.up-follow-btn svg, .up-msg-btn svg { width: 16px; height: 16px; }
.up-msg-btn { background: #f0eeff; color: var(--purple); }
.up-msg-btn:hover { background: #e2d9ff; transform: translateY(-2px); }

.btn-spin {
  width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid rgba(255,255,255,0.3); border-top-color: white;
  animation: spin 0.6s linear infinite; display: inline-block;
}

/* Posts section */
.up-posts-section { max-width: 800px; margin: 0 auto; }
.up-posts-header { display: flex; align-items: baseline; justify-content: space-between; margin: 30px 0 20px; }
.up-posts-title { font-family: 'Epilogue', sans-serif; font-size: 1.4rem; font-weight: 900; color: var(--text); margin: 0; }
.up-posts-count { font-size: 0.9rem; color: var(--text-2); font-weight: 600; opacity: 0.8; }

.up-empty {
  display: flex; flex-direction: column; align-items: center; gap: 12px;
  padding: 60px 0; color: var(--text-2); text-align: center;
  background: white; border-radius: 24px; border: 1px dashed #e2d9ff;
}
.up-empty svg { width: 48px; height: 48px; opacity: 0.2; color: var(--purple); }
.up-empty p { font-size: 0.95rem; font-weight: 600; margin: 0; opacity: 0.6; }

.up-posts-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
.up-post-card {
  background: white; border-radius: 20px; overflow: hidden;
  border: 1px solid #ede8ff; transition: all 0.3s ease;
  display: flex; flex-direction: column;
}
.up-post-card:hover { transform: translateY(-4px); border-color: var(--purple); box-shadow: 0 10px 25px rgba(76, 16, 224, 0.08); }

.up-post-media { position: relative; width: 100%; aspect-ratio: 1/1; background: #f8f7ff; overflow: hidden; }
.up-post-img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.5s; }
.up-post-card:hover .up-post-img { transform: scale(1.08); }

.up-post-no-img { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--purple); font-weight: 800; font-size: 1.2rem; background: linear-gradient(135deg, #f0eeff, #fff); }

.up-post-overlay {
  position: absolute; inset: 0; background: rgba(76, 16, 224, 0.2);
  display: flex; align-items: center; justify-content: center;
  opacity: 0; transition: opacity 0.3s;
}
.up-post-card:hover .up-post-overlay { opacity: 1; }
.up-overlay-stat { display: flex; align-items: center; gap: 6px; color: white; font-weight: 800; font-size: 1.1rem; }
.up-overlay-stat svg { width: 22px; height: 22px; }

.up-post-info { padding: 14px; flex: 1; display: flex; flex-direction: column; gap: 8px; }
.up-post-caption { font-size: 0.88rem; color: var(--text); line-height: 1.5; margin: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.up-post-date { font-size: 0.75rem; color: var(--text-2); font-weight: 600; opacity: 0.7; }

/* Modal */
.up-modal-backdrop {
  position: fixed; inset: 0; background: rgba(27, 19, 64, 0.4); backdrop-filter: blur(8px);
  z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 20px;
}
.up-modal {
  background: white; border-radius: 24px; width: 100%; max-width: 400px;
  max-height: 70vh; display: flex; flex-direction: column; overflow: hidden;
  box-shadow: 0 25px 60px rgba(27, 19, 64, 0.2);
  border: 1px solid #ede8ff;
}
.up-modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 20px 24px; border-bottom: 1px solid #f0eeff;
}
.up-modal-title { font-size: 1.1rem; font-weight: 800; color: var(--text); }
.up-modal-close {
  width: 32px; height: 32px; border-radius: 50%; background: #f0eeff;
  border: none; cursor: pointer; display: flex; align-items: center; justify-content: center;
  color: var(--purple); transition: all 0.2s;
}
.up-modal-close:hover { background: var(--purple); color: white; transform: rotate(90deg); }
.up-modal-close svg { width: 16px; height: 16px; }
.up-modal-loading { display: flex; justify-content: center; padding: 40px; }
.up-modal-empty { padding: 40px 24px; text-align: center; color: var(--text-2); font-size: 0.95rem; font-weight: 600; opacity: 0.6; }
.up-modal-list { overflow-y: auto; padding: 12px; }
.up-modal-user {
  width: 100%; display: flex; align-items: center; gap: 12px; padding: 12px 14px;
  background: none; border: none; border-radius: 14px; cursor: pointer;
  transition: all 0.2s; text-align: left;
}
.up-modal-user:hover { background: #f8f7ff; transform: translateX(4px); }
.up-modal-av {
  width: 40px; height: 40px; border-radius: 14px; background: var(--purple);
  overflow: hidden; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
  font-size: 1.1rem; font-weight: 800; color: white;
}
.up-modal-av img { width: 100%; height: 100%; object-fit: cover; }
.up-modal-name { flex: 1; font-size: 0.95rem; font-weight: 700; color: var(--text); }
.up-modal-premium { display: inline-flex; width: 18px; height: 18px; color: #fbbf24; flex-shrink: 0; }
.up-modal-premium svg { width: 100%; height: 100%; }
.up-modal-official { display: inline-flex; width: 18px; height: 18px; color: #1d9bf0; flex-shrink: 0; }
.up-modal-official svg { width: 100%; height: 100%; }

@media (max-width: 640px) {
  .up-page { padding: 10px 10px 32px; }
  .up-hero { border-radius: 18px; }
  .up-hero-body { padding: 0 20px 20px; gap: 15px; }
  .up-banner { height: 120px; }
  .up-av { width: 90px; height: 90px; border-radius: 28px; }
  .up-posts-header { margin: 20px 0 15px; }
  .up-posts-grid { grid-template-columns: repeat(2, 1fr); gap: 10px; }
  .up-post-card { border-radius: 14px; }
  .up-post-info { padding: 10px; }
  .up-post-caption { font-size: 0.8rem; }
}
</style>
