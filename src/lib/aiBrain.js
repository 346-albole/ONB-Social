import { supabase } from './supabaseClient'
import { ref } from 'vue'

/**
 * ONB-IA Brain — Powered by @xenova/transformers (Flan-T5-small)
 * 100% local, open-source, no external API calls.
 */

// ── Shared Intelligence Components ─────────────────────────────────────
let pipeline = null
export const modelState = ref('idle') // 'idle' | 'loading' | 'ready' | 'error'
export const loadProgress = ref(0)
export const conversationHistory = ref([]) // Shared across the whole app
export const progressCallbacks = [] // Array of functions (progress: number) => void
export const readyCallbacks = []     // Array of functions () => void
export const isTrollMode = ref(false) // Troll Mode state


// Memory cap: Keep the last 10 turns (20 msgs) to avoid context overflow
const MAX_HISTORY = 10

// ── Site Context (Stats) ───────────────────────────────────────────────
let sessionContext = {
  lastTopic: null,
  userName: "l'ami",
  userCoins: 0,
  isPremium: false,
  siteUsers: 0,
  sitePosts: 0,
}

// ── Model Initialization (Lazy Load) ───────────────────────────────────
export async function loadModel() {
  if (modelState.value === 'ready' || modelState.value === 'loading') return
  modelState.value = 'loading'

  try {
    const { pipeline: createPipeline, env } = await import('@xenova/transformers')
    env.allowLocalModels = false // Fetch from HF/Hub, model is locally cached

    pipeline = await createPipeline('text2text-generation', 'Xenova/flan-t5-small', {
      progress_callback: (p) => {
        if (p.progress !== undefined) {
          const val = Math.round(p.progress)
          loadProgress.value = val
          progressCallbacks.forEach(cb => cb(val))
        }
      }
    })

    modelState.value = 'ready'
    loadProgress.value = 100
    readyCallbacks.forEach(cb => cb())
  } catch (err) {
    console.warn('[ONB-IA] Weight download failed, switching to Heuristic Brain:', err)
    modelState.value = 'error'
  }
}

// ── Local Site Context Updater ──────────────────────────────────────────
export async function refreshAiContext(profile) {
  try {
    const [uRes, pRes] = await Promise.all([
      supabase.from('profiles').select('id', { count: 'exact', head: true }),
      supabase.from('posts').select('id', { count: 'exact', head: true })
    ])
    sessionContext.siteUsers = uRes.count || 0
    sessionContext.sitePosts = pRes.count || 0
    if (profile) {
      sessionContext.userName = profile.username || "l'ami"
      sessionContext.userCoins = profile.onb_coins || 0
      sessionContext.isPremium = !!profile.is_premium
    }
  } catch (err) { }
}

// ── Prompt Formatting with History ──────────────────────────────────────
function buildContextualPrompt(userMessage) {
  const stats = [
    `Site: ONBSocial, ${sessionContext.siteUsers} membres, ${sessionContext.sitePosts} posts.`,
    `User: ${sessionContext.userName}, ${sessionContext.userCoins} coins, ${sessionContext.isPremium ? 'Premium' : 'Standard'}.`,
    `TON RÔLE: Tu es ONB-IA, un assistant amical et malin. Réponds courtement en FRANÇAIS.`
  ].join(' ')

  // Extract last N turns from history
  const historySnippet = conversationHistory.value
    .slice(-MAX_HISTORY)
    .map(m => `${m.role === 'user' ? 'Utilisateur' : 'AI'}: ${m.content}`)
    .join('\n')

  return `CONTEXT: ${stats}\n\nDIALOGUE:\n${historySnippet}\nUtilisateur: ${userMessage}\nAI:`
}

// ── Shared Brain Core ───────────────────────────────────────────────────
export async function getAiResponse(userMessage, profile) {
  // 1. Update stats and track user message
  await refreshAiContext(profile)
  const historyEntry = { role: 'user', content: userMessage }
  conversationHistory.value.push(historyEntry)

  // 2. Logic: Real model vs Heuristic fallback
  let responseText = ""

  if (modelState.value === 'ready' && pipeline) {
    try {
      const prompt = buildContextualPrompt(userMessage)
      const result = await pipeline(prompt, {
        max_new_tokens: 100,
        temperature: 0.7,
        repetition_penalty: 1.2
      })
      responseText = result[0]?.generated_text?.trim()
    } catch (err) {
      console.warn('[ONB-IA] Gen failed:', err)
    }
  }

  // 3. Heuristic Fallback logic
  if (!responseText || responseText.length < 3) {
    responseText = heuristicFallback(userMessage)
  }

  // 4. Update shared history
  conversationHistory.value.push({ role: 'ai', content: responseText })
  return responseText
}

// ── Fast Heuristic Fallback (Patterns) ─────────────────────────────────
const INTENTS = [
  { id: 'coins', patterns: ['coin', 'argent', 'solde', 'combien'], respond: () => `Tu as ${sessionContext.userCoins.toLocaleString()} coins sur ton compte !` },
  { id: 'premium', patterns: ['premium', 'abo', 'acheter'], respond: () => `Le Premium coûte 6700 coins et t'offre des badges et couleurs uniques.` },
  { id: 'stats', patterns: ['monde', 'membre', 'gens'], respond: () => `On est déjà ${sessionContext.siteUsers} membres sur ONBSocial !` },
  { id: 'greet', patterns: ['bonjour', 'coucou', 'salut', 'hey'], respond: () => `Salut ${sessionContext.userName} ! Comment ça va aujourd'hui ?` },
  { id: 'whoami', patterns: ['mon nom', 'qui suis-je', 'qui je suis'], respond: () => `Tu es ${sessionContext.userName}, fier membre d'ONBSocial.` }
]

function heuristicFallback(message) {
  const low = message.toLowerCase()
  for (const intent of INTENTS) {
    if (intent.patterns.some(p => low.includes(p))) return intent.respond()
  }
  return `C'est une super question. Explore donc les sections "What's New" ou "Premium" pour en savoir plus !`
}

export function clearHistory() {
  conversationHistory.value = []
}

// ── Global Settings (Troll Mode) ────────────────────────────────────────
export async function syncGlobalSettings() {
  try {
    const { data, error } = await supabase.from('site_settings').select('is_troll_mode').eq('id', 1).maybeSingle();
    if (!error && data) {
      isTrollMode.value = data.is_troll_mode;
    }

    supabase.channel('public:site_settings')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'site_settings', filter: 'id=eq.1' }, payload => {
        if (payload.new) {
          isTrollMode.value = payload.new.is_troll_mode;
        }
      })
      .subscribe();
  } catch (err) {
    console.error('[ONB-IA] Error syncing settings', err);
  }
}

// Init settings sync
syncGlobalSettings();

