// Forum : posts, commentaires (fil), votes.
import { notFound } from '../errors.js'
import { bigintParam, jsonObject } from './shared.js'

const AUTHOR_COLUMNS = ['id', 'username', 'avatar_url', 'username_color', 'is_premium', 'is_official']
const count = (sql) => `json_build_array(json_build_object('count', (${sql})))`

const POST_SELECT = `
  SELECT fp.id, fp.title, fp.content, fp.category, fp.image_url, fp.created_at, fp.user_id,
         ${jsonObject('p', AUTHOR_COLUMNS)} AS profiles,
         ${count('SELECT count(*) FROM public.forum_votes v WHERE v.post_id = fp.id')} AS forum_votes,
         ${count('SELECT count(*) FROM public.forum_comments c WHERE c.post_id = fp.id')} AS forum_comments
    FROM public.forum_posts fp JOIN public.profiles p ON p.id = fp.user_id`

const COMMENT_SELECT = `
  SELECT fc.id, fc.content, fc.created_at, fc.user_id, fc.parent_id,
         ${jsonObject('p', AUTHOR_COLUMNS)} AS profiles,
         ${count('SELECT count(*) FROM public.forum_votes v WHERE v.comment_id = fc.id')} AS forum_votes
    FROM public.forum_comments fc JOIN public.profiles p ON p.id = fc.user_id`

export async function fetchForumComment(client, id) {
  const { rows } = await client.query(`${COMMENT_SELECT} WHERE fc.id = $1`, [id])
  return rows[0] || null
}

export default async function forumRoutes(app) {
  // 50 derniers posts (catégorie optionnelle) + posts que j'ai votés.
  app.get('/posts', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: { category: { type: 'string', maxLength: 50 } },
      },
    },
  }, async (request) => {
    const category = request.query.category || null
    return request.tx(async (c) => {
      const [posts, votes] = await Promise.all([
        c.query(
          `${POST_SELECT} WHERE ($1::text IS NULL OR fp.category = $1)
            ORDER BY fp.created_at DESC LIMIT 50`,
          [category],
        ),
        c.query('SELECT post_id FROM public.forum_votes WHERE user_id = $1 AND post_id IS NOT NULL', [request.user.id]),
      ])
      return { posts: posts.rows, voted_post_ids: votes.rows.map((r) => r.post_id) }
    })
  })

  app.post('/posts', {
    schema: {
      body: {
        type: 'object',
        required: ['title'],
        additionalProperties: false,
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 300 },
          content: { type: ['string', 'null'], maxLength: 20000 },
          category: { type: 'string', minLength: 1, maxLength: 50, default: 'general' },
          image_url: { type: ['string', 'null'], maxLength: 2048 },
        },
      },
    },
  }, async (request, reply) => {
    const { title, content = null, category, image_url: imageUrl = null } = request.body
    const post = await request.tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO public.forum_posts (user_id, title, content, category, image_url)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [request.user.id, title.trim(), content?.trim() || null, category, imageUrl],
      )
      const { rows: [created] } = await c.query(`${POST_SELECT} WHERE fp.id = $1`, [rows[0].id])
      return created
    })
    return reply.code(201).send(post)
  })

  // Auteur ou admin (RLS) ; commentaires et votes suivent par cascade.
  app.delete('/posts/:id', { schema: { params: bigintParam() } }, async (request, reply) => {
    const { rowCount } = await request.tx((c) => c.query('DELETE FROM public.forum_posts WHERE id = $1', [request.params.id]))
    if (!rowCount) throw notFound('Post introuvable ou non autorisé')
    return reply.code(204).send()
  })

  // Commentaires d'un post + ceux que j'ai votés.
  app.get('/posts/:id/comments', { schema: { params: bigintParam() } }, async (request) => {
    return request.tx(async (c) => {
      const [comments, votes] = await Promise.all([
        c.query(`${COMMENT_SELECT} WHERE fc.post_id = $1 ORDER BY fc.created_at ASC`, [request.params.id]),
        c.query(
          `SELECT v.comment_id FROM public.forum_votes v
             JOIN public.forum_comments fc ON fc.id = v.comment_id
            WHERE v.user_id = $1 AND fc.post_id = $2`,
          [request.user.id, request.params.id],
        ),
      ])
      return { comments: comments.rows, voted_comment_ids: votes.rows.map((r) => r.comment_id) }
    })
  })

  app.post('/posts/:id/comments', {
    schema: {
      params: bigintParam(),
      body: {
        type: 'object',
        required: ['content'],
        additionalProperties: false,
        properties: {
          content: { type: 'string', minLength: 1, maxLength: 5000 },
          parent_id: { type: ['integer', 'null'], minimum: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const comment = await request.tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO public.forum_comments (post_id, user_id, content, parent_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [request.params.id, request.user.id, request.body.content.trim(), request.body.parent_id ?? null],
      )
      return fetchForumComment(c, rows[0].id)
    })
    request.server.realtime.publish(`forum-post:${request.params.id}`, 'comment:created', comment)
    return reply.code(201).send(comment)
  })

  // Auteur ou admin (RLS) ; réponses et votes suivent par cascade.
  app.delete('/comments/:id', { schema: { params: bigintParam() } }, async (request, reply) => {
    const { rowCount } = await request.tx((c) => c.query('DELETE FROM public.forum_comments WHERE id = $1', [request.params.id]))
    if (!rowCount) throw notFound('Commentaire introuvable ou non autorisé')
    return reply.code(204).send()
  })

  // Votes (un par utilisateur et par cible).
  for (const target of ['posts', 'comments']) {
    const column = target === 'posts' ? 'post_id' : 'comment_id'
    app.put(`/${target}/:id/vote`, { schema: { params: bigintParam() } }, async (request) => {
      await request.tx((c) => c.query(
        `INSERT INTO public.forum_votes (user_id, ${column}) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [request.user.id, request.params.id],
      ))
      return { voted: true }
    })
    app.delete(`/${target}/:id/vote`, { schema: { params: bigintParam() } }, async (request) => {
      await request.tx((c) => c.query(
        `DELETE FROM public.forum_votes WHERE user_id = $1 AND ${column} = $2`,
        [request.user.id, request.params.id],
      ))
      return { voted: false }
    })
  }
}
