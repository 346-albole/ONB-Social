/**
 * Upload de fichiers via l'API (POST /api/files, adaptateur de stockage côté serveur).
 *
 *   const { url, error } = await uploadFile(file, 'post')
 *
 * kind : post | reel | avatar | banner | badge | chat-bg | dm | forum | group-banner
 * L'URL renvoyée est à enregistrer telle quelle (media_url, avatar_url, …).
 */
import { api } from './api'

export async function uploadFile(file, kind) {
  const form = new FormData()
  form.append('kind', kind) // doit précéder le fichier
  form.append('file', file, file.name || 'upload')
  const { data, error } = await api.post('/files', form)
  return { url: data?.url ?? null, key: data?.key ?? null, error }
}

/** true si l'URL désigne un média servi par notre API (et non une URL externe). */
export function isOwnMediaUrl(url) {
  try {
    return new URL(url, window.location.href).origin === window.location.origin
  } catch {
    return false
  }
}
