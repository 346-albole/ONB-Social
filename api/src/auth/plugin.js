// Authentification des routes /api.
//
// Chaque route déclare son niveau dans `config.auth` :
//   'required' (défaut) — token valide obligatoire, profil créé si besoin
//   'optional'          — token lu s'il est présent
//   'none'              — aucune vérification (health, fournisseur dev…)
//
// Expose sur la requête :
//   request.user   — { id, email, name, username, claims } ou null
//   request.tx(fn) — transaction RLS au nom de l'utilisateur (ou anon)
import fp from 'fastify-plugin'
import { withRls } from '../db.js'
import { unauthorized } from '../errors.js'
import { bearerToken, verifyAccessToken } from './jwt.js'
import { ensureProfile } from './profile.js'

async function authPlugin(app) {
  app.decorateRequest('user', null)
  app.decorateRequest('tx', null)

  app.addHook('onRequest', async (request) => {
    request.tx = (fn) => withRls(request.user?.id ?? null, fn)

    const level = request.routeOptions.config?.auth ?? 'required'
    if (level === 'none') return

    const token = bearerToken(request.headers.authorization)
    if (!token) {
      if (level === 'required') throw unauthorized()
      return
    }

    const identity = await verifyAccessToken(token)
    await ensureProfile(identity)
    request.user = identity
  })
}

export default fp(authPlugin, { name: 'auth' })
