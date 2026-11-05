import { createRouter, createWebHistory } from 'vue-router'
import { initAuth, getCurrentSession } from '../lib/authStore'

// ── Lazy-load every view for code-splitting & faster initial paint ──────────
const HomeView         = () => import('../views/HomeView.vue')
const AuthView         = () => import('../views/AuthView.vue')
const ProfileView      = () => import('../views/ProfileView.vue')
const ReelsView        = () => import('../views/ReelsView.vue')
const ExploreView      = () => import('../views/ExploreView.vue')
const ChatView         = () => import('../views/ChatView.vue')
const AdminView        = () => import('../views/AdminView.vue')
const GroupsView       = () => import('../views/GroupsView.vue')
const WhatsNewView     = () => import('../views/WhatsNewView.vue')
const GlobalChatView   = () => import('../views/GlobalChatView.vue')
const ForumView        = () => import('../views/ForumView.vue')
const CoinView         = () => import('../views/CoinView.vue')
const AiView           = () => import('../views/AiView.vue')
const VerifyEmailView  = () => import('../views/VerifyEmailView.vue')
const AuthCallbackView = () => import('../views/AuthCallbackView.vue')
const UserProfileView  = () => import('../views/UserProfileView.vue')

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    // Public routes (no auth needed)
    { path: '/auth',          name: 'auth',          component: AuthView },
    { path: '/verify-email',  name: 'verify-email',  component: VerifyEmailView },
    { path: '/auth/callback', name: 'auth-callback', component: AuthCallbackView },

    // Protected routes
    { path: '/',                name: 'home',         component: HomeView,        meta: { requiresAuth: true } },
    { path: '/profile',         name: 'profile',      component: ProfileView,     meta: { requiresAuth: true } },
    { path: '/profile/:userId', name: 'user-profile', component: UserProfileView, meta: { requiresAuth: true } },
    { path: '/reels',           name: 'reels',        component: ReelsView,       meta: { requiresAuth: true } },
    { path: '/explore',         name: 'explore',      component: ExploreView,     meta: { requiresAuth: true } },
    { path: '/chat',            name: 'chat',         component: ChatView,        meta: { requiresAuth: true } },
    { path: '/global-chat',     name: 'global-chat',  component: GlobalChatView,  meta: { requiresAuth: true } },
    { path: '/admin',           name: 'admin',        component: AdminView,       meta: { requiresAuth: true } },
    { path: '/groups',          name: 'groups',       component: GroupsView,      meta: { requiresAuth: true } },
    { path: '/whatsnew',        name: 'whatsnew',     component: WhatsNewView,    meta: { requiresAuth: true } },
    { path: '/forum',           name: 'forum',        component: ForumView,       meta: { requiresAuth: true } },
    { path: '/coins',           name: 'coins',        component: CoinView,        meta: { requiresAuth: true } },
    { path: '/ai',              name: 'ai',           component: AiView,          meta: { requiresAuth: true } },
  ],
})

// Initialize auth once — shared across all route guards
const authInitPromise = initAuth()

router.beforeEach(async (to, from, next) => {
  // Always allow public routes
  if (!to.meta.requiresAuth) { next(); return }

  // Wait for auth store to be ready (instant if already initialized)
  await authInitPromise

  const session = getCurrentSession()

  // No session → sign-in page
  if (!session) { next('/auth'); return }

  // Email verification check:
  // Old accounts always have email_confirmed_at (grandfathered).
  // New accounts must confirm before accessing the app.
  if (!session.user.email_confirmed_at) {
    next({
      name: 'verify-email',
      query: { email: session.user.email, mode: 'blocked' },
    })
    return
  }

  next()
})

export default router
