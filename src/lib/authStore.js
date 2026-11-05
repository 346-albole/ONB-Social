/**
 * Shared auth store — single source of truth for the current session.
 * All views import `useAuthSession()` instead of calling getSession() themselves.
 * This eliminates the race condition where multiple components independently
 * await getSession() and can hang if Supabase is mid-refresh.
 */
import { ref } from 'vue'
import { supabase } from './supabaseClient'

const _session = ref(undefined)   // undefined = not yet initialized
const _ready   = ref(false)        // true once first resolution is done
let   _initPromise = null

/**
 * Initialize once — call this from App.vue's onMounted.
 * All other callers just use getCurrentSession() which never awaits network.
 */
export async function initAuth() {
  if (_initPromise) return _initPromise
  _initPromise = (async () => {
    const { data } = await supabase.auth.getSession()
    _session.value = data.session
    _ready.value = true
  })()
  return _initPromise
}

/** Returns session from cache — instant, no network. */
export function getCurrentSession() {
  return _session.value
}

/** Reactive ref — components can watch this directly. */
export const sessionRef = _session

/** Reactive ref — true once session has been resolved at least once. */
export const authReady  = _ready

/** Call from App.vue's onAuthStateChange listener. */
export function updateSession(event, session) {
  if (event === 'SIGNED_OUT') {
    _session.value = null
  } else if (['SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED', 'INITIAL_SESSION'].includes(event)) {
    _session.value = session
  }
  _ready.value = true
}
