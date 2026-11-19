// Initialise ou met à jour la base de données, de façon idempotente.
//
//   npm run db:migrate            local ou base distante (Azure Database for PostgreSQL)
//   npm run db:migrate -- --reset supprime d'abord les schémas public et auth
//                                 (refusé si NODE_ENV=production ou DATABASE_SSL=true)
//
// Étapes :
//   1. db/schema.sql — appliqué uniquement si la base est vierge
//      (ce n'est pas un système de migrations versionnées : une modification
//      future du schéma devra être appliquée par un script dédié) ;
//   2. db/seed.sql — rejoué à chaque fois (inserts ON CONFLICT DO NOTHING) ;
//   3. rôle applicatif de l'API (API_DB_USER / API_DB_PASSWORD) — créé ou mis à jour ;
//   4. rôle des tâches planifiées (JOBS_DB_USER / JOBS_DB_PASSWORD) — optionnel.
//
// Variables :
//   DATABASE_ADMIN_URL  connexion propriétaire (superuser en local, compte admin
//                       du serveur Azure en prod). Jamais utilisée par l'API.
//   DATABASE_SSL        true pour imposer TLS (obligatoire sur Azure)
//   API_DB_USER, API_DB_PASSWORD    rôle de l'API → DATABASE_URL d'App Service
//   JOBS_DB_USER, JOBS_DB_PASSWORD  rôle de la Function timer (optionnel)
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import pg from 'pg'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
if (existsSync(path.join(repoRoot, '.env'))) dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true })

const env = process.env
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1) }
const isTrue = (v) => ['1', 'true', 'yes'].includes(String(v).toLowerCase())

if (!env.DATABASE_ADMIN_URL) fail('DATABASE_ADMIN_URL est requis.')
if (!env.API_DB_USER || !env.API_DB_PASSWORD) fail('API_DB_USER et API_DB_PASSWORD sont requis.')
if (Boolean(env.JOBS_DB_USER) !== Boolean(env.JOBS_DB_PASSWORD)) fail('JOBS_DB_USER et JOBS_DB_PASSWORD vont ensemble.')

const ssl = isTrue(env.DATABASE_SSL)
const reset = process.argv.includes('--reset')
if (reset && (env.NODE_ENV === 'production' || ssl)) fail('--reset est réservé à une base locale.')

const client = new pg.Client({ connectionString: env.DATABASE_ADMIN_URL, ssl: ssl ? { rejectUnauthorized: true } : undefined })
await client.connect()
const ident = (v) => client.escapeIdentifier(v)
const literal = (v) => client.escapeLiteral(v)

/** Crée ou met à jour un rôle de connexion non-superuser, sans droit hérité. */
async function ensureLoginRole(name, password) {
  const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name])
  const attrs = `LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${literal(password)}`
  await client.query(`${rowCount ? 'ALTER' : 'CREATE'} ROLE ${ident(name)} ${attrs}`)
  console.log(`✓ Rôle « ${name} » ${rowCount ? 'mis à jour' : 'créé'}.`)
}

try {
  if (reset) {
    console.log('↺ Suppression des schémas public et auth…')
    await client.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA public;')
  }

  // 1. Schéma
  const { rows: [{ exists }] } = await client.query("SELECT to_regclass('public.profiles') IS NOT NULL AS exists")
  if (exists) {
    console.log('✓ Schéma déjà présent — non réappliqué.')
  } else {
    await client.query(await readFile(path.join(repoRoot, 'db/schema.sql'), 'utf8'))
    console.log('✓ Schéma appliqué (db/schema.sql).')
  }

  // 2. Seed (idempotent)
  await client.query(await readFile(path.join(repoRoot, 'db/seed.sql'), 'utf8'))
  console.log('✓ Seed appliqué (db/seed.sql).')

  const { rows: [{ db }] } = await client.query('SELECT current_database() AS db')

  // 3. Rôle applicatif de l'API : endosse anon/authenticated à chaque
  //    transaction (SET LOCAL ROLE) ; les policies RLS s'appliquent.
  await ensureLoginRole(env.API_DB_USER, env.API_DB_PASSWORD)
  await client.query(`GRANT anon, authenticated TO ${ident(env.API_DB_USER)}`)
  await client.query(`GRANT CONNECT ON DATABASE ${ident(db)} TO ${ident(env.API_DB_USER)}`)

  // 4. Rôle des tâches planifiées : peut uniquement exécuter
  //    expire_lapsed_subscriptions() (SECURITY DEFINER), aucun accès aux tables.
  if (env.JOBS_DB_USER) {
    await ensureLoginRole(env.JOBS_DB_USER, env.JOBS_DB_PASSWORD)
    await client.query(`GRANT CONNECT ON DATABASE ${ident(db)} TO ${ident(env.JOBS_DB_USER)}`)
    await client.query(`GRANT USAGE ON SCHEMA public TO ${ident(env.JOBS_DB_USER)}`)
    await client.query(`GRANT EXECUTE ON FUNCTION public.expire_lapsed_subscriptions() TO ${ident(env.JOBS_DB_USER)}`)
  }

  console.log(`✓ Base « ${db} » prête.`)
} finally {
  await client.end()
}
