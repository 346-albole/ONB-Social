// Contenu de site lu par tous les utilisateurs connectés : annonces, broadcasts
// admin actifs, mots interdits actifs (moderation.js côté navigateur).

export default async function contentRoutes(app) {
  // Bannières texte actives (HomeView : 3 plus récentes).
  app.get('/announcements/active', async (request) => {
    return request.tx(async (c) => {
      const { rows } = await c.query(
        `SELECT * FROM public.announcements WHERE active = true
          ORDER BY created_at DESC LIMIT 3`,
      )
      return rows
    })
  })

  // Dernier broadcast HTML/JS actif (HomeView).
  app.get('/broadcasts/active', async (request) => {
    return request.tx(async (c) => {
      const { rows } = await c.query(
        `SELECT * FROM public.admin_broadcasts WHERE active = true
          ORDER BY created_at DESC LIMIT 1`,
      )
      return rows
    })
  })

  // Mots interdits actifs (policy forbidden_words_select_enabled).
  app.get('/moderation/forbidden-words', async (request) => {
    return request.tx(async (c) => {
      const { rows } = await c.query('SELECT word FROM public.forbidden_words WHERE enabled = true')
      return rows
    })
  })
}
