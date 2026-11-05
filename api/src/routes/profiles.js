// Profils publics, abonnements (follows) et blocages.
import { badRequest, notFound } from '../errors.js'
import { publicProfileSelect, uuidParam } from './shared.js'

const LIST_COLUMNS = 'id, username, avatar_url, bio, is_premium, is_official, username_color, custom_badge_url, is_anonymous'
const FOLLOW_COLUMNS = 'p.id, p.username, p.avatar_url, p.is_premium, p.is_official, p.username_color'

export default async function profileRoutes(app) {
  // Annuaire (Explore) et recherche par nom (invitations de groupe).
  app.get('/', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          q: { type: 'string', maxLength: 100 },
          exclude_self: { type: 'boolean', default: false },
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 500 },
        },
      },
    },
  }, async (request) => {
    const { q, exclude_self: excludeSelf, limit } = request.query
    const where = []
    const params = []
    if (q) {
      params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`)
      where.push(`username ILIKE $${params.length}`)
    }
    if (excludeSelf) {
      params.push(request.user.id)
      where.push(`id <> $${params.length}`)
    }
    params.push(limit)
    return request.tx(async (c) => {
      const { rows } = await c.query(
        `SELECT ${LIST_COLUMNS} FROM public.profiles
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY username NULLS LAST
         LIMIT $${params.length}`,
        params,
      )
      return rows
    })
  })

  // Profil public + compteurs + « est-ce que je le suis ».
  app.get('/:id', { schema: { params: uuidParam() } }, async (request) => {
    const row = await request.tx(async (c) => {
      const { rows } = await c.query(
        `SELECT ${publicProfileSelect('p')},
                (SELECT count(*) FROM public.follows f WHERE f.following_id = p.id) AS followers_count,
                (SELECT count(*) FROM public.follows f WHERE f.follower_id  = p.id) AS following_count,
                EXISTS (SELECT 1 FROM public.follows f
                         WHERE f.follower_id = $2 AND f.following_id = p.id)      AS is_following
           FROM public.profiles p WHERE p.id = $1`,
        [request.params.id, request.user.id],
      )
      return rows[0]
    })
    if (!row) throw notFound('Profil introuvable')
    return row
  })

  // Posts d'un utilisateur (forme : *, likes(count)).
  app.get('/:id/posts', { schema: { params: uuidParam() } }, async (request) => {
    return request.tx(async (c) => {
      const { rows } = await c.query(
        `SELECT po.*,
                json_build_array(json_build_object(
                  'count', (SELECT count(*) FROM public.likes l WHERE l.post_id = po.id))) AS likes
           FROM public.posts po
          WHERE po.user_id = $1
          ORDER BY po.created_at DESC`,
        [request.params.id],
      )
      return rows
    })
  })

  app.get('/:id/followers', { schema: { params: uuidParam() } }, async (request) => {
    return request.tx(async (c) => {
      const { rows } = await c.query(
        `SELECT ${FOLLOW_COLUMNS} FROM public.follows f
           JOIN public.profiles p ON p.id = f.follower_id
          WHERE f.following_id = $1
          ORDER BY p.username`,
        [request.params.id],
      )
      return rows
    })
  })

  app.get('/:id/following', { schema: { params: uuidParam() } }, async (request) => {
    return request.tx(async (c) => {
      const { rows } = await c.query(
        `SELECT ${FOLLOW_COLUMNS} FROM public.follows f
           JOIN public.profiles p ON p.id = f.following_id
          WHERE f.follower_id = $1
          ORDER BY p.username`,
        [request.params.id],
      )
      return rows
    })
  })

  app.put('/:id/follow', { schema: { params: uuidParam() } }, async (request) => {
    if (request.params.id === request.user.id) throw badRequest('Impossible de se suivre soi-même')
    await request.tx((c) => c.query(
      `INSERT INTO public.follows (follower_id, following_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [request.user.id, request.params.id],
    ))
    return { following: true }
  })

  app.delete('/:id/follow', { schema: { params: uuidParam() } }, async (request) => {
    await request.tx((c) => c.query(
      'DELETE FROM public.follows WHERE follower_id = $1 AND following_id = $2',
      [request.user.id, request.params.id],
    ))
    return { following: false }
  })

  app.put('/:id/block', { schema: { params: uuidParam() } }, async (request) => {
    if (request.params.id === request.user.id) throw badRequest('Impossible de se bloquer soi-même')
    await request.tx((c) => c.query(
      `INSERT INTO public.blocks (blocker_id, blocked_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [request.user.id, request.params.id],
    ))
    return { blocked: true }
  })

  app.delete('/:id/block', { schema: { params: uuidParam() } }, async (request) => {
    await request.tx((c) => c.query(
      'DELETE FROM public.blocks WHERE blocker_id = $1 AND blocked_id = $2',
      [request.user.id, request.params.id],
    ))
    return { blocked: false }
  })
}
