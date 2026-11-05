// Accès PostgreSQL.
//
// L'API se connecte avec un rôle non-superuser (NOINHERIT) qui n'a aucun droit
// direct sur les tables. Chaque requête s'exécute dans une transaction qui
// endosse le rôle `authenticated` (ou `anon`) et positionne l'identifiant
// utilisateur lu par auth.uid() : les policies RLS existantes s'appliquent.
import pg from 'pg'
import { config } from './config.js'

// bigint (int8) et count(*) → number (les identifiants restent < 2^53).
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)))

export const pool = new pg.Pool({
  connectionString: config.database.url,
  ssl: config.database.ssl ? { rejectUnauthorized: true } : undefined,
  max: config.database.poolMax,
})

/**
 * Exécute `fn(client)` dans une transaction RLS.
 * @param {string|null} userId  identifiant utilisateur (uuid) ou null pour anon
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
export async function withRls(userId, fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(userId ? 'SET LOCAL ROLE authenticated' : 'SET LOCAL ROLE anon')
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userId || ''])
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function closePool() {
  await pool.end()
}
