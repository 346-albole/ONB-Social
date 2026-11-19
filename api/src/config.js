// Configuration de l'API — exclusivement par variables d'environnement.
// En local, le fichier `.env` à la racine du dépôt est chargé s'il existe ;
// en production (App Service), les variables viennent des « App settings ».
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import dotenv from 'dotenv'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const envFile = path.join(repoRoot, '.env')
if (existsSync(envFile)) dotenv.config({ path: envFile, quiet: true })

// `npm start` passe --production : force le mode production (multi-plateforme,
// sans dépendre de la syntaxe VAR=valeur du shell). En local : `npm run dev`.
if (process.argv.includes('--production')) process.env.NODE_ENV = 'production'

const env = process.env

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

function required(name) {
  const value = env[name]
  if (!value) throw new Error(`Variable d'environnement manquante : ${name}`)
  return value
}

function resolveDir(value, fallback) {
  return path.resolve(repoRoot, value || fallback)
}

const isProduction = env.NODE_ENV === 'production'
const port = Number(env.PORT || 3000)

const devAuthEnabled = bool(env.DEV_AUTH_ENABLED)
if (devAuthEnabled && isProduction) {
  throw new Error('Auth dev refusée en production : DEV_AUTH_ENABLED doit être false (utiliser `npm run dev` en local).')
}

export const config = {
  repoRoot,
  isProduction,
  host: env.HOST || '0.0.0.0',
  port,
  logLevel: env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),

  database: {
    url: required('DATABASE_URL'),
    ssl: bool(env.DATABASE_SSL),
    poolMax: Number(env.DATABASE_POOL_MAX || 10),
  },

  auth: {
    issuer: required('AUTH_ISSUER'),
    audience: required('AUTH_AUDIENCE'),
    jwksUrl: required('AUTH_JWKS_URL'),
    // Claim portant l'identifiant utilisateur (GUID) → profiles.id
    userIdClaim: env.AUTH_USER_ID_CLAIM || 'oid',
    // Tolérance d'horloge pour exp/nbf (secondes)
    clockTolerance: Number(env.AUTH_CLOCK_TOLERANCE || 60),
    // Scope exigé dans le claim `scp` (ex. access_as_user pour Entra ID) ; vide = pas de contrôle
    requiredScope: env.AUTH_REQUIRED_SCOPE || '',
  },

  devAuth: {
    enabled: devAuthEnabled,
    keyFile: resolveDir(env.DEV_AUTH_KEY_FILE, 'api/.dev-auth/signing-key.json'),
    tokenTtlSeconds: Number(env.DEV_AUTH_TOKEN_TTL || 12 * 3600),
  },

  // Front buildé (vite build) servi par l'API, avec fallback SPA.
  staticDir: resolveDir(env.STATIC_DIR, 'dist'),

  // Adaptateur de stockage de fichiers (voir api/src/storage).
  storage: {
    provider: env.STORAGE_PROVIDER || 'local',
    // Disque local : dossier des médias (prod App Service : /home/data/media)
    mediaDir: resolveDir(env.MEDIA_DIR, 'data/media'),
    // Préfixe d'URL sous lequel l'API sert les médias
    publicPath: env.MEDIA_PUBLIC_PATH || '/media',
    maxUploadBytes: Number(env.MAX_UPLOAD_MB || 50) * 1024 * 1024,
  },

  // Adaptateur temps réel (voir api/src/realtime).
  realtime: {
    provider: env.REALTIME_PROVIDER || 'ws',
  },
}
