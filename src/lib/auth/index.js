/**
 * Module d'authentification — interface commune à tous les fournisseurs.
 *
 *   await auth.init()          restaure la session (et traite un retour de redirection)
 *   await auth.login(options)  connecte l'utilisateur (dev : { username } ; MSAL : redirection)
 *   await auth.logout()        déconnecte (MSAL : déconnexion Microsoft par redirection)
 *   await auth.clearSession()  oublie la session locale sans redirection (ex. 401 de l'API)
 *   auth.consumeRedirectTarget() page à rouvrir après un retour de connexion (MSAL), ou null
 *   await auth.getAccessToken() token Bearer pour l'API, ou null si non connecté
 *   auth.user                  ref Vue : { id, email, username, name } ou null
 *   auth.loginMode             'username' (formulaire dev) | 'redirect' (bouton Microsoft)
 *
 * Fournisseur choisi par VITE_AUTH_PROVIDER : 'dev' (défaut) ou 'msal'.
 * Un fournisseur est un module exportant `createProvider({ setUser })` qui
 * retourne { loginMode, init, login, logout, clearSession, getAccessToken,
 * consumeRedirectTarget }.
 */
import { ref, readonly } from 'vue'

const PROVIDERS = {
  dev: () => import('./devProvider.js'),
  msal: () => import('./msalProvider.js'),
}

const providerName = import.meta.env.VITE_AUTH_PROVIDER || 'dev'
const user = ref(null)
let provider = null
let providerPromise = null
let initPromise = null

function setUser(value) {
  user.value = value
}

// Une seule instance de fournisseur, même si plusieurs appels arrivent avant
// la fin du chargement (ex. aiBrain.js appelle l'API dès l'import).
function getProvider() {
  if (!providerPromise) {
    const load = PROVIDERS[providerName]
    providerPromise = load
      ? load().then((mod) => (provider = mod.createProvider({ setUser })))
      : Promise.reject(new Error(`VITE_AUTH_PROVIDER inconnu : ${providerName}`))
  }
  return providerPromise
}

export const auth = {
  user: readonly(user),
  providerName,

  get loginMode() {
    return provider?.loginMode ?? (providerName === 'dev' ? 'username' : 'redirect')
  },

  init() {
    if (!initPromise) {
      initPromise = getProvider().then((p) => p.init())
    }
    return initPromise
  },

  async login(options = {}) {
    const p = await getProvider()
    return p.login(options)
  },

  async logout() {
    const p = await getProvider()
    await p.logout()
    setUser(null)
  },

  async clearSession() {
    const p = await getProvider()
    await p.clearSession()
    setUser(null)
  },

  consumeRedirectTarget() {
    return provider?.consumeRedirectTarget?.() ?? null
  },

  async getAccessToken() {
    // La session doit être restaurée avant de fournir un token.
    await auth.init()
    const p = await getProvider()
    return p.getAccessToken()
  },
}
