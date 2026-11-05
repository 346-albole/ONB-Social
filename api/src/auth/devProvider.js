// Fournisseur de tokens de développement — actif seulement si DEV_AUTH_ENABLED=true.
//
// Remplace localement le fournisseur d'identité (Entra ID plus tard) :
//   POST /api/dev-auth/login     { username } → { access_token, expires_in, user }
//   GET  /api/dev-auth/jwks.json              → clé publique (JWKS)
//
// Les tokens sont validés par le même code que ceux d'Entra (auth/jwt.js), via
// AUTH_ISSUER / AUTH_AUDIENCE / AUTH_JWKS_URL. L'identifiant (claim `oid` par
// défaut) est un UUID v5 dérivé du nom : même nom → même utilisateur.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SignJWT, exportJWK, generateKeyPair, importJWK } from 'jose'
import { config } from '../config.js'
import { badRequest } from '../errors.js'

const ALG = 'ES256'
// Espace de noms arbitraire et fixe pour les UUID v5 du mode dev.
const DEV_NAMESPACE = '6f6e622d-736f-6369-616c-2d6465762d31'

function uuidV5(name, namespace = DEV_NAMESPACE) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const hash = createHash('sha1').update(ns).update(name, 'utf8').digest()
  hash[6] = (hash[6] & 0x0f) | 0x50
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// Clé de signature locale, générée au premier démarrage et conservée dans un
// fichier ignoré par git (les tokens restent valides après redémarrage).
async function loadOrCreateKey(file) {
  try {
    const jwk = JSON.parse(await readFile(file, 'utf8'))
    const { d, ...publicJwk } = jwk
    return { privateKey: await importJWK(jwk, ALG), publicJwk }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true })
  const privateJwk = await exportJWK(privateKey)
  const publicJwk = await exportJWK(publicKey)
  const kid = createHash('sha256').update(JSON.stringify(publicJwk)).digest('base64url').slice(0, 16)
  Object.assign(privateJwk, { kid, alg: ALG, use: 'sig' })
  Object.assign(publicJwk, { kid, alg: ALG, use: 'sig' })
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(privateJwk), { mode: 0o600 })
  return { privateKey, publicJwk }
}

export default async function devAuthRoutes(app) {
  const { privateKey, publicJwk } = await loadOrCreateKey(config.devAuth.keyFile)
  app.log.warn('Fournisseur d’auth DEV actif — ne pas utiliser en production')

  app.get('/jwks.json', { config: { auth: 'none' } }, async () => ({ keys: [publicJwk] }))

  app.post('/login', {
    config: { auth: 'none' },
    schema: {
      body: {
        type: 'object',
        required: ['username'],
        additionalProperties: false,
        properties: { username: { type: 'string', minLength: 1, maxLength: 40 } },
      },
    },
  }, async (request) => {
    const username = request.body.username.trim()
    if (!/^[\w.-]+$/.test(username)) {
      throw badRequest('Nom d’utilisateur : lettres, chiffres, « _ », « . » ou « - » uniquement')
    }
    const id = uuidV5(username.toLowerCase())
    const email = `${username.toLowerCase()}@dev.local`
    const ttl = config.devAuth.tokenTtlSeconds

    const accessToken = await new SignJWT({
      [config.auth.userIdClaim]: id,
      preferred_username: username,
      name: username,
      email,
    })
      .setProtectedHeader({ alg: ALG, kid: publicJwk.kid, typ: 'JWT' })
      .setIssuer(config.auth.issuer)
      .setAudience(config.auth.audience)
      .setSubject(id)
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`)
      .sign(privateKey)

    return { access_token: accessToken, token_type: 'Bearer', expires_in: ttl, user: { id, username, email } }
  })
}
