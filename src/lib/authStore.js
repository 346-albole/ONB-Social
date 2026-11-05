/**
 * Accès partagé à la session courante, construit sur le module d'auth.
 * Interface conservée pour les vues : `getCurrentSession().user.id`, etc.
 *
 * session = { user: { id, email, username, name } } ou null
 */
import { computed, ref } from 'vue'
import { auth } from './auth'

const _ready = ref(false)

/** Initialise l'auth une seule fois (router + App.vue). */
export async function initAuth() {
  try {
    await auth.init()
  } catch (err) {
    console.error('[auth] initialisation impossible :', err)
  } finally {
    _ready.value = true
  }
}

/** Ref réactive de la session (null si déconnecté). */
export const sessionRef = computed(() => (auth.user.value ? { user: auth.user.value } : null))

/** Session courante, sans appel réseau. */
export function getCurrentSession() {
  return sessionRef.value
}

/** true une fois la session résolue au moins une fois. */
export const authReady = _ready
