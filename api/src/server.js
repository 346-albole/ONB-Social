// Point d'entrée : `npm start` (production) ou `npm run dev:api`.
import { config } from './config.js'
import { closePool } from './db.js'
import { buildApp } from './app.js'

const app = await buildApp()

async function shutdown(signal) {
  app.log.info({ signal }, 'Arrêt en cours')
  try {
    await app.close()
    await closePool()
  } finally {
    process.exit(0)
  }
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

try {
  await app.listen({ host: config.host, port: config.port })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
