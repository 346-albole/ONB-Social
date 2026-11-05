/**
 * Fournisseur d'auth « dev » : se connecte au fournisseur de tokens local de
 * l'API (POST /api/dev-auth/login, actif seulement si DEV_AUTH_ENABLED=true).
 * Le token est conservé dans localStorage jusqu'à son expiration.
 */
const STORAGE_KEY = 'onb-social-dev-token'
const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api'
const USER_ID_CLAIM = import.meta.env.VITE_AUTH_USER_ID_CLAIM || 'oid'

function decodePayload(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = decodeURIComponent(
      atob(part).split('').map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''),
    )
    return JSON.parse(json)
  } catch {
    return null
  }
}

function isExpired(claims) {
  return !claims?.exp || claims.exp * 1000 <= Date.now() + 30_000
}

function userFromClaims(claims) {
  return {
    id: claims[USER_ID_CLAIM],
    email: claims.email || null,
    username: claims.preferred_username || claims.name || null,
    name: claims.name || null,
  }
}

function readToken() {
  try { return localStorage.getItem(STORAGE_KEY) } catch { return null }
}

function writeToken(token) {
  try {
    if (token) localStorage.setItem(STORAGE_KEY, token)
    else localStorage.removeItem(STORAGE_KEY)
  } catch { /* stockage indisponible : session limitée à l'onglet */ }
}

export function createProvider({ setUser }) {
  let token = null

  function clear() {
    token = null
    writeToken(null)
    setUser(null)
  }

  return {
    loginMode: 'username',

    async init() {
      const stored = readToken()
      const claims = stored && decodePayload(stored)
      if (claims && !isExpired(claims)) {
        token = stored
        setUser(userFromClaims(claims))
      } else if (stored) {
        clear()
      }
    },

    async login({ username } = {}) {
      const res = await fetch(`${API_BASE}/dev-auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error?.message || `Connexion impossible (${res.status})`)
      token = body.access_token
      writeToken(token)
      setUser(userFromClaims(decodePayload(token)))
    },

    async logout() {
      clear()
    },

    async getAccessToken() {
      if (!token) return null
      if (isExpired(decodePayload(token))) {
        clear()
        return null
      }
      return token
    },
  }
}
