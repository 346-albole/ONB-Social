// Construction de l'application Fastify.
import { createRequire } from 'node:module'
import Fastify from 'fastify'
import { config } from './config.js'
import { pool } from './db.js'
import { errorHandler, notFound } from './errors.js'
import authPlugin from './auth/plugin.js'
import devAuthRoutes from './auth/devProvider.js'
import meRoutes from './routes/me.js'
import profileRoutes from './routes/profiles.js'
import postRoutes, { commentRoutes } from './routes/posts.js'
import contentRoutes from './routes/content.js'
import messageRoutes from './routes/messages.js'
import globalChatRoutes from './routes/globalChat.js'
import groupRoutes from './routes/groups.js'
import forumRoutes from './routes/forum.js'
import siteRoutes from './routes/site.js'
import adminRoutes from './routes/admin.js'
import staticFrontend from './static.js'

// Logs lisibles en dev (pino-pretty, devDependency) ; JSON brut en production.
function loggerOptions() {
  const options = { level: config.logLevel }
  if (config.isProduction) return options
  try {
    createRequire(import.meta.url).resolve('pino-pretty')
    options.transport = { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
  } catch { /* pino-pretty absent : JSON */ }
  return options
}

export async function buildApp() {
  const app = Fastify({
    logger: loggerOptions(),
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
    await api.register(contentRoutes)
    await api.register(messageRoutes)
    await api.register(globalChatRoutes, { prefix: '/global-messages' })
    await api.register(groupRoutes, { prefix: '/groups' })
    await api.register(forumRoutes, { prefix: '/forum' })
    await api.register(siteRoutes)
    await api.register(adminRoutes, { prefix: '/admin' })

    // 404 JSON pour toute route /api inconnue (pas de fallback SPA ici).
    api.setNotFoundHandler(() => { throw notFound('Route inconnue') })
  }, { prefix: '/api' })

  await app.register(staticFrontend)

  return app
}
