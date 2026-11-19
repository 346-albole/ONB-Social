/**
 * Client unique de l'API ONB-Social.
 *
 * Chaque méthode retourne `{ data, error }` et ne lève jamais d'exception
 * (même convention que l'ancien client Supabase, pour limiter les changements
 * dans les vues) :
 *
 *   const { data, error } = await api.get('/posts', { query: { kind: 'reels' } })
 *   const { data, error } = await api.post('/posts', { caption, media_url })
 *   const { error }       = await api.del(`/posts/${id}`)
 *
 * `error` = { message, code, status }. Un 401 efface la session locale (App.vue
 * redirige alors vers /auth).
 */
import { auth } from './auth'

const BASE_URL = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')

function buildUrl(path, query) {
  const url = `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`
  if (!query) return url
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.append(key, String(value))
  }
  const qs = params.toString()
  return qs ? `${url}?${qs}` : url
}

async function request(method, path, { query, body, signal } = {}) {
  const headers = {}
  const token = await auth.getAccessToken().catch(() => null)
  if (token) headers.authorization = `Bearer ${token}`

  let payload
  if (body instanceof FormData) {
    payload = body
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }

  let res
  try {
    res = await fetch(buildUrl(path, query), { method, headers, body: payload, signal })
  } catch (err) {
    return { data: null, error: { message: err.message || 'Erreur réseau', code: 'network', status: 0 } }
  }

  const text = res.status === 204 ? '' : await res.text()
  let json = null
  if (text) {
    try { json = JSON.parse(text) } catch { json = null }
  }

  if (!res.ok) {
    // Token refusé : on oublie la session locale (sans redirection vers le fournisseur)
    if (res.status === 401 && token) await auth.clearSession()
    const err = json?.error || {}
    return {
      data: null,
      error: { message: err.message || res.statusText || 'Erreur', code: err.code || 'http', status: res.status },
    }
  }
  return { data: json, error: null }
}

export const api = {
  get: (path, opts) => request('GET', path, opts),
  post: (path, body, opts) => request('POST', path, { ...opts, body }),
  put: (path, body, opts) => request('PUT', path, { ...opts, body }),
  patch: (path, body, opts) => request('PATCH', path, { ...opts, body }),
  del: (path, opts) => request('DELETE', path, opts),
}
