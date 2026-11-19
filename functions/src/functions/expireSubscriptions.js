// Function timer quotidienne : expire les abonnements arrivés à échéance.
import { app } from '@azure/functions'
import { dbConfigFromEnv, expireLapsedSubscriptions } from '../expireSubscriptions.js'

// NCRONTAB (6 champs : seconde minute heure jour mois jour-de-semaine), en UTC :
// WEBSITE_TIME_ZONE / TZ ne sont pas supportés sur Linux / Flex Consumption.
// 02:00 UTC = 03:00 en Suisse l'hiver (CET, UTC+1) et 04:00 l'été (CEST, UTC+2) :
// toujours en pleine nuit, quel que soit le changement d'heure.
const SCHEDULE = '0 0 2 * * *'

app.timer('expireSubscriptions', {
  schedule: SCHEDULE,
  runOnStartup: false,
  handler: async (timer, context) => {
    if (timer.isPastDue) context.warn('Exécution en retard sur le planning (isPastDue).')
    const started = Date.now()
    try {
      const expired = await expireLapsedSubscriptions(dbConfigFromEnv())
      const duration = Date.now() - started
      if (expired === null) {
        context.log(`expire_lapsed_subscriptions() : succès (${duration} ms).`)
      } else {
        context.log(`expire_lapsed_subscriptions() : succès — ${expired} abonnement(s) expiré(s) (${duration} ms).`)
      }
    } catch (err) {
      context.error(`expire_lapsed_subscriptions() : ÉCHEC — ${err.message}`)
      throw err // invocation marquée en échec (visible dans Application Insights)
    }
  },
})
