// Groupes : liste, création, adhésion, membres, messages.
import { badRequest, notFound } from '../errors.js'
import { uuidParam } from './shared.js'

const GROUP_SELECT = `
  SELECT g.id, g.name, g.description, g.banner_url, g.created_by, g.created_at, g.is_private,
         json_build_array(json_build_object(
           'count', (SELECT count(*) FROM public.group_members m WHERE m.group_id = g.id))) AS group_members
    FROM public.groups g`

const GROUP_MESSAGE_SELECT = `
  SELECT gm.*, json_build_object('username', p.username, 'avatar_url', p.avatar_url,
                                 'username_color', p.username_color) AS profiles
    FROM public.group_messages gm JOIN public.profiles p ON p.id = gm.sender_id`

export async function fetchGroupMessage(client, id) {
  const { rows } = await client.query(`${GROUP_MESSAGE_SELECT} WHERE gm.id = $1`, [id])
  return rows[0] || null
}

const groupMemberParams = {
  type: 'object',
  required: ['id', 'userId'],
  properties: { id: { type: 'string', format: 'uuid' }, userId: { type: 'string', format: 'uuid' } },
}

export default async function groupRoutes(app) {
  // Groupes visibles (RLS : publics, ceux dont je suis membre/créateur, tous pour un admin)
  // + identifiants des groupes dont je suis membre.
  app.get('/', async (request) => {
    return request.tx(async (c) => {
      const [groups, memberships] = await Promise.all([
        c.query(`${GROUP_SELECT} ORDER BY g.created_at DESC`),
        c.query('SELECT group_id FROM public.group_members WHERE user_id = $1', [request.user.id]),
      ])
      return { groups: groups.rows, member_group_ids: memberships.rows.map((r) => r.group_id) }
    })
  })

  // Création + adhésion du créateur comme admin, dans la même transaction.
  app.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          description: { type: ['string', 'null'], maxLength: 1000 },
          banner_url: { type: ['string', 'null'], maxLength: 2048 },
          is_private: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    const { name, description = null, banner_url: bannerUrl = null, is_private: isPrivate } = request.body
    const group = await request.tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO public.groups (name, description, banner_url, created_by, is_private)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [name.trim(), description?.trim() || null, bannerUrl, request.user.id, isPrivate],
      )
      await c.query(
        `INSERT INTO public.group_members (group_id, user_id, role) VALUES ($1, $2, 'admin')`,
        [rows[0].id, request.user.id],
      )
      const { rows: [created] } = await c.query(`${GROUP_SELECT} WHERE g.id = $1`, [rows[0].id])
      return created
    })
    return reply.code(201).send(group)
  })

  // Créateur ou admin (RLS).
  app.delete('/:id', { schema: { params: uuidParam() } }, async (request, reply) => {
    const { rowCount } = await request.tx((c) => c.query('DELETE FROM public.groups WHERE id = $1', [request.params.id]))
    if (!rowCount) throw notFound('Groupe introuvable ou non autorisé')
    return reply.code(204).send()
  })

  // Rejoindre un groupe public (RLS : les groupes privés passent par une invitation).
  app.post('/:id/join', { schema: { params: uuidParam() } }, async (request) => {
    await request.tx((c) => c.query(
      `INSERT INTO public.group_members (group_id, user_id, role) VALUES ($1, $2, 'member')
       ON CONFLICT DO NOTHING`,
      [request.params.id, request.user.id],
    ))
    return { member: true }
  })

  app.get('/:id/members', { schema: { params: uuidParam() } }, async (request) => {
    return request.tx(async (c) => {
      const { rows } = await c.query(
        `SELECT m.user_id, m.role, m.joined_at,
                json_build_object('id', p.id, 'username', p.username, 'avatar_url', p.avatar_url,
                                  'is_official', p.is_official, 'is_premium', p.is_premium,
                                  'username_color', p.username_color) AS profiles
           FROM public.group_members m JOIN public.profiles p ON p.id = m.user_id
          WHERE m.group_id = $1
          ORDER BY m.joined_at ASC`,
        [request.params.id],
      )
      return rows
    })
  })

  // Inviter un utilisateur (créateur du groupe ou admin — RLS).
  app.post('/:id/members', {
    schema: {
      params: uuidParam(),
      body: {
        type: 'object',
        required: ['user_id'],
        additionalProperties: false,
        properties: { user_id: { type: 'string', format: 'uuid' } },
      },
    },
  }, async (request, reply) => {
    await request.tx((c) => c.query(
      `INSERT INTO public.group_members (group_id, user_id, role) VALUES ($1, $2, 'member')
       ON CONFLICT DO NOTHING`,
      [request.params.id, request.body.user_id],
    ))
    return reply.code(201).send({ member: true })
  })

  // Quitter (userId = soi-même) ou expulser (créateur / admin — RLS).
  app.delete('/:id/members/:userId', { schema: { params: groupMemberParams } }, async (request, reply) => {
    const { id, userId } = request.params
    const { rowCount } = await request.tx(async (c) => {
      if (userId === request.user.id) {
        const { rows } = await c.query('SELECT created_by FROM public.groups WHERE id = $1', [id])
        if (rows[0]?.created_by === request.user.id) throw badRequest('Le créateur ne peut pas quitter son groupe')
      }
      return c.query('DELETE FROM public.group_members WHERE group_id = $1 AND user_id = $2', [id, userId])
    })
    if (!rowCount) throw notFound('Membre introuvable ou non autorisé')
    return reply.code(204).send()
  })

  // 100 derniers messages (membres uniquement — RLS).
  app.get('/:id/messages', { schema: { params: uuidParam() } }, async (request) => {
    return request.tx(async (c) => {
      const { rows } = await c.query(
        `SELECT * FROM (${GROUP_MESSAGE_SELECT} WHERE gm.group_id = $1 ORDER BY gm.created_at DESC LIMIT 100) t
          ORDER BY created_at ASC`,
        [request.params.id],
      )
      return rows
    })
  })

  // created_at fixé par le serveur.
  app.post('/:id/messages', {
    schema: {
      params: uuidParam(),
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
    if (!content.trim() && !imageUrl) throw badRequest('Message vide')
    const message = await request.tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO public.group_messages (group_id, sender_id, content, image_url)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [request.params.id, request.user.id, content.trim(), imageUrl],
      )
      return fetchGroupMessage(c, rows[0].id)
    })
    return reply.code(201).send(message)
  })
}
