// Chat global.
import { notFound } from '../errors.js'
import { bigintParam, jsonObject } from './shared.js'

const SENDER_COLUMNS = ['id', 'username', 'avatar_url', 'username_color', 'is_premium', 'is_official', 'is_admin', 'is_anonymous']
const MESSAGE_SELECT = `
  SELECT g.*, ${jsonObject('p', SENDER_COLUMNS)} AS profiles
    FROM public.global_messages g JOIN public.profiles p ON p.id = g.sender_id`

export async function fetchGlobalMessage(client, id) {
  const { rows } = await client.query(`${MESSAGE_SELECT} WHERE g.id = $1`, [id])
  return rows[0] || null
}

const contentBody = {
  type: 'object',
  required: ['content'],
  additionalProperties: false,
  properties: { content: { type: 'string', minLength: 1, maxLength: 500 } },
}

export default async function globalChatRoutes(app) {
  // 200 derniers messages non supprimés, ordre chronologique.
  app.get('/', async (request) => {
    return request.tx(async (c) => {
      const { rows } = await c.query(
        `SELECT * FROM (${MESSAGE_SELECT} WHERE g.deleted = false ORDER BY g.created_at DESC LIMIT 200) t
          ORDER BY created_at ASC`,
      )
      return rows
    })
  })

  app.post('/', { schema: { body: contentBody } }, async (request, reply) => {
    const message = await request.tx(async (c) => {
      const { rows } = await c.query(
        'INSERT INTO public.global_messages (sender_id, content) VALUES ($1, $2) RETURNING id',
        [request.user.id, request.body.content.trim()],
      )
      return fetchGlobalMessage(c, rows[0].id)
    })
    return reply.code(201).send(message)
  })

  // Édition : auteur uniquement.
  app.patch('/:id', { schema: { params: bigintParam(), body: contentBody } }, async (request) => {
    const message = await request.tx(async (c) => {
      const { rowCount } = await c.query(
        `UPDATE public.global_messages SET content = $3, edited = true
          WHERE id = $1 AND sender_id = $2 AND deleted = false`,
        [request.params.id, request.user.id, request.body.content.trim()],
      )
      return rowCount ? fetchGlobalMessage(c, request.params.id) : null
    })
    if (!message) throw notFound('Message introuvable ou non autorisé')
    return message
  })

  // Suppression logique : auteur ou admin (RLS).
  // Pas de RETURNING : la policy SELECT masque les messages supprimés.
  app.delete('/:id', { schema: { params: bigintParam() } }, async (request, reply) => {
    const { rowCount } = await request.tx((c) => c.query(
      'UPDATE public.global_messages SET deleted = true WHERE id = $1 AND deleted = false', [request.params.id]))
    if (!rowCount) throw notFound('Message introuvable ou non autorisé')
    return reply.code(204).send()
  })
}
