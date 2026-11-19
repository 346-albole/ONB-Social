// Upload de fichiers (multipart) via l'adaptateur de stockage.
//
//   POST /api/files   champ `kind` puis champ fichier `file`
//   → 201 { url, key }
//
// L'URL renvoyée est enregistrée telle quelle en base par le front
// (posts.media_url, profiles.avatar_url, …).
import { randomUUID } from 'node:crypto'
import multipart from '@fastify/multipart'
import { config } from '../config.js'
import { badRequest } from '../errors.js'

// Types autorisés (pas de SVG ni de HTML : contenu actif servi depuis notre origine).
const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-m4v': 'm4v',
}

// Usage → dossier et types acceptés.
const KINDS = {
  post: { dir: 'posts', accept: /^image\// },
  reel: { dir: 'reels', accept: /^video\// },
  avatar: { dir: 'avatars', accept: /^(image|video)\// },
  banner: { dir: 'banners', accept: /^image\// },
  badge: { dir: 'badges', accept: /^image\// },
  'chat-bg': { dir: 'chatbg', accept: /^image\// },
  dm: { dir: 'chat', accept: /^image\// },
  forum: { dir: 'forum', accept: /^image\// },
  'group-banner': { dir: 'group-banners', accept: /^image\// },
}

export default async function fileRoutes(app, { storage }) {
  await app.register(multipart, {
    limits: { fileSize: config.storage.maxUploadBytes, files: 1, fields: 2 },
  })

  app.post('/', async (request, reply) => {
    if (!request.isMultipart()) throw badRequest('Requête multipart attendue')

    let kind = null
    for await (const part of request.parts()) {
      if (part.type === 'field') {
        if (part.fieldname === 'kind') kind = String(part.value)
        continue
      }
      // Le champ `kind` doit précéder le fichier.
      const spec = KINDS[kind]
      if (!spec) { part.file.resume(); throw badRequest(`kind invalide : ${kind}`) }
      const ext = MIME_EXT[part.mimetype]
      if (!ext || !spec.accept.test(part.mimetype)) {
        part.file.resume()
        throw badRequest(`Type de fichier refusé pour « ${kind} » : ${part.mimetype}`)
      }

      const key = `${spec.dir}/${request.user.id}/${randomUUID()}.${ext}`
      const stored = await storage.put(key, part.file, { contentType: part.mimetype })
      if (part.file.truncated) {
        await storage.delete(key)
        throw badRequest(`Fichier trop volumineux (max ${Math.round(config.storage.maxUploadBytes / 1048576)} Mo)`)
      }
      return reply.code(201).send(stored)
    }
    throw badRequest('Aucun fichier reçu')
  })
}
