// Messages privés (DM).
import { notFound } from '../errors.js'
import { bigintParam, uuidParam } from './shared.js'

const contentBody = {
  type: 'object',
  required: ['content'],
  additionalProperties: false,
  properties: { content: { type: 'string', minLength: 1, maxLength: 4000 } },
}

export default async function messageRoutes(app) {
  // Liste des conversations : amis mutuels + interlocuteurs, hors blocages,
  // avec dernier message et nombre de non-lus (une seule requête).
  app.get('/conversations', async (request) => {
    return request.tx(async (c) => {
      const { rows } = await c.query(
        `WITH me AS (SELECT $1::uuid AS id),
         blocked AS (
           SELECT CASE WHEN b.blocker_id = me.id THEN b.blocked_id ELSE b.blocker_id END AS id
             FROM public.blocks b, me WHERE me.id IN (b.blocker_id, b.blocked_id)
         ),
         mutuals AS (
           SELECT f1.following_id AS id FROM public.follows f1, me
             JOIN public.follows f2 ON f2.following_id = me.id
            WHERE f1.follower_id = me.id AND f2.follower_id = f1.following_id
         ),
         correspondents AS (
           SELECT DISTINCT CASE WHEN m.sender_id = me.id THEN m.receiver_id ELSE m.sender_id END AS id
             FROM public.messages m, me WHERE me.id IN (m.sender_id, m.receiver_id)
         ),
         candidates AS (
           SELECT id FROM mutuals UNION SELECT id FROM correspondents
           EXCEPT SELECT id FROM blocked
         )
         SELECT * FROM (
         SELECT p.id, p.username, p.avatar_url, p.is_premium, p.username_color,
                EXISTS (SELECT 1 FROM public.follows f, me WHERE f.follower_id = me.id AND f.following_id = p.id) AS "iFollow",
                (SELECT count(*) FROM public.messages m, me
                  WHERE m.sender_id = p.id AND m.receiver_id = me.id AND m.read = false) AS unread,
                (SELECT json_build_object('content', m.content, 'created_at', m.created_at,
                                          'image_url', m.image_url, 'sender_id', m.sender_id, 'deleted', m.deleted)
                   FROM public.messages m, me
                  WHERE (m.sender_id = me.id AND m.receiver_id = p.id) OR (m.sender_id = p.id AND m.receiver_id = me.id)
                  ORDER BY m.created_at DESC LIMIT 1) AS "lastMsg"
           FROM candidates JOIN public.profiles p ON p.id = candidates.id
         ) conv
         ORDER BY ("lastMsg"->>'created_at')::timestamptz DESC NULLS LAST, username`,
        [request.user.id],
      )
      return rows
    })
  })

  // 100 derniers messages d'une conversation, ordre chronologique.
  app.get('/conversations/:userId/messages', { schema: { params: uuidParam('userId') } }, async (request) => {
    return request.tx(async (c) => {
      const { rows } = await c.query(
        `SELECT * FROM (
           SELECT * FROM public.messages
            WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
            ORDER BY created_at DESC LIMIT 100
         ) t ORDER BY created_at ASC`,
        [request.user.id, request.params.userId],
      )
      return rows
    })
  })

  app.post('/conversations/:userId/messages', {
    schema: {
      params: uuidParam('userId'),
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string', maxLength: 4000, default: '' },
          image_url: { type: ['string', 'null'], maxLength: 2048 },
        },
      },
    },
  }, async (request, reply) => {
    const { content = '', image_url: imageUrl = null } = request.body
    if (!content.trim() && !imageUrl) return reply.code(400).send({ error: { code: 'bad_request', message: 'Message vide' } })
    // Le trigger restrict_blocked_messages refuse l'envoi en cas de blocage.
    const message = await request.tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO public.messages (sender_id, receiver_id, content, image_url, read)
         VALUES ($1, $2, $3, $4, false) RETURNING *`,
        [request.user.id, request.params.userId, content.trim(), imageUrl],
      )
      return rows[0]
    })
    return reply.code(201).send(message)
  })

  // Marque comme lus les messages reçus de cet utilisateur.
  app.post('/conversations/:userId/read', { schema: { params: uuidParam('userId') } }, async (request, reply) => {
    await request.tx((c) => c.query(
      'UPDATE public.messages SET read = true WHERE sender_id = $1 AND receiver_id = $2 AND read = false',
      [request.params.userId, request.user.id],
    ))
    return reply.code(204).send()
  })

  // Marque comme lus tous les messages reçus.
  app.post('/conversations/read-all', async (request, reply) => {
    await request.tx((c) => c.query(
      'UPDATE public.messages SET read = true WHERE receiver_id = $1 AND read = false', [request.user.id]))
    return reply.code(204).send()
  })

  app.post('/messages/:id/read', { schema: { params: bigintParam() } }, async (request, reply) => {
    await request.tx((c) => c.query(
      'UPDATE public.messages SET read = true WHERE id = $1 AND receiver_id = $2', [request.params.id, request.user.id]))
    return reply.code(204).send()
  })

  // Édition : expéditeur uniquement (la policy UPDATE autorise aussi le destinataire,
  // pour le marquage « lu »).
  app.patch('/messages/:id', { schema: { params: bigintParam(), body: contentBody } }, async (request) => {
    const row = await request.tx(async (c) => {
      const { rows } = await c.query(
        `UPDATE public.messages SET content = $3, edited = true, updated_at = now()
          WHERE id = $1 AND sender_id = $2 AND deleted IS NOT TRUE RETURNING *`,
        [request.params.id, request.user.id, request.body.content.trim()],
      )
      return rows[0]
    })
    if (!row) throw notFound('Message introuvable ou non autorisé')
    return row
  })

  // Suppression logique : expéditeur uniquement.
  app.delete('/messages/:id', { schema: { params: bigintParam() } }, async (request) => {
    const row = await request.tx(async (c) => {
      const { rows } = await c.query(
        `UPDATE public.messages SET deleted = true, content = '', updated_at = now()
          WHERE id = $1 AND sender_id = $2 RETURNING *`,
        [request.params.id, request.user.id],
      )
      return rows[0]
    })
    if (!row) throw notFound('Message introuvable ou non autorisé')
    return row
  })
}
