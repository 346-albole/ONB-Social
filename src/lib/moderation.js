import { supabase } from './supabaseClient'

const forbiddenWordsCacheTtlMs = 15000
const emptyForbiddenWordsCacheTtlMs = 5000
let cachedForbiddenMatchers = []
let cachedForbiddenWordsAt = 0
let hasFetchedForbiddenWords = false
let fetchForbiddenWordsPromise = null

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const buildForbiddenMatchers = (forbiddenWords) => (forbiddenWords || [])
  .map(entry => {
    const normalizedWord = entry?.word?.toLowerCase().trim()
    if (!normalizedWord) return null

    const escapedWord = escapeRegExp(normalizedWord)
    
    // Support wildcard syntax: "a&b" blocks anything containing "a" followed by "b"
    if (normalizedWord.includes('&')) {
      const regexPattern = normalizedWord.split('&').map(escapeRegExp).join('.*')
      return {
        word: entry.word,
        normalizedWord,
        regex: new RegExp(regexPattern, 'i')
      }
    }

    if (/^[a-z0-9]+$/.test(normalizedWord)) {
      return {
        word: entry.word,
        normalizedWord,
        regex: new RegExp(`\\b${escapedWord}\\b`, 'i')
      }
    }

    return {
      word: entry.word,
      normalizedWord,
      regex: null
    }
  })
  .filter(Boolean)

const fetchForbiddenWords = async () => {
  if (fetchForbiddenWordsPromise) return fetchForbiddenWordsPromise
  fetchForbiddenWordsPromise = supabase
    .from('forbidden_words')
    .select('word')
    .eq('enabled', true)

  try {
    return await fetchForbiddenWordsPromise
  } finally {
    fetchForbiddenWordsPromise = null
  }
}

/**
 * Checks if text contains forbidden words from the moderation list.
 * Handles warnings and bans automatically.
 * @param {string} text - The text to check.
 * @param {object} profile - The current user's profile.
 * @returns {Promise<{blocked: boolean, reason?: string}>}
 */
export async function checkModeration(text, profile) {
  if (!text || !profile) return { blocked: false }

  const now = Date.now()
  const cacheTtlMs = cachedForbiddenMatchers.length ? forbiddenWordsCacheTtlMs : emptyForbiddenWordsCacheTtlMs
  const cacheFresh = hasFetchedForbiddenWords && now - cachedForbiddenWordsAt < cacheTtlMs
  if (!cacheFresh) {
    const { data: forbiddenWords, error } = await fetchForbiddenWords()

    if (error) {
      console.error('[Moderation] Failed to load forbidden words:', error)
    } else if (Array.isArray(forbiddenWords)) {
      cachedForbiddenMatchers = buildForbiddenMatchers(forbiddenWords)
      cachedForbiddenWordsAt = now
      hasFetchedForbiddenWords = true
    }
  }

  if (!cachedForbiddenMatchers.length) {
    return { blocked: false }
  }

  const normalizedText = text.toLowerCase()
  const matchedWord = cachedForbiddenMatchers.find(matcher => (
    matcher.regex ? matcher.regex.test(normalizedText) : normalizedText.includes(matcher.normalizedWord)
  ))

  if (matchedWord) {
    const currentWarnings = profile.warnings_count || 0

    if (currentWarnings === 0) {
      // First warning
      await supabase
        .from('profiles')
        .update({ warnings_count: 1 })
        .eq('id', profile.id)
      
      return {
        blocked: true,
        reason: `AVERTISSEMENT : L'utilisation du terme "${matchedWord.word}" est interdite. Une deuxième tentative entraînera le blocage définitif de votre compte.`
      }
    } else {
      // Second strike: Ban
      await supabase
        .from('profiles')
        .update({ is_banned: true })
        .eq('id', profile.id)
      
      return {
        blocked: true,
        reason: "COMPTE BLOQUÉ : Vous avez enfreint les règles de modération à deux reprises. Votre compte est désormais suspendu."
      }
    }
  }

  return { blocked: false }
}
