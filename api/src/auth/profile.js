// Création du profil à la première requête authentifiée (remplace l'ancien
// trigger Supabase handle_new_user sur auth.users).
import { withRls } from '../db.js'

// Profils déjà vérifiés par ce processus (évite une requête par appel).
const ensured = new Set()

function baseUsername(identity) {
  const raw = String(identity.username || identity.email || 'user').split('@')[0]
  const cleaned = raw.normalize('NFKD').replace(/[^\w.-]/g, '').slice(0, 24)
  return cleaned || 'user'
}

/** Garantit l'existence de profiles(id) pour l'utilisateur authentifié. */
export async function ensureProfile(identity) {
  if (ensured.has(identity.id)) return

  await withRls(identity.id, async (client) => {
    const { rowCount } = await client.query('SELECT 1 FROM public.profiles WHERE id = $1', [identity.id])
    if (rowCount) return

    const base = baseUsername(identity)
    // username est UNIQUE : suffixe numérique en cas de collision.
    for (let attempt = 0; attempt < 20; attempt++) {
      const username = attempt === 0 ? base : `${base}${Math.floor(1000 + Math.random() * 9000)}`
      await client.query('SAVEPOINT ensure_profile')
      try {
        await client.query(
          `INSERT INTO public.profiles (id, email, username, full_name, updated_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (id) DO NOTHING`,
          [identity.id, identity.email, username, identity.name],
        )
        await client.query('RELEASE SAVEPOINT ensure_profile')
        return
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT ensure_profile')
        if (err.code !== '23505') throw err
      }
    }
    throw new Error('Impossible de générer un nom d’utilisateur unique')
  })

  ensured.add(identity.id)
}

/** À appeler si un profil est supprimé (ex. par un admin). */
export function forgetProfile(id) {
  ensured.delete(id)
}
