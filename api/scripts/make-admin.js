// Donne (ou retire) les droits admin à un utilisateur existant.
//
//   npm run db:make-admin -- <username>
//   npm run db:make-admin -- <username> --revoke
//
// L'utilisateur doit s'être connecté au moins une fois (le profil est créé à
// la première requête authentifiée). Utilise DATABASE_ADMIN_URL.
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import pg from 'pg'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
if (existsSync(path.join(repoRoot, '.env'))) dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true })

const username = process.argv.slice(2).find((a) => !a.startsWith('--'))
const revoke = process.argv.includes('--revoke')
if (!username || !process.env.DATABASE_ADMIN_URL) {
  console.error('Usage : npm run db:make-admin -- <username> [--revoke]   (DATABASE_ADMIN_URL requis)')
  process.exit(1)
}

const ssl = ['1', 'true', 'yes'].includes(String(process.env.DATABASE_SSL).toLowerCase()) ? { rejectUnauthorized: true } : undefined
const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL, ssl })
await client.connect()
try {
  const { rows } = await client.query(
    'UPDATE public.profiles SET is_admin = $2, updated_at = now() WHERE username = $1 RETURNING id, username, is_admin',
    [username, !revoke],
  )
  if (!rows.length) {
    console.error(`Aucun profil « ${username} ». L'utilisateur doit s'être connecté au moins une fois.`)
    process.exitCode = 1
  } else {
    console.log(`✓ ${rows[0].username} (${rows[0].id}) : is_admin = ${rows[0].is_admin}`)
  }
} finally {
  await client.end()
}
