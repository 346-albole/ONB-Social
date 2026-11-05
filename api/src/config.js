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
if (devAuthEnabled && isProduction && !bool(env.DEV_AUTH_ALLOW_IN_PRODUCTION)) {
  throw new Error('DEV_AUTH_ENABLED=true est refusé quand NODE_ENV=production.')
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
  },

  devAuth: {
    enabled: devAuthEnabled,
    keyFile: resolveDir(env.DEV_AUTH_KEY_FILE, 'api/.dev-auth/signing-key.json'),
    tokenTtlSeconds: Number(env.DEV_AUTH_TOKEN_TTL || 12 * 3600),
  },

  // Front buildé (vite build) servi par l'API, avec fallback SPA.
  staticDir: resolveDir(env.STATIC_DIR, 'dist'),

  // Dossier des fichiers uploadés (adaptateur stockage « disque local »).
  mediaDir: resolveDir(env.MEDIA_DIR, 'data/media'),
}
