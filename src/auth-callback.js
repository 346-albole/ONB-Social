// Point d'entrée de la page « redirect bridge » (auth/callback.html).
// Embarqué dans le build et servi depuis la même origine (jamais depuis un CDN).
import { broadcastResponseToMainFrame } from '@azure/msal-browser/redirect-bridge'

broadcastResponseToMainFrame().catch((err) => {
  console.error('[auth] redirect bridge :', err)
  window.location.replace('/auth')
})
