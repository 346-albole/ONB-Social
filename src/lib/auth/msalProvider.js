/**
 * Fournisseur d'auth Microsoft Entra ID (MSAL) — SQUELETTE, non implémenté.
 *
 * À activer plus tard avec VITE_AUTH_PROVIDER=msal, après :
 *   npm install @azure/msal-browser
 *
 * Variables attendues (front, préfixe VITE_) :
 *   VITE_MSAL_TENANT_ID     ID du tenant Entra (GUID)
 *   VITE_MSAL_CLIENT_ID     ID d'application (client) de la SPA
 *   VITE_MSAL_API_SCOPE     scope exposé par l'API, ex. api://<client-id-api>/access_as_user
 *   VITE_MSAL_REDIRECT_URI  (optionnel) défaut : <origin>/auth/callback
 *
 * Côté API (aucun changement de code, uniquement des variables) :
 *   AUTH_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
 *   AUTH_AUDIENCE=<client-id-api>          (ou api://<client-id-api> selon la version du token)
 *   AUTH_JWKS_URL=https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys
 *   AUTH_USER_ID_CLAIM=oid
 *   DEV_AUTH_ENABLED=false
 *
 * Contrat à respecter (voir ./index.js) :
 *   loginMode: 'redirect'
 *   init()            → handleRedirectPromise(), puis compte actif → setUser(...)
 *   login()           → loginRedirect({ scopes: [VITE_MSAL_API_SCOPE] })
 *   logout()          → logoutRedirect()
 *   getAccessToken()  → acquireTokenSilent(), repli sur acquireTokenRedirect()
 *
 * Implémentation de référence (à décommenter) :
 *
 * import { PublicClientApplication, InteractionRequiredAuthError } from '@azure/msal-browser'
 *
 * const tenantId    = import.meta.env.VITE_MSAL_TENANT_ID
 * const clientId    = import.meta.env.VITE_MSAL_CLIENT_ID
 * const apiScope    = import.meta.env.VITE_MSAL_API_SCOPE
 * const redirectUri = import.meta.env.VITE_MSAL_REDIRECT_URI || `${window.location.origin}/auth/callback`
 *
 * function userFromAccount(account) {
 *   const claims = account.idTokenClaims || {}
 *   return {
 *     id: claims.oid || account.localAccountId,   // = profiles.id côté API
 *     email: claims.email || account.username || null,
 *     username: claims.preferred_username || account.username || null,
 *     name: claims.name || account.name || null,
 *   }
 * }
 *
 * export function createProvider({ setUser }) {
 *   const msal = new PublicClientApplication({
 *     auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}`, redirectUri },
 *     cache: { cacheLocation: 'localStorage' },
 *   })
 *   const request = { scopes: [apiScope] }
 *
 *   return {
 *     loginMode: 'redirect',
 *
 *     async init() {
 *       await msal.initialize()
 *       const result = await msal.handleRedirectPromise()
 *       const account = result?.account || msal.getAllAccounts()[0] || null
 *       if (account) msal.setActiveAccount(account)
 *       setUser(account ? userFromAccount(account) : null)
 *     },
 *
 *     async login() {
 *       await msal.loginRedirect(request)
 *     },
 *
 *     async logout() {
 *       await msal.logoutRedirect({ postLogoutRedirectUri: `${window.location.origin}/auth` })
 *     },
 *
 *     async getAccessToken() {
 *       const account = msal.getActiveAccount()
 *       if (!account) return null
 *       try {
 *         const { accessToken } = await msal.acquireTokenSilent({ ...request, account })
 *         return accessToken
 *       } catch (err) {
 *         if (err instanceof InteractionRequiredAuthError) await msal.acquireTokenRedirect(request)
 *         throw err
 *       }
 *     },
 *   }
 * }
 */

export function createProvider() {
  throw new Error(
    'Fournisseur MSAL non implémenté : voir src/lib/auth/msalProvider.js (installer @azure/msal-browser et décommenter).',
  )
}
