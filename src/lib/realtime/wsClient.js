/**
 * Client temps réel WebSocket (fournisseur 'ws' de l'API).
 * Connexion paresseuse au premier abonnement, authentification par la
 * première trame, reconnexion automatique avec réabonnement.
 * Suit l'utilisateur connecté : reconnexion à la connexion / au changement
 * d'utilisateur, fermeture à la déconnexion (les abonnements sont conservés).
 */
import { watch } from 'vue'
import { api } from '../api'
import { auth } from '../auth'

const MAX_BACKOFF_MS = 15_000

function toWebSocketUrl(url) {
  if (/^wss?:\/\//.test(url)) return url
  const absolute = new URL(url, window.location.href)
  absolute.protocol = absolute.protocol === 'https:' ? 'wss:' : 'ws:'
  return absolute.toString()
}

export function createWebSocketClient() {
  /** @type {Map<string, Set<Function>>} */
  const handlers = new Map()
  let socket = null
  let ready = false
  let connecting = false
  let wantPresence = false
  let retry = 0
  let retryTimer = null

  function send(message) {
    if (socket && ready && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

  function closeSocket() {
    clearTimeout(retryTimer)
    const ws = socket
    socket = null
    ready = false
    if (ws) { ws.onclose = null; ws.close() }
  }

  function scheduleReconnect() {
    if (!handlers.size || !auth.user.value) return
    clearTimeout(retryTimer)
    const delay = Math.min(1000 * 2 ** retry, MAX_BACKOFF_MS)
    retry += 1
    retryTimer = setTimeout(connect, delay)
  }

  async function connect() {
    if (socket || connecting || !handlers.size) return
    connecting = true
    try {
      const userId = auth.user.value?.id
      const token = await auth.getAccessToken()
      if (!token) return
      const { data, error } = await api.get('/realtime/negotiate')
      if (error) throw new Error(error.message)
      if (auth.user.value?.id !== userId) return // l'utilisateur a changé entre-temps

      const ws = new WebSocket(toWebSocketUrl(data.url))
      socket = ws
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }))
      ws.onmessage = (e) => {
        let msg
        try { msg = JSON.parse(e.data) } catch { return }
        if (msg.type === 'auth:ok') {
          ready = true
          retry = 0
          for (const channel of handlers.keys()) send({ type: 'subscribe', channel })
          if (wantPresence) send({ type: 'presence:track' })
        } else if (msg.type === 'event') {
          for (const fn of handlers.get(msg.channel) || []) {
            try { fn(msg.event, msg.payload) } catch (err) { console.error('[realtime]', err) }
          }
        } else if (msg.type === 'error') {
          console.warn('[realtime]', msg.channel || '', msg.message)
        }
      }
      ws.onclose = () => {
        if (socket !== ws) return
        socket = null
        ready = false
        scheduleReconnect()
      }
    } catch (err) {
      console.warn('[realtime] connexion impossible :', err.message)
      socket = null
      scheduleReconnect()
    } finally {
      connecting = false
    }
  }

  // Connexion, déconnexion ou changement d'utilisateur.
  watch(() => auth.user.value?.id, (userId) => {
    closeSocket()
    retry = 0
    if (userId) connect()
  })

  return {
    subscribe(channel, fn) {
      const isNew = !handlers.has(channel)
      if (isNew) handlers.set(channel, new Set())
      handlers.get(channel).add(fn)
      if (isNew) send({ type: 'subscribe', channel })
      connect()
      return () => {
        const set = handlers.get(channel)
        if (!set) return
        set.delete(fn)
        if (!set.size) {
          handlers.delete(channel)
          send({ type: 'unsubscribe', channel })
        }
      }
    },

    setPresence(visible) {
      wantPresence = !!visible
      send({ type: wantPresence ? 'presence:track' : 'presence:untrack' })
    },

    /** Ferme la connexion (les abonnements restent enregistrés). */
    disconnect() {
      wantPresence = false
      closeSocket()
    },
  }
}
