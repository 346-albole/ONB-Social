import { ref } from 'vue'
import { supabase } from '../lib/supabaseClient'

export const onlineUsers = ref(new Set())
let presenceChannel = null
let _presenceUserId = null
let _presenceIsInvisible = false
let _reconnectTimer = null

export async function initPresence(userId, isInvisible = false) {
  _presenceUserId = userId
  _presenceIsInvisible = isInvisible
  // Unsubscribe from any existing channel before creating a new one
  if (presenceChannel) {
    presenceChannel.unsubscribe()
    presenceChannel = null
  }

  presenceChannel = supabase.channel('online-users', {
    config: { presence: { key: userId } }
  })

  presenceChannel
    .on('presence', { event: 'sync' }, () => {
      const state = presenceChannel.presenceState()
      const ids = new Set()
      Object.values(state).forEach(presences => {
        presences.forEach(p => { if (p.user_id) ids.add(p.user_id) })
      })
      onlineUsers.value = ids
    })
    .on('presence', { event: 'join' }, ({ newPresences }) => {
      const next = new Set(onlineUsers.value)
      newPresences.forEach(p => { if (p.user_id) next.add(p.user_id) })
      onlineUsers.value = next
    })
    .on('presence', { event: 'leave' }, ({ leftPresences }) => {
      const next = new Set(onlineUsers.value)
      leftPresences.forEach(p => { next.delete(p.user_id) })
      onlineUsers.value = next
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(_reconnectTimer)
        if (!_presenceIsInvisible) {
          await presenceChannel.track({ user_id: userId, online_at: new Date().toISOString() })
        }
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        // Attempt a reconnect after 5 seconds
        clearTimeout(_reconnectTimer)
        _reconnectTimer = setTimeout(() => {
          if (_presenceUserId) initPresence(_presenceUserId, _presenceIsInvisible)
        }, 5000)
      }
    })
}

export function destroyPresence() {
  clearTimeout(_reconnectTimer)
  presenceChannel?.unsubscribe()
  presenceChannel = null
  _presenceUserId = null
  onlineUsers.value = new Set()
}
