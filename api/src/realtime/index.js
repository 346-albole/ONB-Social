// Adaptateur temps réel.
//
// Interface (toute implémentation doit la fournir) :
//   publish(channel, event, payload)  diffuse un événement aux abonnés du canal
//   revoke(channel, userId)           retire l'abonnement d'un utilisateur (ex. exclu d'un groupe)
//   register(app)                     routes : GET /realtime/negotiate (+ transport éventuel)
//
// Canaux et droits d'abonnement (vérifiés côté serveur) :
//   feed, global-chat, site-settings, presence, forum-post:<id>  → tout utilisateur connecté
//   dm:<userId>, user:<userId>                                   → l'utilisateur lui-même
//   group:<groupId>                                              → membres du groupe et admins
//
// Implémentations : 'ws' (WebSocket intégré à l'API, même port). Azure Web
// PubSub viendra plus tard (REALTIME_PROVIDER=web-pubsub, voir PORTAGE_AZURE.md) :
// canal = groupe Web PubSub, publish = sendToGroup, negotiate = URL client signée.
import { config } from '../config.js'
import { withRls } from '../db.js'
import { createWebSocketRealtime } from './websocket.js'

const PROVIDERS = {
  ws: createWebSocketRealtime,
}

const OPEN_CHANNELS = new Set(['feed', 'global-chat', 'site-settings', 'presence'])

/**
 * Autorisation d'abonnement à un canal (commune à toutes les implémentations).
 * @returns {Promise<boolean>}
 */
export async function canSubscribe(userId, channel) {
  if (OPEN_CHANNELS.has(channel)) return true
  if (/^forum-post:\d+$/.test(channel)) return true

  const [kind, id] = channel.split(':')
  if ((kind === 'dm' || kind === 'user') && id) return id === userId

  if (kind === 'group' && /^[0-9a-f-]{36}$/i.test(id || '')) {
    return withRls(userId, async (c) => {
      const { rows } = await c.query(
        `SELECT EXISTS (SELECT 1 FROM public.group_members WHERE group_id = $1 AND user_id = $2)
                OR public.is_admin($2) AS ok`,
        [id, userId],
      )
      return rows[0].ok
    })
  }
  return false
}

export function createRealtime(log) {
  const factory = PROVIDERS[config.realtime.provider]
  if (!factory) throw new Error(`REALTIME_PROVIDER inconnu : ${config.realtime.provider}`)
  return factory({ log, canSubscribe })
}
