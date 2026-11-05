// Fragments partagés par les routes : schémas de paramètres et projections SQL.
// Les réponses reprennent la forme des embeds PostgREST utilisés par le front
// (ex. `profiles: {...}`, `likes: [{ count }]`) pour limiter les changements.

export const uuidParam = (name = 'id') => ({
  type: 'object',
  required: [name],
  properties: { [name]: { type: 'string', format: 'uuid' } },
})

export const bigintParam = (name = 'id') => ({
  type: 'object',
  required: [name],
  properties: { [name]: { type: 'integer', minimum: 1 } },
})

// Colonnes publiques d'un profil (lecture par les autres utilisateurs).
export const PUBLIC_PROFILE_COLUMNS = [
  'id', 'username', 'avatar_url', 'bio', 'is_premium', 'is_official', 'is_admin',
  'username_color', 'banner_color', 'banner_url', 'custom_badge_url',
  'is_anonymous', 'created_at',
]

/** `json_build_object('id', alias.id, …)` pour une liste de colonnes. */
export function jsonObject(alias, columns) {
  return `json_build_object(${columns.map((c) => `'${c}', ${alias}.${c}`).join(', ')})`
}

export const publicProfileSelect = (alias = 'p') =>
  PUBLIC_PROFILE_COLUMNS.map((c) => `${alias}.${c}`).join(', ')
