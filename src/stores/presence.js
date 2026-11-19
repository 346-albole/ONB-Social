import { ref } from 'vue'
import { realtime } from '../lib/realtime'

// Ensemble des identifiants des utilisateurs en ligne (canal temps réel `presence`).
export const onlineUsers = ref(new Set())
let unsubscribe = null

/**
 * Rejoint la présence. Un utilisateur invisible voit qui est en ligne sans y
 * apparaître lui-même.
 */
export async function initPresence(userId, isInvisible = false) {
  unsubscribe?.()
  unsubscribe = realtime.subscribe('presence', (event, payload) => {
    if (event === 'sync') onlineUsers.value = new Set(payload?.online || [])
  })
  realtime.setPresence(!isInvisible)
}

export function destroyPresence() {
  realtime.setPresence(false)
  unsubscribe?.()
  unsubscribe = null
  onlineUsers.value = new Set()
}
