// Profil de l'utilisateur connecté.
import { notFound } from '../errors.js'

const nullableString = (max) => ({ type: ['string', 'null'], maxLength: max })

// Champs modifiables par l'utilisateur. Le trigger profiles_guard empêche en
// plus un non-admin de toucher aux colonnes sensibles ; warnings_count et
// is_banned ne peuvent que croître (utilisés par moderation.js côté navigateur).
// is_anonymous / is_invisible ne sont pris en compte que pour un admin.
const PATCHABLE = {
  username: { type: 'string', minLength: 1, maxLength: 40 },
  bio: nullableString(500),
  username_color: nullableString(32),
  banner_color: nullableString(32),
  avatar_url: nullableString(2048),
  banner_url: nullableString(2048),
  chat_bg_url: nullableString(2048),
  custom_badge_url: nullableString(2048),
  is_anonymous: { type: 'boolean' },
  is_invisible: { type: 'boolean' },
  warnings_count: { type: 'integer', minimum: 0 },
  is_banned: { type: 'boolean' },
}

export default async function meRoutes(app) {
  // Profil complet (équivalent de select('*') sur son propre profil).
  app.get('/', async (request) => {
    const row = await request.tx(async (c) => {
      const { rows } = await c.query('SELECT * FROM public.profiles WHERE id = $1', [request.user.id])
      return rows[0]
    })
    if (!row) throw notFound('Profil introuvable')
    return row
  })

  app.patch('/', {
    schema: {
      body: { type: 'object', additionalProperties: false, minProperties: 1, properties: PATCHABLE },
    },
  }, async (request) => {
    const entries = Object.entries(request.body)
    const sets = entries.map(([key], i) => `${key} = $${i + 2}`)
    const row = await request.tx(async (c) => {
      const { rows } = await c.query(
        `UPDATE public.profiles SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [request.user.id, ...entries.map(([, v]) => (typeof v === 'string' ? v.trim() : v))],
      )
      return rows[0]
    })
    if (!row) throw notFound('Profil introuvable')
    return row
  })

  // Données de la barre latérale (App.vue) : suivis, abonnés, amis mutuels.
  app.get('/social', async (request) => {
    return request.tx(async (c) => {
      const me = request.user.id
      const [following, followers] = await Promise.all([
        c.query('SELECT following_id FROM public.follows WHERE follower_id = $1', [me]),
        c.query('SELECT follower_id FROM public.follows WHERE following_id = $1', [me]),
      ])
      const followingIds = following.rows.map((r) => r.following_id)
      const followerIds = followers.rows.map((r) => r.follower_id)
      const followerSet = new Set(followerIds)
      const mutualIds = followingIds.filter((id) => followerSet.has(id))
      const { rows: mutuals } = mutualIds.length
        ? await c.query('SELECT id, username, avatar_url FROM public.profiles WHERE id = ANY($1::uuid[])', [mutualIds])
        : { rows: [] }
      return { following_ids: followingIds, follower_ids: followerIds, mutuals }
    })
  })
}
