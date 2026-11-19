// Stockage sur disque local : fichiers dans MEDIA_DIR, servis par l'API sous
// MEDIA_PUBLIC_PATH (par défaut /media). En prod App Service : /home/data/media.
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import fastifyStatic from '@fastify/static'

export function createLocalDiskStorage({ mediaDir, publicPath }) {
  const root = path.resolve(mediaDir)
  const prefix = `/${publicPath.replace(/^\/+|\/+$/g, '')}`

  function resolveKey(key) {
    const target = path.resolve(root, key)
    if (!target.startsWith(root + path.sep)) throw new Error(`Clé de fichier invalide : ${key}`)
    return target
  }

  return {
    name: 'local',

    async put(key, stream) {
      const target = resolveKey(key)
      await mkdir(path.dirname(target), { recursive: true })
      try {
        await pipeline(stream, createWriteStream(target, { flags: 'wx' }))
      } catch (err) {
        await rm(target, { force: true })
        throw err
      }
      return { key, url: this.getUrl(key) }
    },

    getUrl(key) {
      return `${prefix}/${key.split('/').map(encodeURIComponent).join('/')}`
    },

    async delete(key) {
      await rm(resolveKey(key), { force: true })
    },

    // Service des fichiers (cache long : chaque clé est unique et immuable).
    async register(app) {
      await mkdir(root, { recursive: true })
      await app.register(fastifyStatic, {
        root,
        prefix: `${prefix}/`,
        decorateReply: false,
        index: false,
        dotfiles: 'deny',
        cacheControl: false,
        setHeaders(reply) {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable')
          reply.header('X-Content-Type-Options', 'nosniff')
        },
      })
    },
  }
}
