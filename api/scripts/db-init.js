// Initialise la base de données : schéma, seed et rôle de connexion de l'API.
//
//   npm run db:init            applique db/schema.sql + db/seed.sql si la base
//                              est vierge, puis crée/met à jour le rôle API
//   npm run db:init -- --reset supprime d'abord les schémas public et auth
//                              (refusé si NODE_ENV=production)
//
// Variables :
//   DATABASE_ADMIN_URL  connexion propriétaire (superuser en local, admin du
//                       serveur Azure Database for PostgreSQL en prod)
//   DATABASE_URL        connexion de l'API : l'utilisateur et le mot de passe
//                       de cette URL définissent le rôle créé
//   DATABASE_SSL        true pour imposer TLS (Azure)
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import dotenv from 'dotenv'
import pg from 'pg'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
if (existsSync(path.join(repoRoot, '.env'))) dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true })

const { DATABASE_ADMIN_URL, DATABASE_URL, DATABASE_SSL, NODE_ENV } = process.env
if (!DATABASE_ADMIN_URL || !DATABASE_URL) {
  console.error('DATABASE_ADMIN_URL et DATABASE_URL sont requis.')
  process.exit(1)
}

const reset = process.argv.includes('--reset')
if (reset && NODE_ENV === 'production') {
  console.error('--reset est refusé quand NODE_ENV=production.')
  process.exit(1)
}

const apiUrl = new URL(DATABASE_URL)
const apiUser = decodeURIComponent(apiUrl.username)
const apiPassword = decodeURIComponent(apiUrl.password)
if (!apiUser || !apiPassword) {
  console.error('DATABASE_URL doit contenir un utilisateur et un mot de passe.')
  process.exit(1)
}

const ssl = ['1', 'true', 'yes'].includes(String(DATABASE_SSL).toLowerCase()) ? { rejectUnauthorized: true } : undefined
const client = new pg.Client({ connectionString: DATABASE_ADMIN_URL, ssl })
await client.connect()

try {
  if (reset) {
    console.log('↺ Suppression des schémas public et auth…')
    await client.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA public;')
  }

  const { rows } = await client.query("SELECT to_regclass('public.profiles') IS NOT NULL AS exists")
  if (rows[0].exists) {
    console.log('✓ Schéma déjà présent — non réappliqué (utiliser --reset pour repartir de zéro).')
  } else {
    for (const file of ['db/schema.sql', 'db/seed.sql']) {
      console.log(`→ ${file}`)
      await client.query(await readFile(path.join(repoRoot, file), 'utf8'))
    }
    console.log('✓ Schéma et seed appliqués.')
  }

  // Rôle de connexion de l'API : non-superuser, NOINHERIT (aucun droit direct ;
  // l'API endosse `authenticated` ou `anon` dans chaque transaction).
  const ident = (v) => client.escapeIdentifier(v)
  const literal = (v) => client.escapeLiteral(v)
  const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [apiUser])
  if (rowCount) {
    await client.query(`ALTER ROLE ${ident(apiUser)} LOGIN NOINHERIT NOSUPERUSER PASSWORD ${literal(apiPassword)}`)
    console.log(`✓ Rôle API « ${apiUser} » mis à jour.`)
  } else {
    await client.query(`CREATE ROLE ${ident(apiUser)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${literal(apiPassword)}`)
    console.log(`✓ Rôle API « ${apiUser} » créé.`)
  }
  await client.query(`GRANT anon, authenticated TO ${ident(apiUser)}`)
  const { rows: [{ db }] } = await client.query('SELECT current_database() AS db')
  await client.query(`GRANT CONNECT ON DATABASE ${ident(db)} TO ${ident(apiUser)}`)
  console.log('✓ Base prête.')
} finally {
  await client.end()
}
