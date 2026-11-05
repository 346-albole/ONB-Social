// TEMPORAIRE — portage en cours.
// Plus utilisé pour l'auth ni pour les données déjà portées sur l'API.
// Reste importé par les vues non encore migrées (Phase 4) et par le stockage
// et le temps réel (Phase 5), puis sera supprimé avec @supabase/supabase-js.
import { createClient } from '@supabase/supabase-js'

const supabaseUrl     = import.meta.env.VITE_SUPABASE_URL || 'http://localhost:54321'
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'placeholder'

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession:     false,
    autoRefreshToken:   false,
    detectSessionInUrl: false,
  },
  realtime: {
    params: { eventsPerSecond: 10 }
  },
})
