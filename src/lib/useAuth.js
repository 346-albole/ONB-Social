import { ref, onMounted, onUnmounted } from 'vue'
import { supabase } from './supabaseClient'

// Shared reactive auth state across all views
const currentUser = ref(null)
const authReady   = ref(false)
let listeners = 0
let sub = null

function startListening() {
  sub = supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'INITIAL_SESSION') {
      currentUser.value = session?.user || null
      authReady.value = true
      return
    }
    currentUser.value = session?.user || null
  })
}

export function useAuth() {
  onMounted(async () => {
    listeners++
    if (listeners === 1) {
      const { data: { session } } = await supabase.auth.getSession()
      currentUser.value = session?.user || null
      authReady.value = true
      startListening()
    }
  })
  onUnmounted(() => {
    listeners--
    if (listeners === 0) {
      sub?.data?.subscription?.unsubscribe()
      sub = null
      authReady.value = false
    }
  })
  return { currentUser, authReady }
}
