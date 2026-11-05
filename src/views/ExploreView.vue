<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { supabase } from '../lib/supabaseClient'
import { getCurrentSession } from '../lib/authStore'
import { withTimeout, makeSafeLoader } from '../lib/withTimeout'
import { useRouter } from 'vue-router'

const router = useRouter()
function goToProfile(userId) {
  selectedUser.value = null
  if (userId === currentUser.value?.id) router.push('/profile')
  else router.push(`/profile/${userId}`)
}

const currentUser = ref(null)
const allUsers = ref([])
const followingIds = ref([])   // plain array — Vue can track this reactively
const loading = ref(true)
const searchQuery = ref('')
const selectedUser = ref(null)
const selectedUserPosts = ref([])
const loadingPosts = ref(false)

const isFollowing = (userId) => followingIds.value.includes(userId)

const _safeLoad = makeSafeLoader(loading)
async function fetchUsers() {
  await _safeLoad(async () => {
    const _ses = getCurrentSession(); const user = _ses?.user ?? null
    currentUser.value = user
    if (!user) return

    const [profilesRes, followsRes] = await Promise.all([
      withTimeout(supabase.from('profiles')
        .select('id, username, avatar_url, bio, is_premium, is_official, username_color, custom_badge_url, is_anonymous')
        .neq('id', user.id), 10000),
      withTimeout(supabase.from('follows')
        .select('following_id')
        .eq('follower_id', user.id), 10000),
    ])

    followingIds.value = followsRes?.data?.map(f => f.following_id) || []
    allUsers.value = profilesRes?.data || []
  })
}

async function toggleFollow(userId) {
  if (!currentUser.value) return
  const alreadyFollowing = isFollowing(userId)

  if (alreadyFollowing) {
    // Optimistic
    followingIds.value = followingIds.value.filter(id => id !== userId)
    const { error } = await supabase.from('follows')
      .delete()
      .eq('follower_id', currentUser.value.id)
      .eq('following_id', userId)
    // Rollback if failed
    if (error) followingIds.value = [...followingIds.value, userId]
  } else {
    // Optimistic
    followingIds.value = [...followingIds.value, userId]
    const { error } = await supabase.from('follows')
      .insert({ follower_id: currentUser.value.id, following_id: userId })
    // Rollback if failed
    if (error) followingIds.value = followingIds.value.filter(id => id !== userId)
  }
}

async function openUser(user) {
  selectedUser.value = user
  loadingPosts.value = true
  try {
    const result = await withTimeout(
      supabase.from('posts').select('*, likes(count)')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false }),
      8000
    )
    selectedUserPosts.value = result?.data || []
  } catch (e) {
    console.warn('openUser error:', e)
  } finally {
    loadingPosts.value = false
  }
}

const filteredUsers = computed(() => {
  const q = searchQuery.value.toLowerCase()
  if (!q) return allUsers.value
  return allUsers.value.filter(u => u.username?.toLowerCase().includes(q))
})

let _exploreVisHandler = null
onMounted(() => {
  fetchUsers()
  _exploreVisHandler = () => { if (document.visibilityState === 'visible') fetchUsers() }
  document.addEventListener('visibilitychange', _exploreVisHandler)
})
onUnmounted(() => {
  if (_exploreVisHandler) document.removeEventListener('visibilitychange', _exploreVisHandler)
})
</script>

