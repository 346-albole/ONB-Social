/**
 * pushNotifications.js
 * Basé sur le pattern qui fonctionne dans ONBgram (chat.html).
 * - La permission est demandée quand l'utilisateur active le toggle
 * - localStorage persiste le choix entre sessions
 * - triggerNotification vérifie document.hidden avant d'envoyer
 */

const STORAGE_KEY = 'onb_notifs'

/** Retourne true si les notifs sont activées dans localStorage */
export function areNotifsEnabled() {
  return localStorage.getItem(STORAGE_KEY) === 'true'
}

/**
 * Appelé quand l'utilisateur clique sur le toggle navigateur dans le profil.
 * Demande la permission si on active, sauvegarde dans localStorage.
 * @param {boolean} enable
 * @returns {Promise<boolean>} état final (true = accordé)
 */
export async function setNotifsEnabled(enable) {
  if (!('Notification' in window)) return false

  if (!enable) {
    localStorage.setItem(STORAGE_KEY, 'false')
    return false
  }

  // Demander la permission si pas encore fait
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') {
    localStorage.setItem(STORAGE_KEY, 'false')
    return false
  }

  localStorage.setItem(STORAGE_KEY, 'true')

  // Notification de confirmation comme dans ONBgram
  new Notification('ONBSocial', { body: 'Notifications activées !', icon: '/favicon.ico' })
  return true
}

/**
 * Déclenche une notification navigateur.
 * Même logique que triggerNotification() dans chat.html :
 * - Vérifie localStorage
 * - Vérifie permission
 * - La logique document.hidden est gérée par l'appelant (ChatView/GroupsView)
 *
 * @param {string} title    - Titre affiché
 * @param {string} body     - Corps du message
 * @param {Function} onClick - Callback quand on clique sur la notif
 */
export function triggerNotification(title, body, onClick = null) {
  // Mêmes vérifications que dans chat.html
  if (localStorage.getItem(STORAGE_KEY) !== 'true') return
  if (!('Notification' in window)) return
  if (Notification.permission !== 'granted') return
  try {
    const notif = new Notification(title, {
      body,
      icon: '/favicon.ico',
      badge: '/favicon.ico',
    })
    notif.addEventListener('click', () => {
      window.focus()
      if (onClick) onClick()
      notif.close()
    })
  } catch (e) {
    console.warn('[notif] Erreur:', e)
  }
}

/** Permission actuelle du navigateur */
export function getPermissionStatus() {
  if (!('Notification' in window)) return 'unsupported'
  return Notification.permission // 'default' | 'granted' | 'denied'
}
