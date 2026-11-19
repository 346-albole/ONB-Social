// Service du front buildé (dist/) sur le même port que l'API, avec fallback
// SPA : toute requête GET hors /api qui ne correspond à aucun fichier renvoie
// index.html (routes vue-router en mode history).
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import fastifyStatic from '@fastify/static'
import { config } from './config.js'

export default async function staticFrontend(app) {
  const indexFile = path.join(config.staticDir, 'index.html')
  if (!existsSync(indexFile)) {
    app.log.info({ dir: config.staticDir }, 'Front buildé absent : service statique désactivé')
    return false
  }

  await app.register(fastifyStatic, {
    root: config.staticDir,
    wildcard: false,
    index: false,
    cacheControl: false,
    // `reply` Fastify (@fastify/static ≥ 10).
    setHeaders(reply, filePath) {
      // Les assets Vite sont fingerprintés ; index.html ne doit pas être mis en cache.
      const immutable = filePath.includes(`${path.sep}assets${path.sep}`)
      reply.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
    },
  })

  app.get('/*', { config: { auth: 'none' } }, (request, reply) => {
    const rel = decodeURIComponent(request.params['*'] || '')
    if (rel === 'api' || rel.startsWith('api/') || rel.startsWith(`${config.storage.publicPath.replace(/^\/+|\/+$/g, '')}/`)) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Route inconnue' } })
    }
    const target = path.resolve(config.staticDir, rel)
    if (rel && target.startsWith(config.staticDir + path.sep) && statSync(target, { throwIfNoEntry: false })?.isFile()) {
      return reply.sendFile(path.relative(config.staticDir, target))
    }
    return reply.sendFile('index.html')
  })
  return true
}
