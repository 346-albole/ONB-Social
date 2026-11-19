// Administration — toutes les routes exigent profiles.is_admin = true
// (vérifié ici pour répondre 403, puis appliqué par les policies RLS).
import { forbidden, notFound } from '../errors.js'
import { forgetProfile } from '../auth/profile.js'
import { bigintParam, uuidParam } from './shared.js'

const VIDEO_RE = '\\.(mp4|webm|mov|m4v)$'

const USER_COLUMNS = `id, username, avatar_url, bio, username_color, banner_url, updated_at, created_at,
  is_premium, is_official, is_admin, is_banned, is_anonymous, is_invisible, warnings_count,
  onb_coins, premium_is_permanent, official_is_permanent, premium_expires_at, official_expires_at`

const USER_SORTS = {
  updated: 'updated_at DESC NULLS LAST',
  coins: 'onb_coins DESC',
  warnings: 'warnings_count DESC',
}

const reasonBody = {
  type: 'object',
  additionalProperties: false,
  properties: { reason: { type: 'string', maxLength: 500 } },
}

const str = (max) => ({ type: 'string', maxLength: max })
const nstr = (max) => ({ type: ['string', 'null'], maxLength: max })

/**
 * Routes CRUD pour une table d'administration simple. Les noms de table et de
 * colonnes sont fixés ici (jamais issus de la requête).
 */
