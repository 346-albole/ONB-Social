/**
 * Fournisseur d'auth Microsoft Entra ID (MSAL, flux redirect + PKCE).
 * Activé par VITE_AUTH_PROVIDER=msal.
 *
 * Variables (front, préfixe VITE_, injectées au build) :
 *   VITE_MSAL_TENANT_ID     ID du tenant Entra (single tenant)
 *   VITE_MSAL_CLIENT_ID     ID d'application (client) — app registration unique SPA + API
 *   VITE_MSAL_API_SCOPE     défaut : api://<client-id>/access_as_user
 *   VITE_MSAL_REDIRECT_URI  défaut : <origine>/auth/callback (page « redirect bridge »)
 *
 * MSAL v5 : la réponse d'Entra arrive sur la page bridge (auth/callback.html),
 * qui la transmet à la page d'origine ; handleRedirectPromise() la traite ici.
 */
import { InteractionRequiredAuthError, PublicClientApplication } from '@azure/msal-browser'

const tenantId = import.meta.env.VITE_MSAL_TENANT_ID
const clientId = import.meta.env.VITE_MSAL_CLIENT_ID
const apiScope = import.meta.env.VITE_MSAL_API_SCOPE || (clientId && `api://${clientId}/access_as_user`)
const redirectUri = import.meta.env.VITE_MSAL_REDIRECT_URI || `${window.location.origin}/auth/callback`

function userFromAccount(account) {
  const claims = account.idTokenClaims || {}
  return {
    id: claims.oid || account.localAccountId, // = profiles.id côté API (claim oid)
    email: claims.email || (String(account.username || '').includes('@') ? account.username : null),
    username: claims.preferred_username || account.username || null,
    name: claims.name || account.name || null,
  }
}

export function createProvider({ setUser }) {
  if (!tenantId || !clientId) {
    throw new Error('MSAL : VITE_MSAL_TENANT_ID et VITE_MSAL_CLIENT_ID sont requis.')
  }

  const msal = new PublicClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
      redirectUri,
      postLogoutRedirectUri: `${window.location.origin}/auth`,
    },
    cache: { cacheLocation: 'localStorage' },
  })
  const tokenRequest = { scopes: [apiScope] }
  let redirectTarget = null

  function activeAccount() {
    return msal.getActiveAccount() || msal.getAllAccounts()[0] || null
  }

  return {
    loginMode: 'redirect',

    async init() {
      await msal.initialize()
      // Traite le retour de redirection (null hors retour, ou si sessionStorage est indisponible).
      const result = await msal.handleRedirectPromise()
      if (result?.account) msal.setActiveAccount(result.account)
      if (result?.state && result.state.startsWith('/')) redirectTarget = result.state
      const account = activeAccount()
      if (account) msal.setActiveAccount(account)
      setUser(account ? userFromAccount(account) : null)
    },

    // Redirige vers Microsoft ; `redirectTo` est restitué après connexion.
    async login({ redirectTo } = {}) {
      await msal.loginRedirect({ ...tokenRequest, state: redirectTo || '/' })
    },

    async logout() {
      const account = activeAccount()
      await msal.logoutRedirect({ account, postLogoutRedirectUri: `${window.location.origin}/auth` })
    },

    // Session locale effacée sans déconnexion Microsoft (ex. token refusé par l'API).
    async clearSession() {
      msal.setActiveAccount(null)
      await msal.clearCache()
      setUser(null)
    },

    async getAccessToken() {
      const account = activeAccount()
      if (!account) return null
      try {
        const { accessToken } = await msal.acquireTokenSilent({ ...tokenRequest, account })
        return accessToken
      } catch (err) {
        if (err instanceof InteractionRequiredAuthError) {
          await msal.acquireTokenRedirect({ ...tokenRequest, account, state: window.location.pathname })
        }
        throw err
      }
    },

    consumeRedirectTarget() {
      const target = redirectTarget
      redirectTarget = null
      return target
    },
  }
}
