// Temps réel par WebSocket, intégré à l'API (même serveur, même port).
//
// Protocole (messages JSON) :
//   client → serveur
//     { type: 'auth', token }                 première trame obligatoire (10 s max)
//     { type: 'subscribe', channel }
//     { type: 'unsubscribe', channel }
//     { type: 'presence:track' } / { type: 'presence:untrack' }
//   serveur → client
//     { type: 'auth:ok', userId }
//     { type: 'subscribed', channel } / { type: 'error', channel?, message }
//     { type: 'event', channel, event, payload }
//
// Présence : canal `presence`, événement `sync` avec { online: [userId…] }.
// Limite : état en mémoire, valable pour une seule instance (voir PORTAGE_AZURE.md).
import websocket from '@fastify/websocket'
import { bearerToken, verifyAccessToken } from '../auth/jwt.js'
import { ensureProfile } from '../auth/profile.js'

const AUTH_TIMEOUT_MS = 10_000
const HEARTBEAT_MS = 30_000

export function createWebSocketRealtime({ log, canSubscribe }) {
  /** @type {Map<string, Set<object>>} canal → connexions */
  const channels = new Map()
  /** @type {Map<string, number>} userId → nombre de connexions « présentes » */
  const present = new Map()

  function send(conn, message) {
    if (conn.socket.readyState === 1) conn.socket.send(JSON.stringify(message))
  }

  function publish(channel, event, payload) {
    const subscribers = channels.get(channel)
    if (!subscribers?.size) return
    const frame = JSON.stringify({ type: 'event', channel, event, payload })
    for (const conn of subscribers) {
      if (conn.socket.readyState === 1) conn.socket.send(frame)
    }
  }

  function addToChannel(conn, channel) {
    if (!channels.has(channel)) channels.set(channel, new Set())
    channels.get(channel).add(conn)
    conn.channels.add(channel)
  }

  function removeFromChannel(conn, channel) {
    channels.get(channel)?.delete(conn)
    if (channels.get(channel)?.size === 0) channels.delete(channel)
    conn.channels.delete(channel)
  }

  function presenceSnapshot() {
    return { online: [...present.keys()] }
  }

  function setTracked(conn, tracked) {
    if (!conn.user || conn.tracked === tracked) return
    conn.tracked = tracked
    const id = conn.user.id
    const count = (present.get(id) || 0) + (tracked ? 1 : -1)
    const changed = tracked ? count === 1 : count === 0
    if (count > 0) present.set(id, count)
    else present.delete(id)
    if (changed) publish('presence', 'sync', presenceSnapshot())
  }

  function revoke(channel, userId) {
    for (const conn of [...(channels.get(channel) || [])]) {
      if (conn.user?.id === userId) {
        removeFromChannel(conn, channel)
        send(conn, { type: 'error', channel, message: 'Abonnement révoqué' })
      }
    }
  }

  async function handleMessage(conn, raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return send(conn, { type: 'error', message: 'JSON invalide' }) }

    if (!conn.user) {
      if (msg.type !== 'auth') return send(conn, { type: 'error', message: 'Authentification requise' })
      try {
        const identity = await verifyAccessToken(bearerToken(`Bearer ${msg.token}`) || '')
        await ensureProfile(identity)
        conn.user = identity
        clearTimeout(conn.authTimer)
        return send(conn, { type: 'auth:ok', userId: identity.id })
      } catch (err) {
        send(conn, { type: 'error', message: err.message })
        return conn.socket.close(4401, 'unauthorized')
      }
    }

    switch (msg.type) {
      case 'subscribe': {
        const channel = String(msg.channel || '')
        if (conn.channels.has(channel)) return send(conn, { type: 'subscribed', channel })
        let allowed = false
        try { allowed = await canSubscribe(conn.user.id, channel) } catch (err) { log.warn(err) }
        if (!allowed) return send(conn, { type: 'error', channel, message: 'Abonnement refusé' })
        addToChannel(conn, channel)
        send(conn, { type: 'subscribed', channel })
        if (channel === 'presence') send(conn, { type: 'event', channel, event: 'sync', payload: presenceSnapshot() })
        return
      }
      case 'unsubscribe':
        return removeFromChannel(conn, String(msg.channel || ''))
      case 'presence:track':
        return setTracked(conn, true)
      case 'presence:untrack':
        return setTracked(conn, false)
      case 'ping':
        return send(conn, { type: 'pong' })
      default:
        return send(conn, { type: 'error', message: `Type inconnu : ${msg.type}` })
    }
  }

  async function register(app) {
    await app.register(websocket, { options: { maxPayload: 64 * 1024 } })

    // Indique au client comment se connecter (Web PubSub renverra une URL signée).
    app.get('/realtime/negotiate', async () => ({ provider: 'ws', url: '/api/realtime' }))

    app.get('/realtime', { websocket: true, config: { auth: 'none' } }, (socket) => {
      const conn = { socket, user: null, channels: new Set(), tracked: false }
      conn.authTimer = setTimeout(() => { if (!conn.user) socket.close(4401, 'auth timeout') }, AUTH_TIMEOUT_MS)

      socket.on('message', (data) => {
        handleMessage(conn, data.toString()).catch((err) => log.error(err))
      })
      socket.on('close', () => {
        clearTimeout(conn.authTimer)
        setTracked(conn, false)
        for (const channel of [...conn.channels]) removeFromChannel(conn, channel)
      })
    })

    // Détection des connexions mortes.
    const heartbeat = setInterval(() => {
      for (const client of app.websocketServer.clients) {
        if (client.isAlive === false) { client.terminate(); continue }
        client.isAlive = false
        client.ping()
      }
    }, HEARTBEAT_MS)
    app.websocketServer.on('connection', (client) => {
      client.isAlive = true
      client.on('pong', () => { client.isAlive = true })
    })
    app.addHook('onClose', async () => clearInterval(heartbeat))
  }

  return { name: 'ws', publish, revoke, register }
}
