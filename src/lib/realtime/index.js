/**
 * Temps réel — interface commune à tous les fournisseurs.
 *
 *   const off = realtime.subscribe('feed', (event, payload) => { … })   // → fonction de désabonnement
 *   realtime.setPresence(true | false)   // apparaître (ou non) dans la liste des utilisateurs en ligne
 *   realtime.disconnect()                // à la déconnexion de l'utilisateur
 *
 * Canaux : feed, global-chat, site-settings, presence, forum-post:<id>,
 *          dm:<userId>, user:<userId>, group:<groupId> (droits vérifiés par l'API).
 *
 * Le fournisseur est indiqué par l'API (GET /api/realtime/negotiate) :
 * 'ws' = WebSocket intégré à l'API. Azure Web PubSub viendra plus tard.
 */
import { createWebSocketClient } from './wsClient.js'

export const realtime = createWebSocketClient()
