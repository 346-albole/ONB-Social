// Réglages du site et statistiques globales (contexte de l'IA embarquée).

export default async function siteRoutes(app) {
  // Lisible sans être connecté (aiBrain.js l'interroge au chargement de l'app).
  app.get('/site-settings', { config: { auth: 'optional' } }, async (request) => {
    return request.tx(async (c) => {
      const { rows } = await c.query('SELECT is_troll_mode, updated_at FROM public.site_settings WHERE id = 1')
      return rows[0] ?? { is_troll_mode: false }
    })
  })

  // Nombre d'utilisateurs et de posts (aiBrain.js, AiView).
  app.get('/stats', async (request) => {
    return request.tx(async (c) => {
      const { rows } = await c.query(
        `SELECT (SELECT count(*) FROM public.profiles) AS users,
                (SELECT count(*) FROM public.posts)    AS posts`,
      )
      return rows[0]
    })
  })
}
