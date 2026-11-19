// Tâche : expiration des abonnements premium / officiel arrivés à échéance.
// Isolée du déclencheur pour pouvoir être testée sans le runtime Functions.
import pg from 'pg'

/**
 * Exécute SELECT public.expire_lapsed_subscriptions() avec le rôle dédié
 * JOBS_DB_USER (droit EXECUTE sur cette seule fonction, aucun accès aux tables).
 *
 * @param {{ connectionString: string, ssl: boolean }} db
 * @returns {Promise<number|null>} nombre d'abonnements expirés, ou null si la
 *   fonction SQL ne renvoie rien (ancienne version RETURNS void)
 */
export async function expireLapsedSubscriptions({ connectionString, ssl }) {
  if (!connectionString) throw new Error('JOBS_DATABASE_URL est requis')
  const client = new pg.Client({
    connectionString,
    // Azure Database for PostgreSQL impose TLS ; certificat vérifié.
    ssl: ssl ? { rejectUnauthorized: true } : undefined,
    connectionTimeoutMillis: 15_000,
    query_timeout: 60_000,
    application_name: 'onb-social-functions',
  })
  await client.connect()
  try {
    const { rows } = await client.query('SELECT public.expire_lapsed_subscriptions() AS expired')
    const expired = rows[0]?.expired
    return expired === null || expired === undefined ? null : Number(expired)
  } finally {
    await client.end()
  }
}

/** Lit la configuration dans les variables d'environnement (app settings). */
export function dbConfigFromEnv(env = process.env) {
  return {
    connectionString: env.JOBS_DATABASE_URL,
    // SSL par défaut (Azure) ; JOBS_DATABASE_SSL=false pour un Postgres local.
    ssl: !['0', 'false', 'no', 'off'].includes(String(env.JOBS_DATABASE_SSL ?? 'true').toLowerCase()),
  }
}