<template>
  <div class="explore-page">
    <div class="topbar">
      <h1 class="page-title">Explore</h1>
      <div class="search-wrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input v-model="searchQuery" placeholder="Search users…" class="search-input" />
      </div>
    </div>

    <div v-if="loading" class="status-msg"><div class="spinner"></div></div>

    <div v-else-if="filteredUsers.length === 0" class="status-msg">
      <span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:32px;height:32px;margin-bottom:8px;opacity:0.3"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      </span>
      <p>No users found</p>
    </div>

    <div v-else class="users-grid">
      <div
        v-for="user in filteredUsers"
        :key="user.id"
        class="user-card"
        @click="openUser(user)"
      >
        <div class="user-av">
          <template v-if="user.is_anonymous">
            <div class="anon-icon-explore">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
            </div>
          </template>
          <template v-else>
            <img v-if="user.avatar_url" :src="user.avatar_url" alt="avatar" />
            <span v-else>{{ user.username?.charAt(0)?.toUpperCase() || '?' }}</span>
          </template>
        </div>
        <div class="user-info">
          <div class="uname-row">
              <span class="uname" :style="!user.is_anonymous && user.username_color ? { color: user.username_color } : {}">
                @{{ user.is_anonymous ? 'Anonyme' : (user.username || 'unnamed') }}
              </span>
              <template v-if="!user.is_anonymous">
                <span v-if="user.is_official" class="badge-official" title="Official Account">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"/></svg>
                </span>
                <span v-if="user.is_premium" class="badge-prem" title="Premium">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                </span>
                <span v-if="user.is_premium && user.custom_badge_url" class="badge-custom" title="Custom badge">
                  <img :src="user.custom_badge_url" alt="badge" />
                </span>
              </template>
            </div>
          <span v-if="user.bio" class="ubio">{{ user.bio }}</span>
        </div>
        <button
          v-if="!user.is_anonymous"
          class="follow-btn"
          :class="{ following: isFollowing(user.id) }"
          @click.stop="toggleFollow(user.id)"
        >
          {{ isFollowing(user.id) ? 'Following' : 'Follow' }}
        </button>
      </div>
    </div>

    <!-- User Profile Modal -->
    <div v-if="selectedUser" class="modal-backdrop" @click.self="selectedUser = null">
      <div class="modal">
        <button class="modal-close" @click="selectedUser = null">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>

        <div class="modal-header">
          <div class="modal-av" :class="{ 'modal-av-anon': selectedUser.is_anonymous }">
            <template v-if="selectedUser.is_anonymous">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:24px;height:24px"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
            </template>
            <template v-else>
              <img v-if="selectedUser.avatar_url" :src="selectedUser.avatar_url" />
              <span v-else>{{ selectedUser.username?.charAt(0)?.toUpperCase() }}</span>
            </template>
          </div>
          <div class="modal-info">
            <h3>@{{ selectedUser.is_anonymous ? 'Anonyme' : (selectedUser.username || 'unnamed') }}</h3>
            <p v-if="selectedUser.is_anonymous" class="modal-bio">Cet utilisateur est en mode anonyme.</p>
            <p v-else-if="selectedUser.bio" class="modal-bio">{{ selectedUser.bio }}</p>
          </div>
          <div class="modal-action-row">
            <button
              class="follow-btn"
              :class="{ following: isFollowing(selectedUser.id) }"
              @click="toggleFollow(selectedUser.id)"
            >
              <template v-if="isFollowing(selectedUser.id)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>
                Following
              </template>
              <template v-else>+ Follow</template>
            </button>
            <button class="view-profile-btn" @click="goToProfile(selectedUser.id)">
              View profile →
            </button>
          </div>
        </div>

        <div class="modal-posts-label">Posts ({{ selectedUserPosts.length }})</div>

        <div v-if="loadingPosts" class="status-msg"><div class="spinner"></div></div>
        <div v-else-if="selectedUserPosts.length === 0" class="status-msg small">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:24px;height:24px;margin-right:8px"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          No posts yet
        </div>
        <div v-else class="modal-grid">
          <div v-for="post in selectedUserPosts" :key="post.id" class="modal-post">
            <img :src="post.media_url" :alt="post.caption || ''" loading="lazy" />
            <div class="modal-post-overlay">
              <svg viewBox="0 0 24 24" fill="white" style="width:14px;height:14px"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
              {{ post.likes?.[0]?.count || 0 }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.explore-page { padding: 28px 32px; max-width: 960px; }

.topbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; }
.page-title { font-family: 'Epilogue', sans-serif; font-size: 1.6rem; font-weight: 800; color: var(--text); }

.search-wrap {
  display: flex; align-items: center; gap: 8px;
  background: white; border: 1.5px solid #e2d9ff; border-radius: 12px;
  padding: 9px 16px; min-width: 220px; transition: border-color .18s;
}
.search-wrap:focus-within { border-color: var(--purple); }
.search-wrap svg { width: 16px; height: 16px; color: var(--text-2); flex-shrink: 0; }
.search-input { border: none; outline: none; font-family: 'Instrument Sans', sans-serif; font-size: 0.88rem; width: 100%; background: none; }

.status-msg { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 60px 0; color: var(--text-2); }
.status-msg.small { padding: 30px 0; flex-direction: row; font-size: 0.9rem; }
.spinner { width: 36px; height: 36px; border: 3px solid #e2d9ff; border-top-color: var(--purple); border-radius: 50%; animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.users-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }

.user-card {
  display: flex; align-items: center; gap: 12px;
  background: white; border-radius: 14px; padding: 14px 16px;
  box-shadow: 0 2px 12px rgba(76,16,224,0.06); cursor: pointer;
  transition: transform .18s, box-shadow .18s;
}
.user-card:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(76,16,224,0.1); }

