import { ref, computed } from 'vue'

const LANG_KEY = 'onb_lang'

const translations = {
  en: {
    // Nav
    feed: 'Feed',
    reels: 'Reels',
    explore: 'Explore',
    groups: 'Groups',
    forum: 'Forum',
    messages: 'Messages',
    globalChat: 'Global Chat',
    profile: 'Profile',
    admin: 'Admin',
    coins: 'ONB Coins',
    onbia: 'ONB-IA',
    signOut: 'Sign out',
    whatsNew: "What's New",

    // Global Chat
    gcTitle: 'Global Chat',
    gcSubtitle: 'Open discussion for all members',
    gcOnline: 'online',
    gcPlaceholder: 'Write a message to everyone…',
    gcEmpty: 'No messages yet — be the first!',
    gcLogin: 'Sign in to join the global chat',
    gcSave: 'Save',
    gcCancel: 'Cancel',
    gcEdited: '· edited',
    gcToday: 'Today',
    gcYesterday: 'Yesterday',
    gcDeleteConfirm: 'Delete this message?',

    // Auth
    signIn: 'Sign In',
    signUp: 'Sign Up',
    email: 'Email',
    password: 'Password',
    verifyEmail: 'Verify your email',

    // Renewal modal
    renewalTitle: 'Subscription expiring soon',
    renewalIntro: 'The following subscriptions expire in less than 7 days:',
    remindLater: 'Remind me later',
    goToCoins: 'Go to ONB Coins',
    today: 'today',
    inDays: (n) => `in ${n} day${n !== 1 ? 's' : ''}`,
  },

  fr: {
    feed: 'Fil',
    reels: 'Reels',
    explore: 'Explorer',
    groups: 'Groupes',
    forum: 'Forum',
    messages: 'Messages',
    globalChat: 'Chat Global',
    profile: 'Profil',
    admin: 'Admin',
    coins: 'ONB Coins',
    onbia: 'ONB-IA',
    signOut: 'Déconnexion',
    whatsNew: 'Nouveautés',

    gcTitle: 'Chat Global',
    gcSubtitle: 'Discussion ouverte à tous les membres',
    gcOnline: 'en ligne',
    gcPlaceholder: 'Écrire un message à tout le monde…',
    gcEmpty: 'Aucun message — sois le premier !',
    gcLogin: 'Connectez-vous pour participer au chat global',
    gcSave: 'Sauvegarder',
    gcCancel: 'Annuler',
    gcEdited: '· modifié',
    gcToday: "Aujourd'hui",
    gcYesterday: 'Hier',
    gcDeleteConfirm: 'Supprimer ce message ?',

    signIn: 'Se connecter',
    signUp: "S'inscrire",
    email: 'Email',
    password: 'Mot de passe',
    verifyEmail: 'Vérifiez votre email',

    renewalTitle: 'Abonnement expirant bientôt',
    renewalIntro: 'Les abonnements suivants expirent dans moins de 7 jours :',
    remindLater: 'Me rappeler plus tard',
    goToCoins: 'Aller aux ONB Coins',
    today: "aujourd'hui",
    inDays: (n) => `dans ${n} jour${n !== 1 ? 's' : ''}`,
  },

  de: {
    feed: 'Feed',
    reels: 'Reels',
    explore: 'Entdecken',
    groups: 'Gruppen',
    forum: 'Forum',
    messages: 'Nachrichten',
    globalChat: 'Globaler Chat',
    profile: 'Profil',
    admin: 'Admin',
    coins: 'ONB Coins',
    onbia: 'ONB-IA',
    signOut: 'Abmelden',
    whatsNew: 'Neuigkeiten',

    gcTitle: 'Globaler Chat',
    gcSubtitle: 'Offene Diskussion für alle Mitglieder',
    gcOnline: 'online',
    gcPlaceholder: 'Schreib eine Nachricht an alle…',
    gcEmpty: 'Noch keine Nachrichten — sei der Erste!',
    gcLogin: 'Anmelden, um am globalen Chat teilzunehmen',
    gcSave: 'Speichern',
    gcCancel: 'Abbrechen',
    gcEdited: '· bearbeitet',
    gcToday: 'Heute',
    gcYesterday: 'Gestern',
    gcDeleteConfirm: 'Diese Nachricht löschen?',

    signIn: 'Anmelden',
    signUp: 'Registrieren',
    email: 'E-Mail',
    password: 'Passwort',
    verifyEmail: 'E-Mail bestätigen',

    renewalTitle: 'Abonnement läuft bald ab',
    renewalIntro: 'Folgende Abonnements laufen in weniger als 7 Tagen ab:',
    remindLater: 'Später erinnern',
    goToCoins: 'Zu ONB Coins',
    today: 'heute',
    inDays: (n) => `in ${n} Tag${n !== 1 ? 'en' : ''}`,
  },

  ukr: {
    feed: 'Стрічка',
    reels: 'Рілс',
    explore: 'Огляд',
    groups: 'Групи',
    forum: 'Форум',
    messages: 'Повідомлення',
    globalChat: 'Глобальний чат',
    profile: 'Профіль',
    admin: 'Адмін',
    coins: 'ONB Монети',
    onbia: 'ONB-IA',
    signOut: 'Вийти',
    whatsNew: 'Що нового',

    gcTitle: 'Глобальний чат',
    gcSubtitle: 'Відкрите спілкування для всіх учасників',
    gcOnline: 'онлайн',
    gcPlaceholder: 'Написати повідомлення для всіх…',
    gcEmpty: 'Повідомлень ще немає — будь першим!',
    gcLogin: 'Увійдіть, щоб приєднатися до глобального чату',
    gcSave: 'Зберегти',
    gcCancel: 'Скасувати',
    gcEdited: '· змінено',
    gcToday: 'Сьогодні',
    gcYesterday: 'Вчора',
    gcDeleteConfirm: 'Видалити це повідомлення?',

    signIn: 'Увійти',
    signUp: 'Зареєструватися',
    email: 'Електронна пошта',
    password: 'Пароль',
    verifyEmail: 'Підтвердіть email',

    renewalTitle: 'Підписка скоро закінчиться',
    renewalIntro: 'Наступні підписки закінчаться менш ніж через 7 днів:',
    remindLater: 'Нагадати пізніше',
    goToCoins: 'Перейти до ONB Coins',
    today: 'сьогодні',
    inDays: (n) => `через ${n} ${n === 1 ? 'день' : n < 5 ? 'дні' : 'днів'}`,
  },
}

export const LANGS = [
  { code: 'en', label: 'EN' },
  { code: 'fr', label: 'FR' },
  { code: 'de', label: 'DE' },
  { code: 'ukr', label: 'UA' },
]

const savedLang = localStorage.getItem(LANG_KEY) || 'en'
export const currentLang = ref(Object.keys(translations).includes(savedLang) ? savedLang : 'en')

export const t = computed(() => translations[currentLang.value] || translations.en)

export function setLang(code) {
  if (translations[code]) {
    currentLang.value = code
    localStorage.setItem(LANG_KEY, code)
  }
}