function crud(app, { path, table, order, idParam, create, patch, defaults = () => ({}) }) {
  app.get(path, async (request) => request.tx(async (c) =>
    (await c.query(`SELECT * FROM public.${table} ORDER BY ${order}`)).rows))

  app.post(path, {
    schema: { body: { type: 'object', additionalProperties: false, ...create } },
  }, async (request, reply) => {
    const values = { ...request.body, ...defaults(request) }
    const keys = Object.keys(values)
    const row = await request.tx(async (c) => (await c.query(
      `INSERT INTO public.${table} (${keys.map((k) => `"${k}"`).join(', ')})
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      keys.map((k) => (k === 'criteria' ? JSON.stringify(values[k]) : values[k])),
    )).rows[0])
    return reply.code(201).send(row)
  })

  if (patch) {
    app.patch(`${path}/:id`, {
      schema: { params: idParam, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: patch } },
    }, async (request) => {
      const keys = Object.keys(request.body)
      const row = await request.tx(async (c) => (await c.query(
        `UPDATE public.${table} SET ${keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ')}
          WHERE id = $1 RETURNING *`,
        [request.params.id, ...keys.map((k) => request.body[k])],
      )).rows[0])
      if (!row) throw notFound()
      return row
    })
  }

  app.delete(`${path}/:id`, { schema: { params: idParam } }, async (request, reply) => {
    const { rowCount } = await request.tx((c) => c.query(`DELETE FROM public.${table} WHERE id = $1`, [request.params.id]))
    if (!rowCount) throw notFound()
    return reply.code(204).send()
  })
}

async function logAction(c, adminId, actionType, targetUserId, reason) {
  await c.query(
    `INSERT INTO public.moderation_action_logs (admin_id, action_type, target_user_id, reason)
     VALUES ($1, $2, $3, $4)`,
    [adminId, actionType, targetUserId, reason],
  )
}

export default async function adminRoutes(app) {
  app.addHook('preHandler', async (request) => {
    const isAdmin = await request.tx(async (c) =>
      (await c.query('SELECT public.is_admin($1) AS ok', [request.user.id])).rows[0].ok)
    if (!isAdmin) throw forbidden('Réservé aux administrateurs')
  })

  // ── Tableau de bord ────────────────────────────────────────────────────────
  app.get('/overview', async (request) => request.tx(async (c) => (await c.query(
    `SELECT (SELECT count(*) FROM public.profiles)        AS users,
            (SELECT count(*) FROM public.posts)           AS posts,
            (SELECT count(*) FROM public.comments)        AS comments,
            (SELECT count(*) FROM public.messages)        AS messages,
            (SELECT count(*) FROM public.groups)          AS groups,
            (SELECT count(*) FROM public.global_messages WHERE deleted = false) AS "globalMsgs"`,
  )).rows[0]))

  // ── Utilisateurs ───────────────────────────────────────────────────────────
  app.get('/users', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: { sort: { type: 'string', enum: Object.keys(USER_SORTS), default: 'updated' } },
      },
    },
  }, async (request) => request.tx(async (c) =>
    (await c.query(`SELECT ${USER_COLUMNS} FROM public.profiles ORDER BY ${USER_SORTS[request.query.sort]}`)).rows))

  app.patch('/users/:id', {
    schema: {
      params: uuidParam(),
      body: {
        type: 'object',
        additionalProperties: false,
        minProperties: 1,
        properties: {
          ...Object.fromEntries(['is_premium', 'is_official', 'is_admin', 'is_banned', 'is_anonymous', 'is_invisible',
            'premium_is_permanent', 'official_is_permanent'].map((k) => [k, { type: 'boolean' }])),
          bio: nstr(500),
          username_color: nstr(32),
          warnings_count: { type: 'integer', minimum: 0 },
        },
      },
    },
  }, async (request) => {
    const keys = Object.keys(request.body)
    const row = await request.tx(async (c) => (await c.query(
      `UPDATE public.profiles SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now()
        WHERE id = $1 RETURNING ${USER_COLUMNS}`,
      [request.params.id, ...keys.map((k) => request.body[k])],
    )).rows[0])
    if (!row) throw notFound('Utilisateur introuvable')
    return row
  })

  // Supprime le profil ; tout son contenu suit par cascade.
  app.delete('/users/:id', { schema: { params: uuidParam() } }, async (request, reply) => {
    const { rowCount } = await request.tx((c) => c.query('DELETE FROM public.profiles WHERE id = $1', [request.params.id]))
    if (!rowCount) throw notFound('Utilisateur introuvable')
    forgetProfile(request.params.id)
    return reply.code(204).send()
  })

  // Rechargement à distance de la page de l'utilisateur.
  app.post('/users/:id/reload', { schema: { params: uuidParam() } }, async (request, reply) => {
    // Pas de RETURNING : seule la cible peut lire ses commandes (policy SELECT).
    await request.tx((c) => c.query(
      `INSERT INTO public.admin_commands (target_user_id, admin_id, command) VALUES ($1, $2, 'reload')`,
      [request.params.id, request.user.id],
    ))
    request.server.realtime.publish(`user:${request.params.id}`, 'command', { command: 'reload' })
    return reply.code(201).send({ sent: true })
  })

  // Avertissement : +1, bannissement automatique au 2e.
  app.post('/users/:id/warn', { schema: { params: uuidParam(), body: reasonBody } }, async (request) => {
    return request.tx(async (c) => {
      const { rows: [user] } = await c.query(
        `UPDATE public.profiles SET warnings_count = warnings_count + 1,
                is_banned = is_banned OR warnings_count + 1 >= 2, updated_at = now()
          WHERE id = $1 RETURNING id, warnings_count, is_banned`,
        [request.params.id],
      )
      if (!user) throw notFound('Utilisateur introuvable')
      await logAction(c, request.user.id, 'warn_user', user.id, request.body?.reason || 'Admin warning')
      return user
    })
  })

  // Retire un avertissement ; débannit sous le seuil de 2.
  app.post('/users/:id/unwarn', { schema: { params: uuidParam(), body: reasonBody } }, async (request) => {
    return request.tx(async (c) => {
      const { rows: [before] } = await c.query('SELECT is_banned FROM public.profiles WHERE id = $1', [request.params.id])
      if (!before) throw notFound('Utilisateur introuvable')
      const { rows: [user] } = await c.query(
        `UPDATE public.profiles SET warnings_count = GREATEST(warnings_count - 1, 0),
                is_banned = is_banned AND GREATEST(warnings_count - 1, 0) >= 2, updated_at = now()
          WHERE id = $1 RETURNING id, warnings_count, is_banned`,
        [request.params.id],
      )
      const unbanned = before.is_banned && !user.is_banned
      await logAction(c, request.user.id, unbanned ? 'unban_user' : 'warn_user', user.id,
        request.body?.reason || 'Admin removed warning')
      return user
    })
  })

  app.post('/users/:id/ban', { schema: { params: uuidParam(), body: reasonBody } }, async (request) => {
    return request.tx(async (c) => {
      const { rows: [user] } = await c.query(
        `UPDATE public.profiles SET is_banned = true, updated_at = now() WHERE id = $1
         RETURNING id, warnings_count, is_banned`,
        [request.params.id],
      )
      if (!user) throw notFound('Utilisateur introuvable')
      await logAction(c, request.user.id, 'ban_user', user.id, request.body?.reason || 'Admin ban')
      return user
    })
  })

  // ── Contenus ───────────────────────────────────────────────────────────────
  // kind=posts : 100 derniers (images) ; kind=reels : toutes les vidéos avec compteurs.
  app.get('/posts', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: { kind: { type: 'string', enum: ['posts', 'reels'], default: 'posts' } },
      },
    },
  }, async (request) => request.tx(async (c) => {
    if (request.query.kind === 'reels') {
      return (await c.query(
        `SELECT po.*, json_build_object('username', p.username) AS profiles,
                json_build_array(json_build_object('count', (SELECT count(*) FROM public.likes l WHERE l.post_id = po.id))) AS likes,
                json_build_array(json_build_object('count', (SELECT count(*) FROM public.comments cm WHERE cm.post_id = po.id))) AS comments
           FROM public.posts po JOIN public.profiles p ON p.id = po.user_id
          WHERE po.media_url ~* '${VIDEO_RE}'
          ORDER BY po.created_at DESC`,
      )).rows
    }
    return (await c.query(
      `SELECT po.*, json_build_object('username', p.username, 'avatar_url', p.avatar_url) AS profiles
         FROM public.posts po JOIN public.profiles p ON p.id = po.user_id
        ORDER BY po.created_at DESC LIMIT 100`,
    )).rows
  }))

  app.get('/comments', async (request) => request.tx(async (c) => (await c.query(
    `SELECT cm.*, json_build_object('username', p.username, 'avatar_url', p.avatar_url) AS profiles
       FROM public.comments cm JOIN public.profiles p ON p.id = cm.user_id
      ORDER BY cm.created_at DESC LIMIT 100`,
  )).rows))

  app.get('/messages', async (request) => request.tx(async (c) => (await c.query(
    `SELECT m.*,
            json_build_object('id', s.id, 'username', s.username, 'avatar_url', s.avatar_url) AS sender,
            json_build_object('id', r.id, 'username', r.username, 'avatar_url', r.avatar_url) AS receiver
       FROM public.messages m
       JOIN public.profiles s ON s.id = m.sender_id
       JOIN public.profiles r ON r.id = m.receiver_id
      ORDER BY m.created_at DESC LIMIT 100`,
  )).rows))

  app.delete('/messages/:id', { schema: { params: bigintParam() } }, async (request, reply) => {
    const { rowCount } = await request.tx((c) => c.query('DELETE FROM public.messages WHERE id = $1', [request.params.id]))
    if (!rowCount) throw notFound()
    return reply.code(204).send()
  })

  app.get('/global-messages', async (request) => request.tx(async (c) => (await c.query(
    `SELECT g.*, json_build_object('username', p.username, 'avatar_url', p.avatar_url) AS profiles
       FROM public.global_messages g JOIN public.profiles p ON p.id = g.sender_id
      WHERE g.deleted = false
      ORDER BY g.created_at DESC LIMIT 100`,
  )).rows))

  app.delete('/global-messages/:id', { schema: { params: bigintParam() } }, async (request, reply) => {
    const { rowCount } = await request.tx((c) => c.query('DELETE FROM public.global_messages WHERE id = $1', [request.params.id]))
    if (!rowCount) throw notFound()
    request.server.realtime.publish('global-chat', 'message:deleted', { id: request.params.id })
    return reply.code(204).send()
  })

  // Vide tout le chat global.
  app.delete('/global-messages', async (request, reply) => {
    await request.tx((c) => c.query('DELETE FROM public.global_messages'))
    request.server.realtime.publish('global-chat', 'messages:cleared', {})
    return reply.code(204).send()
  })

  app.patch('/groups/:id', {
    schema: {
      params: uuidParam(),
      body: { type: 'object', required: ['is_private'], additionalProperties: false, properties: { is_private: { type: 'boolean' } } },
    },
  }, async (request) => {
    const row = await request.tx(async (c) => (await c.query(
      'UPDATE public.groups SET is_private = $2 WHERE id = $1 RETURNING *', [request.params.id, request.body.is_private])).rows[0])
    if (!row) throw notFound()
    return row
  })

  // ── Annonces et broadcasts ─────────────────────────────────────────────────
  crud(app, {
    path: '/announcements', table: 'announcements', order: 'created_at DESC', idParam: bigintParam(),
    create: { required: ['content'], properties: { content: str(2000), type: str(20), active: { type: 'boolean' } } },
    patch: { active: { type: 'boolean' } },
    defaults: (r) => ({ admin_id: r.user.id }),
  })
  crud(app, {
    path: '/broadcasts', table: 'admin_broadcasts', order: 'created_at DESC', idParam: bigintParam(),
    create: {
      properties: {
        title: nstr(300), html_content: nstr(50000), js_content: nstr(50000),
        broadcast_type: str(20), active: { type: 'boolean' },
      },
    },
    patch: { active: { type: 'boolean' } },
    defaults: (r) => ({ admin_id: r.user.id }),
  })

  // ── Coins ──────────────────────────────────────────────────────────────────
  app.post('/coins/grant', {
    schema: {
      body: {
        type: 'object',
        required: ['user_id', 'amount'],
        additionalProperties: false,
        properties: {
          user_id: { type: 'string', format: 'uuid' },
          amount: { type: 'integer' },
          reason: { type: 'string', maxLength: 100 },
        },
      },
    },
  }, async (request) => request.tx(async (c) => (await c.query(
    'SELECT public.admin_grant_coins($1, $2, $3) AS result',
    [request.body.user_id, request.body.amount, request.body.reason || 'admin_grant'],
  )).rows[0].result))

  // ── Analytics ──────────────────────────────────────────────────────────────
  // Données brutes de la période (agrégées par la vue) + utilisateurs actifs
  // sur 24 h et profils des 10 plus gros créateurs.
  app.get('/analytics', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: { range: { type: 'string', enum: ['7d', '30d', 'all'], default: '7d' } },
      },
    },
  }, async (request) => {
    const days = { '7d': 7, '30d': 30, all: null }[request.query.range]
    const since = days ? new Date(Date.now() - days * 86400000).toISOString() : null
    return request.tx(async (c) => {
      const period = (sql) => c.query(sql, [since])
      const [users, posts, comments, coins, active, creators] = await Promise.all([
        period('SELECT created_at FROM public.profiles WHERE $1::timestamptz IS NULL OR created_at >= $1 ORDER BY created_at'),
        period('SELECT created_at, media_url, user_id FROM public.posts WHERE $1::timestamptz IS NULL OR created_at >= $1'),
        period('SELECT created_at, user_id FROM public.comments WHERE $1::timestamptz IS NULL OR created_at >= $1'),
        period('SELECT amount, reason, created_at FROM public.coin_transactions WHERE $1::timestamptz IS NULL OR created_at >= $1'),
        c.query(`SELECT user_id FROM public.posts WHERE created_at >= now() - interval '1 day'
                 UNION SELECT user_id FROM public.comments WHERE created_at >= now() - interval '1 day'
                 UNION SELECT sender_id FROM public.global_messages WHERE created_at >= now() - interval '1 day' AND deleted = false`),
        period(`SELECT p.id, p.username, p.avatar_url, count(*) AS posts_count
                  FROM public.posts po JOIN public.profiles p ON p.id = po.user_id
                 WHERE $1::timestamptz IS NULL OR po.created_at >= $1
                 GROUP BY p.id ORDER BY posts_count DESC LIMIT 10`),
      ])
      return {
        users: users.rows,
        posts: posts.rows,
        comments: comments.rows,
        coin_transactions: coins.rows,
        active_user_ids: active.rows.map((r) => r.user_id),
        top_creators: creators.rows,
      }
    })
  })

  // ── Modération ─────────────────────────────────────────────────────────────
  app.get('/reports', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: { status: { type: 'string', enum: ['all', 'pending', 'reviewing', 'resolved', 'dismissed'], default: 'all' } },
      },
    },
  }, async (request) => request.tx(async (c) => (await c.query(
    `SELECT r.*, to_jsonb(rp) AS reporter, to_jsonb(rb) AS resolved_by
       FROM public.user_reports r
       LEFT JOIN public.profiles rp ON rp.id = r.reporter_id
       LEFT JOIN public.profiles rb ON rb.id = r.resolved_by
      WHERE $1 = 'all' OR r.status = $1
      ORDER BY r.created_at DESC`,
    [request.query.status],
  )).rows))

  app.patch('/reports/:id', {
    schema: {
      params: uuidParam(),
      body: {
        type: 'object',
        required: ['status'],
        additionalProperties: false,
        properties: { status: { type: 'string', enum: ['pending', 'reviewing', 'resolved', 'dismissed'] } },
      },
    },
  }, async (request) => {
    const done = ['resolved', 'dismissed'].includes(request.body.status)
    const row = await request.tx(async (c) => (await c.query(
      `UPDATE public.user_reports SET status = $2, updated_at = now(),
              resolved_by = CASE WHEN $3 THEN $4::uuid ELSE resolved_by END,
              resolved_at = CASE WHEN $3 THEN now() ELSE resolved_at END
        WHERE id = $1 RETURNING *`,
      [request.params.id, request.body.status, done, request.user.id],
    )).rows[0])
    if (!row) throw notFound()
    return row
  })

  app.get('/moderation-flags', async (request) => request.tx(async (c) => (await c.query(
    'SELECT * FROM public.moderation_flags WHERE resolved = false ORDER BY created_at DESC')).rows))

  app.patch('/moderation-flags/:id', {
    schema: {
      params: uuidParam(),
      body: { type: 'object', required: ['resolved'], additionalProperties: false, properties: { resolved: { type: 'boolean' } } },
    },
  }, async (request) => {
    const row = await request.tx(async (c) => (await c.query(
      'UPDATE public.moderation_flags SET resolved = $2 WHERE id = $1 RETURNING *', [request.params.id, request.body.resolved])).rows[0])
    if (!row) throw notFound()
    return row
  })

  crud(app, {
    path: '/forbidden-words', table: 'forbidden_words', order: 'created_at DESC', idParam: uuidParam(),
    create: {
      required: ['word'],
      properties: {
        word: { type: 'string', minLength: 1, maxLength: 255 },
        severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        enabled: { type: 'boolean' },
      },
    },
    patch: { enabled: { type: 'boolean' } },
    defaults: (r) => ({ created_by: r.user.id }),
  })

  // ── Curation ───────────────────────────────────────────────────────────────
  crud(app, {
    path: '/featured', table: 'featured_content', order: '"position" ASC', idParam: uuidParam(),
    create: {
      required: ['content_id'],
      properties: {
        content_type: { type: 'string', enum: ['post', 'reel', 'forum_post'] },
        content_id: { type: 'string', minLength: 1, maxLength: 100 },
        featured_until: { type: ['string', 'null'], format: 'date-time' },
        section: { type: 'string', enum: ['homepage', 'explore', 'trending'] },
        position: { type: 'integer', minimum: 0 },
      },
    },
    defaults: (r) => ({ featured_by: r.user.id }),
  })

  // Posts récents avec engagement (likes + commentaires).
  app.get('/trending', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: { window: { type: 'string', enum: ['24h', '7d', 'all'], default: '24h' } },
      },
    },
  }, async (request) => {
    const hours = { '24h': 24, '7d': 168, all: null }[request.query.window]
    return request.tx(async (c) => (await c.query(
      `SELECT po.id, po.caption, po.user_id, po.created_at,
              json_build_object('username', p.username, 'avatar_url', p.avatar_url) AS profiles,
              json_build_array(json_build_object('count', (SELECT count(*) FROM public.likes l WHERE l.post_id = po.id))) AS likes,
              json_build_array(json_build_object('count', (SELECT count(*) FROM public.comments cm WHERE cm.post_id = po.id))) AS comments
         FROM public.posts po JOIN public.profiles p ON p.id = po.user_id
        WHERE $1::int IS NULL OR po.created_at >= now() - make_interval(hours => $1::int)
        ORDER BY po.created_at DESC`,
      [hours],
    )).rows)
  })

  crud(app, {
    path: '/curation-rules', table: 'content_curation_rules', order: 'created_at DESC', idParam: uuidParam(),
    create: {
      required: ['rule_name', 'rule_type', 'action'],
      properties: {
        rule_name: { type: 'string', minLength: 1, maxLength: 255 },
        rule_type: { type: 'string', enum: ['boost', 'hide', 'recommend', 'flag'] },
        criteria: { type: 'object' },
        action: { type: 'string', minLength: 1, maxLength: 100 },
        enabled: { type: 'boolean' },
      },
    },
    patch: { enabled: { type: 'boolean' } },
    defaults: (r) => ({ created_by: r.user.id }),
  })

  // ── Réglages du site ───────────────────────────────────────────────────────
  app.patch('/site-settings', {
    schema: {
      body: { type: 'object', required: ['is_troll_mode'], additionalProperties: false, properties: { is_troll_mode: { type: 'boolean' } } },
    },
  }, async (request) => {
    const settings = await request.tx(async (c) => (await c.query(
      `UPDATE public.site_settings SET is_troll_mode = $1, updated_at = now() WHERE id = 1
       RETURNING is_troll_mode, updated_at`,
      [request.body.is_troll_mode],
    )).rows[0])
    request.server.realtime.publish('site-settings', 'updated', settings)
    return settings
  })
}
