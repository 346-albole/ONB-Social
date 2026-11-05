<script setup>
import { RouterView, useRouter, useRoute } from 'vue-router'
import { supabase } from './lib/supabaseClient'
import { initAuth, updateSession, sessionRef } from './lib/authStore'
import { onMounted, onUnmounted, ref, computed, watch } from 'vue'
import { initPresence, destroyPresence, onlineUsers } from './stores/presence'
import { areNotifsEnabled } from './lib/pushNotifications'
import { t, currentLang, setLang, LANGS } from './lib/i18n'
import FloatingAi from './components/FloatingAi.vue'

const router = useRouter()
const route = useRoute()
const session = sessionRef          // reactive — shared with router and N
const profile = ref(null)
const followedUsers = ref([])
const appCrashed = ref(false)
const appIsReady = ref(false)
let visibilityHandler = null
let hiddenAt = 0            // tracks when the tab was hidden
let authSubscription = null // supabase listener handle
let commandsSub = null      // supabase realtime handle for admin_commands

onMounted(async () => {
  try {
    // Initialize the shared auth store — only network call on startup
    // Hard timeout: if auth takes > 8s, unblock the app anyway
    await Promise.race([
      initAuth(),
      new Promise(resolve => setTimeout(resolve, 8000))
    ])
    appIsReady.value = true
    const s = session.value
    if (s) {
      // Load secondary data in background to unblock UI
      loadSidebarData(s.user.id, s.user.email)
      initPresence(s.user.id, profile.value?.is_invisible)
      initAdminCommands(s.user.id)
    }

    // Keep auth store + sidebar in sync on real auth events
    const { data } = supabase.auth.onAuthStateChange(async (event, _session) => {
      updateSession(event, _session)

      if (event === 'SIGNED_OUT') {
        profile.value = null
        followedUsers.value = []
        destroyPresence()
        destroyAdminCommands()
        return
      }
      if (event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') return

      if (_session) {
        await loadSidebarData(_session.user.id, _session.user.email)
        await initPresence(_session.user.id, profile.value?.is_invisible)
        initAdminCommands(_session.user.id)
      }
    })
    authSubscription = data.subscription

    visibilityHandler = async () => {
      if (document.visibilityState === 'visible' && session.value) {
        // Only refresh sidebar data if page was hidden for > 5 minutes
        const hiddenFor = Date.now() - hiddenAt
        if (hiddenAt > 0 && hiddenFor > 5 * 60 * 1000) {
          await loadSidebarData(session.value.user.id, session.value.user.email)
        }
        hiddenAt = 0
      } else {
        hiddenAt = Date.now()
      }
    }
    document.addEventListener('visibilitychange', visibilityHandler)
  } catch (err) {
    console.error('[App] onMounted error:', err)
  } finally {
    appIsReady.value = true
  }
})

onUnmounted(() => {
  destroyPresence()
  destroyAdminCommands()
  authSubscription?.unsubscribe()
  if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler)
})

async function loadSidebarData(userId, userEmail) {
  const { data: p } = await supabase.from('profiles')
    .select('id, username, avatar_url, is_premium, is_official, is_admin, username_color, custom_badge_url, onb_coins, premium_expires_at, official_expires_at, premium_is_permanent, official_is_permanent, is_banned, is_anonymous, is_invisible')
    .eq('id', userId).maybeSingle()
  profile.value = { email: userEmail, ...(p || {}) }
  checkRenewals(p)

  const [iFollowRes, followMeRes] = await Promise.all([
    supabase.from('follows').select('following_id').eq('follower_id', userId),
    supabase.from('follows').select('follower_id').eq('following_id', userId),
  ])

  const iFollowIds = new Set(iFollowRes.data?.map(f => f.following_id) || [])
  const followMeIds = new Set(followMeRes.data?.map(f => f.follower_id) || [])
  const mutualIds = [...iFollowIds].filter(id => followMeIds.has(id))

  if (mutualIds.length) {
    const { data: friends } = await supabase.from('profiles')
      .select('id, username, avatar_url').in('id', mutualIds)
    followedUsers.value = friends || []
  } else {
    followedUsers.value = []
  }
}

const handleSignOut = async () => {
  destroyPresence()
  await supabase.auth.signOut()
  router.push('/auth')
}

const openChat = (friendId) => {
  router.push({ path: '/chat', query: { friend: friendId } })
}

