// Feed, reels, likes et commentaires.
import { notFound } from '../errors.js'
import { bigintParam, jsonObject } from './shared.js'

const AUTHOR_COLUMNS = [
  'id', 'username', 'avatar_url', 'is_premium', 'is_official',
  'username_color', 'custom_badge_url', 'is_anonymous',
]
const VIDEO_RE = '\\.(mp4|webm|mov|m4v)$'

// Un post au format du feed :
//   *, profiles(…), likes(id, user_id), comments(id, content, created_at, profiles(username, is_official))
const POST_SELECT = `
  SELECT po.*,
         ${jsonObject('au', AUTHOR_COLUMNS)} AS profiles,
         COALESCE((SELECT json_agg(json_build_object('id', l.id, 'user_id', l.user_id) ORDER BY l.id)
                     FROM public.likes l WHERE l.post_id = po.id), '[]'::json) AS likes,
         COALESCE((SELECT json_agg(json_build_object(
                            'id', c.id, 'content', c.content, 'created_at', c.created_at,
                            'profiles', json_build_object('username', cp.username, 'is_official', cp.is_official))
                          ORDER BY c.created_at, c.id)
                     FROM public.comments c JOIN public.profiles cp ON cp.id = c.user_id
                    WHERE c.post_id = po.id), '[]'::json) AS comments
    FROM public.posts po
    JOIN public.profiles au ON au.id = po.user_id`

const COMMENT_SELECT = `
  SELECT c.id, c.content, c.created_at,
         json_build_object('username', p.username, 'is_official', p.is_official) AS profiles
    FROM public.comments c JOIN public.profiles p ON p.id = c.user_id`

export async function fetchPost(client, id) {
  const { rows } = await client.query(`${POST_SELECT} WHERE po.id = $1`, [id])
  return rows[0] || null
}

export async function fetchComment(client, id) {
  const { rows } = await client.query(`${COMMENT_SELECT} WHERE c.id = $1`, [id])
  return rows[0] || null
}

export default async function postRoutes(app) {
  // Feed (kind=feed) ou reels (kind=reels : vidéos uniquement).
  app.get('/', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['feed', 'reels'], default: 'feed' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          before: { type: 'string', format: 'date-time' },
        },
      },
    },
  }, async (request) => {
    const { kind, before } = request.query
    const limit = request.query.limit ?? (kind === 'reels' ? 30 : 100)
    return request.tx(async (c) => {
      const { rows } = await c.query(
        `${POST_SELECT}
          WHERE ($1::boolean IS FALSE OR po.media_url ~* '${VIDEO_RE}')
            AND ($2::timestamptz IS NULL OR po.created_at < $2)
          ORDER BY po.created_at DESC
          LIMIT $3`,
        [kind === 'reels', before ?? null, limit],
      )
      return rows
    })
  })

  app.get('/:id', { schema: { params: bigintParam() } }, async (request) => {
    const post = await request.tx((c) => fetchPost(c, request.params.id))
    if (!post) throw notFound('Post introuvable')
    return post
  })

  app.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['media_url'],
        additionalProperties: false,
        properties: {
          caption: { type: ['string', 'null'], maxLength: 5000 },
          media_url: { type: 'string', minLength: 1, maxLength: 2048 },
        },
      },
    },
  }, async (request, reply) => {
    const { caption = null, media_url: mediaUrl } = request.body
    const post = await request.tx(async (c) => {
      const { rows } = await c.query(
        'INSERT INTO public.posts (user_id, caption, media_url) VALUES ($1, $2, $3) RETURNING id',
        [request.user.id, caption, mediaUrl],
      )
      return fetchPost(c, rows[0].id)
    })
    request.server.realtime.publish('feed', 'post:created', post)
    return reply.code(201).send(post)
  })

  // Auteur ou admin (RLS). Likes et commentaires suivent par cascade.
  app.delete('/:id', { schema: { params: bigintParam() } }, async (request, reply) => {
    const { rowCount } = await request.tx((c) =>
      c.query('DELETE FROM public.posts WHERE id = $1', [request.params.id]))
    if (!rowCount) throw notFound('Post introuvable ou non autorisé')
    request.server.realtime.publish('feed', 'post:deleted', { id: request.params.id })
    return reply.code(204).send()
  })

  app.post('/:id/views', { schema: { params: bigintParam() } }, async (request, reply) => {
    await request.tx((c) => c.query('SELECT public.increment_post_views($1)', [request.params.id]))
    return reply.code(204).send()
  })

  app.put('/:id/like', { schema: { params: bigintParam() } }, async (request) => {
    const { rows } = await request.tx((c) => c.query(
      'INSERT INTO public.likes (user_id, post_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id, user_id, post_id',
      [request.user.id, request.params.id],
    ))
    if (rows[0]) request.server.realtime.publish('feed', 'like:created', rows[0])
    return { liked: true }
  })

  app.delete('/:id/like', { schema: { params: bigintParam() } }, async (request) => {
    const { rowCount } = await request.tx((c) => c.query(
      'DELETE FROM public.likes WHERE user_id = $1 AND post_id = $2',
      [request.user.id, request.params.id],
    ))
    if (rowCount) request.server.realtime.publish('feed', 'like:deleted', { user_id: request.user.id, post_id: request.params.id })
    return { liked: false }
  })

  app.post('/:id/comments', {
    schema: {
      params: bigintParam(),
      body: {
        type: 'object',
        required: ['content'],
        additionalProperties: false,
        properties: { content: { type: 'string', minLength: 1, maxLength: 2000 } },
      },
    },
  }, async (request, reply) => {
    const comment = await request.tx(async (c) => {
      const { rows } = await c.query(
        'INSERT INTO public.comments (user_id, post_id, content) VALUES ($1, $2, $3) RETURNING id',
        [request.user.id, request.params.id, request.body.content.trim()],
      )
      return fetchComment(c, rows[0].id)
    })
    request.server.realtime.publish('feed', 'comment:created', { post_id: request.params.id, comment })
    return reply.code(201).send(comment)
  })
}

// DELETE /api/comments/:id — auteur ou admin (RLS).
export async function commentRoutes(app) {
  app.delete('/:id', { schema: { params: bigintParam() } }, async (request, reply) => {
    const { rowCount } = await request.tx((c) =>
      c.query('DELETE FROM public.comments WHERE id = $1', [request.params.id]))
    if (!rowCount) throw notFound('Commentaire introuvable ou non autorisé')
    return reply.code(204).send()
  })
}