.user-av {
  width: 44px; height: 44px; border-radius: 50%; background: var(--purple); color: white;
  font-weight: 700; font-size: 1rem; display: flex; align-items: center; justify-content: center;
  overflow: hidden; flex-shrink: 0;
}
.anon-icon-explore { display:flex; align-items:center; justify-content:center; width:100%; height:100%; color:white; background:linear-gradient(135deg, #1e293b, #0f172a); }
.anon-icon-explore svg { width:20px; height:20px; }
.user-av img { width: 100%; height: 100%; object-fit: cover; }
.user-info { flex: 1; overflow: hidden; display: flex; flex-direction: column; gap: 2px; }
.uname { font-weight: 700; font-size: 0.88rem; transition: color .2s; }
.uname-row { display: flex; align-items: center; gap: 4px; }
.badge-official { width: 15px; height: 15px; display: inline-flex; align-items: center; justify-content: center; background: #1d9bf0; border-radius: 50%; color: white; flex-shrink: 0; }
.badge-official svg { width: 9px; height: 9px; }
.badge-prem { width: 15px; height: 15px; display: inline-flex; align-items: center; justify-content: center; background: linear-gradient(135deg,#fbbf24,#f97316); border-radius: 50%; color: white; flex-shrink: 0; }
.badge-prem svg { width: 9px; height: 9px; }
.badge-custom { width: 15px; height: 15px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.badge-custom img { width: 15px; height: 15px; object-fit: contain; border-radius: 3px; }
.ubio { font-size: 0.78rem; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.follow-btn {
  padding: 7px 16px; border-radius: 20px; font-size: 0.8rem; font-weight: 700;
  font-family: 'Instrument Sans', sans-serif; cursor: pointer; flex-shrink: 0;
  background: var(--purple); color: white; border: none; transition: all .18s;
}
.follow-btn.following { background: none; border: 1.5px solid #d0c4ff; color: var(--text-2); }
.follow-btn:hover { opacity: 0.85; }
.modal-action-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.view-profile-btn {
  padding: 8px 16px; border-radius: 10px; font-size: 0.8rem; font-weight: 700;
  background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.13);
  color: var(--text, #f1f1f1); cursor: pointer; font-family: 'Instrument Sans', sans-serif;
  transition: background .18s;
}
.view-profile-btn:hover { background: rgba(255,255,255,0.14); }

/* Modal */
.modal-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 500;
  display: flex; align-items: center; justify-content: center; padding: 20px;
  backdrop-filter: blur(4px);
}
.modal {
  background: white; border-radius: 20px; width: 100%; max-width: 560px;
  max-height: 85vh; overflow-y: auto; padding: 24px; position: relative;
  box-shadow: 0 20px 60px rgba(0,0,0,0.25);
}
.modal-close {
  position: absolute; top: 16px; right: 16px;
  width: 32px; height: 32px; border-radius: 50%; background: #f0eeff;
  border: none; cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: background .15s;
}
.modal-close svg { width: 15px; height: 15px; }
.modal-close:hover { background: #e0d5ff; }

.modal-av-anon { background: linear-gradient(135deg, #1e293b, #0f172a) !important; }

.modal-header { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
.modal-av {
  width: 60px; height: 60px; border-radius: 50%; background: var(--purple); color: white;
  font-weight: 800; font-size: 1.4rem; display: flex; align-items: center; justify-content: center;
  overflow: hidden; flex-shrink: 0;
}
.modal-av img { width: 100%; height: 100%; object-fit: cover; }
.modal-info { flex: 1; }
.modal-info h3 { font-family: 'Epilogue', sans-serif; font-size: 1.1rem; font-weight: 800; margin-bottom: 4px; }
.modal-bio { font-size: 0.85rem; color: var(--text-2); }

.modal-posts-label {
  font-size: 0.78rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
  color: var(--text-2); margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1.5px solid #f0eeff;
}
.modal-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.modal-post { aspect-ratio: 1; border-radius: 10px; overflow: hidden; position: relative; background: #f0eeff; }
.modal-post img { width: 100%; height: 100%; object-fit: cover; transition: transform .3s; }
.modal-post:hover img { transform: scale(1.05); }
.modal-post-overlay {
  position: absolute; inset: 0; background: rgba(76,16,224,0.5);
  display: flex; align-items: center; justify-content: center; gap: 5px;
  color: white; font-weight: 700; font-size: 0.85rem; opacity: 0; transition: opacity .2s;
}
.modal-post:hover .modal-post-overlay { opacity: 1; }

@media (max-width: 600px) {
  .explore-page { padding: 16px; }
  .topbar { flex-direction: column; align-items: flex-start; }
  .search-wrap { width: 100%; }
  .users-grid { grid-template-columns: 1fr; }
}
</style>
