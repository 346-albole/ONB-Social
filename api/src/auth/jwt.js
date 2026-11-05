// Validation générique d'un JWT d'accès : signature via JWKS distant, issuer,
// audience, expiration. Aucun code spécifique à un fournisseur : la même
// configuration fonctionne avec le fournisseur dev local et avec Entra ID
// (AUTH_ISSUER = https://login.microsoftonline.com/<tenant>/v2.0, etc.).
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { config } from '../config.js'
import { unauthorized } from '../errors.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let jwks = null
function getJwks() {
  // Créé à la première utilisation : en mode dev, l'URL JWKS est servie par
  // cette même API, qui doit donc déjà écouter.
  if (!jwks) jwks = createRemoteJWKSet(new URL(config.auth.jwksUrl))
  return jwks
}

/**
 * Vérifie un token et retourne l'identité normalisée.
 * @returns {Promise<{ id: string, email: string|null, name: string|null, username: string|null, claims: object }>}
 */
export async function verifyAccessToken(token) {
  let payload
  try {
    ;({ payload } = await jwtVerify(token, getJwks(), {
      issuer: config.auth.issuer,
      audience: config.auth.audience,
      clockTolerance: config.auth.clockTolerance,
    }))
  } catch (err) {
    throw unauthorized(`Token invalide : ${err.code || err.message}`)
  }

  const id = payload[config.auth.userIdClaim]
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw unauthorized(`Claim « ${config.auth.userIdClaim} » absent ou non GUID`)
  }

  const email = payload.email || (String(payload.preferred_username || '').includes('@') ? payload.preferred_username : null)
  return {
    id: id.toLowerCase(),
    email: email || null,
    name: payload.name || null,
    username: payload.preferred_username || payload.name || email || null,
    claims: payload,
  }
}

/** Extrait le token Bearer d'un en-tête Authorization. */
export function bearerToken(header) {
  if (!header) return null
  const [scheme, token] = header.split(' ')
  return scheme?.toLowerCase() === 'bearer' && token ? token : null
}
