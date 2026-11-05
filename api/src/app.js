// Construction de l'application Fastify.
import Fastify from 'fastify'
import { config } from './config.js'
import { pool } from './db.js'
import { errorHandler, notFound } from './errors.js'
import authPlugin from './auth/plugin.js'
import devAuthRoutes from './auth/devProvider.js'
import meRoutes from './routes/me.js'
import profileRoutes from './routes/profiles.js'
import postRoutes, { commentRoutes } from './routes/posts.js'
import staticFrontend from './static.js'

export async function buildApp() {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true, // derrière le frontal d'App Service
    bodyLimit: 1024 * 1024,
    ajv: { customOptions: { coerceTypes: true, removeAdditional: false } },
  })

  app.setErrorHandler(errorHandler)

  await app.register(async (api) => {
    await api.register(authPlugin)

    api.get('/health', { config: { auth: 'none' } }, async () => {
      await pool.query('SELECT 1')
      return { status: 'ok' }
    })

    if (config.devAuth.enabled) {
      await api.register(devAuthRoutes, { prefix: '/dev-auth' })
    }

    await api.register(meRoutes, { prefix: '/me' })
    await api.register(profileRoutes, { prefix: '/profiles' })
    await api.register(postRoutes, { prefix: '/posts' })
    await api.register(commentRoutes, { prefix: '/comments' })

    // 404 JSON pour toute route /api inconnue (pas de fallback SPA ici).
    api.setNotFoundHandler(() => { throw notFound('Route inconnue') })
  }, { prefix: '/api' })

  await app.register(staticFrontend)

  return app
}