function initAdminCommands(userId) {
  commandsSub?.unsubscribe()
  commandsSub = supabase.channel(`admin_cmd_${userId}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'admin_commands', filter: `target_user_id=eq.${userId}`
    }, payload => {
      if (payload.new.command === 'reload') window.location.reload()
    }).subscribe()
}

function destroyAdminCommands() {
  commandsSub?.unsubscribe()
  commandsSub = null
}

const isAuth = computed(() => ['auth', 'verify-email', 'auth-callback'].includes(route.name))

// Subscription renewal modal
const showRenewalModal = ref(false)
const renewalDue = ref([])  // list of { sub: 'premium'|'official', daysLeft }

function checkRenewals(p) {
  if (!p) return
  const dues = []
  if (!p.premium_is_permanent && p.premium_expires_at) {
    const days = Math.max(0, Math.ceil((new Date(p.premium_expires_at) - Date.now()) / 86400000))
    if (days <= 7) dues.push({ sub: 'premium', daysLeft: days, expires: p.premium_expires_at })
  }
  if (!p.official_is_permanent && p.official_expires_at) {
    const days = Math.max(0, Math.ceil((new Date(p.official_expires_at) - Date.now()) / 86400000))
    if (days <= 7) dues.push({ sub: 'official', daysLeft: days, expires: p.official_expires_at })
  }
  renewalDue.value = dues
  if (dues.length > 0) showRenewalModal.value = true
}
const isOnline = (userId) => onlineUsers.value.has(userId)
</script>

<template>
  <div v-if="!appIsReady" class="global-app-loader">
    <div class="brand-loader">
      <img src="./assets/onbsocial-logo.svg" alt="ONBSocial" class="bl-icon" />
      <span class="bl-text">ONBSocial</span>
    </div>
    <div class="spinner"></div>
  </div>
  <div v-else-if="profile?.is_banned" class="banned-overlay">
    <div class="banned-card">
      <div class="bc-emoji">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:40px;height:40px"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
      </div>
      <h1>Compte Bloqué</h1>
      <p>Votre compte a été suspendu pour non-respect des règles de modération (utilisation de termes interdits).</p>
      <button class="signout-banned" @click="handleSignOut">Déconnexion</button>
    </div>
  </div>
  <div v-else class="app-shell" :class="{ 'auth-mode': isAuth }">

    <aside v-if="session && !isAuth" class="sidebar">
      <div class="sidebar-inner">

        <div class="brand" @click="router.push('/')">
          <img src="./assets/onbsocial-logo.svg" class="brand-icon" alt="ONBSocial icon" />
          <span class="brand-text"><span class="b1">ONB</span><span class="b2">Social</span></span>
        </div>

        <button class="user-row" @click="router.push('/profile')">
          <div class="av av-lg" style="position:relative;overflow:visible">
            <div style="width:100%;height:100%;border-radius:50%;overflow:hidden;display:flex;align-items:center;justify-content:center;">
              <img v-if="profile?.avatar_url" :src="profile.avatar_url" alt="avatar" style="width:100%;height:100%;object-fit:cover" />
              <span v-else>{{ (profile?.username || profile?.email || '?').charAt(0).toUpperCase() }}</span>
            </div>
            <span class="av-online-dot" title="En ligne"></span>
          </div>
          <div class="user-meta">
            <div class="user-name-row">
              <span class="user-name" :style="profile?.username_color ? { color: profile.username_color } : {}">{{ profile?.username || profile?.email?.split('@')[0] || 'my account' }}</span>
              <span v-if="profile?.is_official" class="sidebar-official-icon" title="Verified Account">
                <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" width="9" height="9">
                  <path d="M10 1.5L3 5v5.5c0 4.1 2.9 7.8 7 9 4.1-1.2 7-4.9 7-9V5L10 1.5z" fill="white"/>
                  <path d="M7.5 10l2 2 3-3.5" stroke="#1d9bf0" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
                </svg>
              </span>
              <span v-if="profile?.is_premium" class="sidebar-premium-icon" title="Premium">
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
              </span>
              <span v-if="profile?.is_premium && profile?.custom_badge_url" class="sidebar-custom-badge" title="Custom badge">
                <img :src="profile.custom_badge_url" alt="badge" />
              </span>
            </div>
            <span class="user-email">{{ profile?.email || '' }}</span>
          </div>
        </button>

        <hr class="div" />

        <nav>
          <button class="nav-btn" :class="{ on: $route.name === 'home' }" @click="router.push('/')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
            {{ t.feed }}
          </button>
          <button class="nav-btn" :class="{ on: $route.name === 'reels' }" @click="router.push('/reels')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="5,3 19,12 5,21"/></svg>
            {{ t.reels }}
          </button>
          <button class="nav-btn" :class="{ on: $route.name === 'explore' }" @click="router.push('/explore')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            {{ t.explore }}
          </button>
          <button class="nav-btn" :class="{ on: $route.name === 'groups' }" @click="router.push('/groups')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            {{ t.groups }}
          </button>
          <button class="nav-btn" :class="{ on: $route.name === 'forum' }" @click="router.push('/forum')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 6h16M4 10h16M4 14h10M4 18h6"/></svg>
            {{ t.forum }}
          </button>
          <button class="nav-btn" :class="{ on: $route.name === 'chat' }" @click="router.push('/chat')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            {{ t.messages }}
          </button>
          <button class="nav-btn nav-global" :class="{ on: $route.name === 'global-chat' }" @click="router.push('/global-chat')">
            <span class="nav-global-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="width:18px;height:18px"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
              <span class="nav-online-count" v-if="onlineUsers.size > 0">{{ onlineUsers.size }}</span>
            </span>
            {{ t.globalChat }}
          </button>
          <button class="nav-btn" :class="{ on: $route.name === 'profile' }" @click="router.push('/profile')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            {{ t.profile }}
          </button>
          <button class="nav-btn nav-ai" :class="{ on: $route.name === 'ai' }" @click="router.push('/ai')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
              <circle cx="12" cy="12" r="4"/>
            </svg>
            {{ t.onbia }}
          </button>
          <button v-if="profile?.is_admin" class="nav-btn nav-admin" :class="{ on: $route.name === 'admin' }" @click="router.push('/admin')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
            {{ t.admin }}
          </button>
        </nav>

        <hr class="div" />

        <div class="section-label" style="display:none">Friends</div><!-- hidden on mobile, shown on desktop via CSS override -->
        <div class="section-label sidebar-friends-label">Friends</div>
        <div class="friends">
          <div v-if="!followedUsers.length" class="empty-friends">No mutual friends yet</div>
          <button
            v-for="f in followedUsers"
            :key="f.id"
            class="friend"
            @click="openChat(f.id)"
            :title="'Chat with @' + f.username"
          >
            <div class="friend-av-wrap">
              <div class="av av-sm">
                <img v-if="f.avatar_url" :src="f.avatar_url" alt="friend" />
                <span v-else>{{ f.username?.charAt(0)?.toUpperCase() }}</span>
              </div>
              <span v-if="isOnline(f.id)" class="friend-online-dot"></span>
            </div>
            <div class="friend-text">
              <span class="fname">@{{ f.username }}</span>
              <span class="fpreview" :class="{ 'online-text': isOnline(f.id) }">
                {{ isOnline(f.id) ? '● Online' : 'Click to chat' }}
              </span>
            </div>
            <svg class="fchev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          </button>
        </div>

        <button class="nav-btn" :class="{ on: $route.name === 'whatsnew' }" @click="router.push('/whatsnew')" style="margin: 4px 8px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          {{ t.whatsNew }}
        </button>

        <button class="nav-btn nav-coin" :class="{ on: $route.name === 'coins' }" @click="router.push('/coins')" style="margin: 4px 8px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px;flex-shrink:0"><circle cx="12" cy="12" r="10"/><path d="M12 7v1m0 8v1M9.5 9.5C9.5 8.4 10.6 7.5 12 7.5s2.5.9 2.5 2-.9 1.8-2.5 2-2.5.9-2.5 2 1.1 2 2.5 2 2.5-.9 2.5-2" stroke-linecap="round"/></svg>
          <span>{{ t.coins }}</span>
          <span v-if="profile?.onb_coins !== undefined" class="coin-balance-chip">{{ (profile.onb_coins ?? 0).toLocaleString() }}</span>
        </button>

        <div class="spacer" />

        <!-- Language Switcher -->
        <div class="lang-switcher">
          <button
            v-for="lang in LANGS"
            :key="lang.code"
            class="lang-btn"
            :class="{ active: currentLang === lang.code }"
            @click="setLang(lang.code)"
            :title="lang.label"
          >
            <span class="lang-flag">
              <svg v-if="lang.code === 'en'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>
            </span>
            <span class="lang-label">{{ lang.label }}</span>
          </button>
        </div>

        <div class="beta-label">ONBSocial Version Bêta</div>
        <button class="signout" @click="handleSignOut">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16,17 21,12 16,7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          {{ t.signOut }}
        </button>
      </div>
    </aside>

    <!-- Mobile Bottom Navigation Bar -->
    <nav v-if="session && !isAuth" class="mobile-bottom-nav">
      <button class="mbn-btn" :class="{ on: $route.name === 'home' }" @click="router.push('/')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
        <span>{{ t.feed }}</span>
      </button>
      <button class="mbn-btn" :class="{ on: $route.name === 'explore' }" @click="router.push('/explore')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <span>{{ t.explore }}</span>
      </button>
      <button class="mbn-btn mbn-global" :class="{ on: $route.name === 'global-chat' }" @click="router.push('/global-chat')">
        <span class="mbn-global-wrap">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          <span class="mbn-online-dot" v-if="onlineUsers.size > 0"></span>
        </span>
        <span>Chat</span>
      </button>
      <button class="mbn-btn" :class="{ on: $route.name === 'chat' }" @click="router.push('/chat')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span>{{ t.messages }}</span>
      </button>
      <button class="mbn-btn" :class="{ on: $route.name === 'ai' }" @click="router.push('/ai')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
          <circle cx="12" cy="12" r="4"/>
        </svg>
        <span>AI</span>
      </button>
      <button class="mbn-btn" :class="{ on: $route.name === 'profile' }" @click="router.push('/profile')">
        <div class="mbn-av" v-if="profile?.avatar_url">
          <img :src="profile.avatar_url" />
        </div>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <span>{{ t.profile }}</span>
      </button>
    </nav>

    <main class="page" :class="{ 'no-sidebar': isAuth }">
      <div v-if="!isAuth" class="page-header">
        <template v-if="$route.name === 'home'">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
          <span>Feed</span>
        </template>
        <template v-else-if="$route.name === 'reels'">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="5,3 19,12 5,21"/></svg>
          <span>Reels</span>
        </template>
        <template v-else-if="$route.name === 'explore'">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <span>Explore</span>
        </template>
        <template v-else-if="$route.name === 'chat'">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <span>Messages</span>
        </template>
        <template v-else-if="$route.name === 'forum'">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 6h16M4 10h16M4 14h10M4 18h6"/></svg>
          <span>Forum</span>
        </template>
        <template v-else-if="$route.name === 'global-chat'">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          <span>Chat Global</span>
          <span class="ph-online-badge"><span class="online-pulse"></span>{{ onlineUsers.size }} en ligne</span>
        </template>
        <template v-else-if="$route.name === 'groups'">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          <span>Groups</span>
        </template>
        <template v-else-if="$route.name === 'whatsnew'">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          <span>What's New</span>
        </template>
        <template v-else-if="$route.name === 'coins'">
          <svg viewBox="0 0 24 24" fill="currentColor" style="width:20px;height:20px"><circle cx="12" cy="12" r="10"/></svg>
          <span>ONB Coins</span>
        </template>
        <template v-else-if="$route.name === 'admin'">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
          <span>Admin Panel</span>
        </template>
        <template v-else-if="$route.name === 'ai'">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
            <circle cx="12" cy="12" r="4"/>
          </svg>
          <span>ONB-IA Assistant</span>
        </template>
      </div>

      <div
        class="rv-wrap"
        :class="['chat', 'groups', 'reels', 'global-chat'].includes($route.name) ? 'rv-chat' : 'rv-scroll'"
      >
        <RouterView
          @profile-updated="async () => { if (session) await loadSidebarData(session.user.id, session.user.email) }"
        />
      </div>
    </main>
    
    <!-- Global Floating AI Assistant -->
    <FloatingAi v-if="session && !isAuth" />
  </div>

  <!-- Subscription renewal modal -->
  <div v-if="showRenewalModal && renewalDue.length" class="renewal-overlay" @click.self="showRenewalModal = false">
    <div class="renewal-modal">
      <div class="rm-header">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        {{ t.renewalTitle }}
      </div>
      <div class="rm-body">
        <p class="rm-intro">{{ t.renewalIntro }}</p>
        <div v-for="item in renewalDue" :key="item.sub" class="rm-item" :class="item.sub">
          <svg v-if="item.sub === 'premium'" viewBox="0 0 24 24" fill="currentColor" style="width:16px;height:16px"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
          <svg v-else viewBox="0 0 20 20" style="width:16px;height:16px"><path d="M10 1.5L3 5v5.5c0 4.1 2.9 7.8 7 9 4.1-1.2 7-4.9 7-9V5L10 1.5z" fill="#1d9bf0"/><path d="M7.5 10l2 2 3-3.5" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
          <div>
            <strong>{{ item.sub === 'premium' ? 'Premium' : 'Official Status' }}</strong>
            — expires {{ item.daysLeft === 0 ? t.today : t.inDays(item.daysLeft) }}
          </div>
          <span class="rm-price">{{ item.sub === 'premium' ? '6,700' : '300' }} coins</span>
        </div>
      </div>
      <div class="rm-footer">
        <button class="rm-dismiss" @click="showRenewalModal = false">{{ t.remindLater }}</button>
        <button class="rm-go" @click="showRenewalModal = false; router.push('/coins')">
          <svg viewBox="0 0 24 24" fill="currentColor" style="width:15px;height:15px"><circle cx="12" cy="12" r="10"/></svg>
          {{ t.goToCoins }}
        </button>
      </div>
    </div>
  </div>

</template>

<style>
@import url('https://fonts.googleapis.com/css2?family=Epilogue:wght@400;500;700;800&family=Instrument+Sans:wght@400;500;600;700&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --purple:    #4C10E0;
  --purple-d:  #3B0CAF;
  --purple-dd: #2C0882;
  --accent:    #8B5CF6;
  --dim:       rgba(255,255,255,0.55);
  --divider:   rgba(255,255,255,0.14);
  --hover-bg:  rgba(255,255,255,0.09);
  --active-bg: rgba(255,255,255,0.17);
  --sw:        240px;
  --app-bg:    #EEE9FF;
  --card:      #ffffff;
  --text:      #1B1340;
  --text-2:    #5a5080;
}

html, body { height: 100%; }
body { font-family: 'Instrument Sans', sans-serif; background: var(--app-bg); color: var(--text); }

button {
  font-family: 'Instrument Sans', sans-serif;
  color: inherit;
  border: none;
  background: none;
  border-radius: 10px;
  cursor: pointer;
  transition: background .18s, color .18s, border-color .18s, box-shadow .18s, transform .12s;
}
button:focus-visible { outline: 2px solid rgba(76,16,224,0.35); outline-offset: 2px; }
button:disabled { cursor: not-allowed; opacity: 0.6; }

.global-app-loader { height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 24px; background: var(--app-bg); }
.global-app-loader .spinner { width: 44px; height: 44px; border: 4px solid #e2d9ff; border-top-color: var(--purple); border-radius: 50%; animation: spin .8s linear infinite; }
.brand-loader { display: flex; align-items: center; gap: 12px; animation: pulse-opacity 1.5s infinite alternate; }
.brand-loader .bl-icon { width: 50px; height: 50px; border-radius: 12px; }
.brand-loader .bl-text { font-family: 'Epilogue', sans-serif; font-size: 1.8rem; font-weight: 800; color: var(--purple); }
@keyframes pulse-opacity { from { opacity: 0.6; } to { opacity: 1; } }

.app-shell { display: flex; min-height: 100vh; }
.app-shell.auth-mode { display: block; }

.sidebar {
  width: var(--sw); min-height: 100vh;
  background: var(--purple);
  position: fixed; top: 0; left: 0;
  overflow-y: auto; z-index: 200;
}
.sidebar-inner {
  display: flex; flex-direction: column;
  min-height: 100vh; padding: 0 0 16px;
}

.brand {
  display: flex; align-items: center; gap: 10px;
  padding: 16px 18px 14px;
  cursor: pointer; transition: opacity .18s;
}
.brand:hover { opacity: 0.85; }
.brand-icon { width: 36px; height: 36px; border-radius: 8px; flex-shrink: 0; }
.brand-text { font-family: 'Epilogue', sans-serif; font-size: 1.25rem; line-height: 1; }
.b1 { font-weight: 800; color: white; }
.b2 { font-weight: 700; color: rgba(255,255,255,0.82); }

.user-row {
  display: flex; align-items: center; gap: 11px;
  padding: 10px 14px; margin: 0 8px 4px;
  background: none; border: none; border-radius: 12px;
  cursor: pointer; transition: background .18s; text-align: left;
}
.user-row:hover { background: var(--hover-bg); }

.av {
  border-radius: 50%;
  background: rgba(255,255,255,0.22);
  border: 2px solid rgba(255,255,255,0.35);
  overflow: hidden; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; color: white;
}
.av img { width: 100%; height: 100%; object-fit: cover; }
.av-lg { width: 40px; height: 40px; font-size: 1rem; }
.av-sm { width: 34px; height: 34px; font-size: 0.85rem; }

.av-online-dot {
  position: absolute;
  bottom: -1px; right: -1px;
  width: 10px; height: 10px;
  border-radius: 50%;
  background: #22c55e;
  border: 2px solid var(--purple);
  z-index: 1;
}

.user-meta { display: flex; flex-direction: column; overflow: hidden; }
.user-name-row { display: flex; align-items: center; gap: 5px; }
.user-name { color: white; font-size: 0.88rem; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sidebar-premium-icon { width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #fbbf24, #f97316); border-radius: 50%; color: white; flex-shrink: 0; }
.sidebar-premium-icon svg { width: 8px; height: 8px; }
.sidebar-official-icon { width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; background: #1d9bf0; border-radius: 50%; color: white; flex-shrink: 0; }
.sidebar-custom-badge { width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.sidebar-custom-badge img { width: 14px; height: 14px; object-fit: contain; border-radius: 3px; }
.user-email { color: var(--dim); font-size: 0.72rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.div { border: none; border-top: 1px solid var(--divider); margin: 8px 20px; }

nav { display: flex; flex-direction: column; gap: 2px; padding: 4px 8px; }
.nav-btn {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 14px; background: none; border: none; border-radius: 10px;
  color: var(--dim); font-family: 'Instrument Sans', sans-serif;
  font-size: 0.92rem; font-weight: 500; cursor: pointer; transition: all .18s;
}
.nav-btn svg { width: 18px; height: 18px; flex-shrink: 0; }
.nav-btn:hover { background: var(--hover-bg); color: white; }
.nav-btn.on { background: var(--active-bg); color: white; font-weight: 700; }
.nav-btn.nav-admin { background: rgba(239,68,68,0.12); color: rgba(255,180,180,0.9); }
.nav-btn.nav-admin:hover { background: rgba(239,68,68,0.22); color: white; }
.nav-btn.nav-admin.on { background: rgba(239,68,68,0.25); color: white; font-weight: 700; }

.nav-global-icon { position: relative; display: inline-flex; flex-shrink: 0; }
.nav-online-count {
  position: absolute; top: -5px; right: -7px;
  background: #22c55e; color: white;
  font-size: 0.55rem; font-weight: 800;
  min-width: 14px; height: 14px;
  border-radius: 7px; padding: 0 3px;
  display: flex; align-items: center; justify-content: center;
  border: 1.5px solid var(--purple);
}

.section-label {
  padding: 8px 22px 6px;
  font-size: 0.75rem; font-weight: 700; color: var(--dim);
  letter-spacing: .07em; text-transform: uppercase;
}

.friends { display: flex; flex-direction: column; gap: 2px; padding: 2px 8px; }
.empty-friends { color: var(--dim); font-size: 0.78rem; padding: 6px 14px; }

.friend {
  display: flex; align-items: center; gap: 10px;
  padding: 7px 12px; border-radius: 10px;
  background: none; border: none;
  cursor: pointer; transition: background .18s; text-align: left; width: 100%;
}
.friend:hover { background: var(--hover-bg); }

.friend-av-wrap { position: relative; flex-shrink: 0; }
.friend-online-dot {
  position: absolute; bottom: 0; right: 0;
  width: 9px; height: 9px; border-radius: 50%;
  background: #22c55e; border: 2px solid var(--purple);
  z-index: 1;
}

.friend-text { display: flex; flex-direction: column; overflow: hidden; flex: 1; }
.fname { color: white; font-size: 0.84rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fpreview { color: var(--dim); font-size: 0.72rem; }
.fpreview.online-text { color: #86efac; }
.fchev { width: 13px; height: 13px; color: var(--dim); flex-shrink: 0; }

.spacer { flex: 1; }

.signout {
  display: flex; align-items: center; gap: 10px;
  margin: 0 8px; padding: 10px 14px;
  background: none; border: 1px solid var(--divider); border-radius: 10px;
  color: var(--dim); font-family: 'Instrument Sans', sans-serif;
  font-size: 0.85rem; cursor: pointer; transition: all .18s;
}
.signout svg { width: 16px; height: 16px; }
.signout:hover { background: rgba(255,255,255,0.08); color: white; border-color: rgba(255,255,255,0.3); }

.page {
  margin-left: var(--sw);
  flex: 1; height: 100vh;
  display: flex; flex-direction: column;
  overflow: hidden;
}
.page.no-sidebar { margin-left: 0; }

.page-header {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 32px;
  background: white;
  border-bottom: 1px solid #ede8ff;
  flex-shrink: 0;
  font-family: 'Epilogue', sans-serif;
  font-size: 1.15rem; font-weight: 800;
  color: var(--text); z-index: 100;
}
.page-header svg { width: 20px; height: 20px; color: var(--purple); flex-shrink: 0; }

.ph-online-badge {
  display: inline-flex; align-items: center; gap: 5px;
  margin-left: 10px; padding: 3px 10px; border-radius: 20px;
  background: #f0fff4; color: #16a34a;
  font-size: 0.75rem; font-weight: 700;
  font-family: 'Instrument Sans', sans-serif;
}
.online-pulse {
  width: 7px; height: 7px; border-radius: 50%; background: #22c55e;
  animation: pulse-anim 2s infinite;
}
@keyframes pulse-anim {
  0%, 100% { opacity: 1; } 50% { opacity: 0.5; }
}

.rv-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.rv-chat { overflow: hidden; }
.rv-scroll { overflow-y: auto; }

.beta-label { text-align: center; font-size: 0.68rem; color: var(--dim); padding: 6px 0 2px; letter-spacing: .06em; font-weight: 600; }

@media (max-width: 860px) {
  :root { --sw: 70px; }
  .user-email, .user-name, .section-label, .friend-text, .fchev, .brand-text { display: none; }
  .brand-icon { width: 44px; height: 44px; border-radius: 8px; }
  .brand { padding: 14px 13px; justify-content: center; }
  .nav-btn { justify-content: center; padding: 12px 8px; }
  .nav-btn svg { width: 20px; height: 20px; }
  .friend { justify-content: center; }
  .user-row { justify-content: center; padding: 10px 8px; }
  .signout { justify-content: center; }
  .signout svg { margin: 0; }
  .page-header { padding: 12px 16px; font-size: 1rem; }
}
/* ONB Coins nav button */
.nav-btn.nav-coin { color: #fbbf24; }
.nav-btn.nav-coin:hover { background: rgba(251,191,36,0.12); color: #fbbf24; }
.nav-btn.nav-coin.on { background: rgba(251,191,36,0.18); color: #fbbf24; font-weight: 700; }
.coin-balance-chip {
  margin-left: auto;
  font-size: 0.68rem;
  font-weight: 800;
  background: rgba(251,191,36,0.2);
  color: #fbbf24;
  padding: 2px 7px;
  border-radius: 10px;
  letter-spacing: .03em;
}

/* Renewal modal */
.renewal-overlay {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(0,0,0,0.55);
  backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
}
.renewal-modal {
  background: white; border-radius: 20px; width: 100%; max-width: 420px;
  overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.25);
}
.rm-header {
  display: flex; align-items: center; gap: 10px;
  padding: 18px 22px;
  background: linear-gradient(135deg, #fbbf24, #f97316);
  color: white;
  font-family: 'Epilogue', sans-serif;
  font-weight: 800; font-size: 1rem;
}
.rm-header svg { width: 20px; height: 20px; flex-shrink: 0; }
.rm-body { padding: 18px 22px; display: flex; flex-direction: column; gap: 12px; }
.rm-intro { font-size: 0.88rem; color: var(--text-2); line-height: 1.5; margin: 0; }
.rm-item {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px; border-radius: 12px;
  font-size: 0.85rem; color: var(--text);
}
.rm-item.premium { background: #fffbeb; border: 1.5px solid #fbbf24; }
.rm-item.official { background: #eff6ff; border: 1.5px solid #3b82f6; }
.rm-item.premium svg { color: #f97316; }
.rm-item.official svg { color: #3b82f6; }
.rm-price { margin-left: auto; font-weight: 800; font-size: 0.82rem; color: var(--purple); white-space: nowrap; }
.rm-footer {
  display: flex; gap: 10px; padding: 16px 22px;
  border-top: 1px solid #f0ecff;
}
.rm-dismiss {
  flex: 1; padding: 10px; border: 1.5px solid #e2d9ff;
  border-radius: 10px; background: none; cursor: pointer;
  font-weight: 600; color: var(--text-2); font-size: 0.85rem;
}
.rm-go {
  flex: 2; display: flex; align-items: center; justify-content: center; gap: 7px;
  padding: 10px; border: none; border-radius: 10px;
  background: linear-gradient(135deg, #fbbf24, #f97316);
  color: white; font-weight: 700; font-size: 0.88rem; cursor: pointer;
}

/* ── Language Switcher ── */
.lang-switcher {
  display: flex; align-items: center; gap: 3px;
  padding: 6px 12px;
  flex-wrap: wrap;
}
.lang-btn {
  display: flex; align-items: center; gap: 4px;
  padding: 4px 8px; border-radius: 8px;
  background: none; border: 1px solid transparent;
  color: var(--dim); font-family: 'Instrument Sans', sans-serif;
  font-size: 0.72rem; font-weight: 700; cursor: pointer;
  transition: all .18s; letter-spacing: .03em;
}
.lang-btn:hover { background: var(--hover-bg); color: white; border-color: var(--divider); }
.lang-btn.active { background: var(--active-bg); color: white; border-color: rgba(255,255,255,0.25); }
.lang-flag { font-size: 0.82rem; }
.lang-label { font-size: 0.68rem; font-weight: 800; }

/* On collapsed sidebar hide labels */
@media (max-width: 860px) {
  .lang-label { display: none; }
  .lang-btn { padding: 5px 6px; }
  .lang-flag { font-size: 1rem; }
  .lang-switcher { justify-content: center; gap: 2px; }
  .sidebar-friends-label { display: none; }
}

/* ── Mobile Bottom Navigation ── */
.mobile-bottom-nav {
  display: none;
}

@media (max-width: 540px) {
  /* Hide the desktop sidebar entirely on small phones */
  .sidebar { display: none; }
  .page { margin-left: 0 !important; padding-bottom: 64px; }

  .mobile-bottom-nav {
    display: flex;
    position: fixed; bottom: 0; left: 0; right: 0; z-index: 300;
    background: white;
    border-top: 1px solid #ede8ff;
    padding: 6px 0 max(6px, env(safe-area-inset-bottom));
    box-shadow: 0 -4px 20px rgba(76,16,224,.08);
  }

  .mbn-btn {
    flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 3px; padding: 4px 2px;
    background: none; border: none; cursor: pointer;
    color: #9585c8; font-size: 0.6rem; font-weight: 600;
    font-family: 'Instrument Sans', sans-serif;
    transition: color .15s;
  }
  .mbn-btn svg { width: 22px; height: 22px; }
  .mbn-btn.on { color: var(--purple); }
  .mbn-btn.on svg { stroke: var(--purple); }

  .mbn-global { position: relative; }
  .mbn-global-wrap { position: relative; display: inline-flex; }
  .mbn-online-dot {
    position: absolute; top: -2px; right: -2px;
    width: 8px; height: 8px; border-radius: 50%;
    background: #22c55e; border: 2px solid white;
  }

  .mbn-av {
    width: 24px; height: 24px; border-radius: 50%;
    overflow: hidden; border: 2px solid currentColor;
  }
  .mbn-av img { width: 100%; height: 100%; object-fit: cover; }
}

/* ── Banned Overlay ── */
.banned-overlay {
  position: fixed; inset: 0; background: #faf9ff; z-index: 9999;
  display: flex; align-items: center; justify-content: center; padding: 20px;
}
.banned-card {
  background: white; padding: 40px; border-radius: 24px; max-width: 400px;
  text-align: center; box-shadow: 0 20px 50px rgba(76,16,224,0.1);
  display: flex; flex-direction: column; gap: 20px;
}
.bc-emoji { font-size: 50px; }
.banned-card h1 { font-family: 'Epilogue', sans-serif; font-size: 1.8rem; font-weight: 900; color: #ef4444; }
.banned-card p { color: var(--text-2); line-height: 1.6; font-size: 0.95rem; }
.signout-banned {
  padding: 12px; background: var(--purple); color: white; border: none;
  border-radius: 12px; font-weight: 700; cursor: pointer; transition: all .2s;
}
.signout-banned:hover { background: var(--purple-d); transform: scale(1.02); }

/* Tablet: keep collapsed sidebar, no bottom nav */
@media (min-width: 541px) and (max-width: 860px) {
  .mobile-bottom-nav { display: none !important; }
}
</style>
