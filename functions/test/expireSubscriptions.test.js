// Test d'intégration : nécessite un Postgres initialisé par `npm run db:migrate`
// et JOBS_DATABASE_URL (rôle JOBS_DB_USER). Ignoré si la variable est absente.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dbConfigFromEnv, expireLapsedSubscriptions } from '../src/expireSubscriptions.js'

const config = dbConfigFromEnv()

test('dbConfigFromEnv : SSL activé par défaut', () => {
  assert.equal(dbConfigFromEnv({ JOBS_DATABASE_URL: 'x' }).ssl, true)
  assert.equal(dbConfigFromEnv({ JOBS_DATABASE_URL: 'x', JOBS_DATABASE_SSL: 'false' }).ssl, false)
})

test('expireLapsedSubscriptions renvoie un nombre', { skip: !config.connectionString && 'JOBS_DATABASE_URL absent' }, async () => {
  const expired = await expireLapsedSubscriptions(config)
  assert.equal(typeof expired, 'number')
})

test('sans JOBS_DATABASE_URL : erreur explicite', async () => {
  await assert.rejects(expireLapsedSubscriptions({ connectionString: '', ssl: false }), /JOBS_DATABASE_URL/)
})
