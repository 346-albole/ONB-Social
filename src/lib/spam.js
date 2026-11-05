import { supabase } from './supabaseClient'

// In-memory history of messages sent in the last 10 seconds
const messageHistory = []

/**
 * Tracks message frequency, repetitive content, and handles anti-spam measures.
 * @param {object} profile - Current user profile
 * @param {string|number} messageId - ID of the message just sent
 * @param {string} tableName - Supabase table name where the message was sent
 * @param {string} content - Text content of the message
 * @returns {Promise<{blocked: boolean, reason?: string, banned?: boolean}>}
 */
export async function recordAndCheckSpam(profile, messageId, tableName, content) {
  if (!profile) return { blocked: false }
  
  const now = Date.now()
  const cleanContent = content?.trim()?.toLowerCase() || ''
  messageHistory.push({ timestamp: now, id: messageId, table: tableName, content: cleanContent })

  // Keep only records from the last 60 seconds for repeat detection
  // but use 10 seconds for the "5 messages" threshold
  const limitLong = now - 60000
  while (messageHistory.length > 0 && messageHistory[0].timestamp < limitLong) {
    messageHistory.shift()
  }

  const last10s = messageHistory.filter(m => m.timestamp > now - 10000)

  // 1. Repeat Message detection (3 times the same in 60s)
  if (cleanContent) {
    const repeats = messageHistory.filter(m => m.content === cleanContent)
    if (repeats.length >= 3) {
      // Immediate Ban for repetitive spam
      await supabase.from('profiles').update({ is_banned: true }).eq('id', profile.id)
      
      // Cleanup all repeats
      for (const item of repeats) {
        await supabase.from(item.table).update({ deleted: true }).eq('id', item.id)
      }
      messageHistory.length = 0
      
      return { 
        blocked: true, 
        reason: "ANTI-SPAM : Message répétitif détecté 3 fois. Votre compte est banni.", 
        banned: true 
      }
    }
  }

  // 2. Threshold: 5 messages/posts in 10 seconds
  if (last10s.length >= 5) {
    const toCleanup = [...last10s]
    messageHistory.length = 0

    for (const item of toCleanup) {
      if (item.id) {
        await supabase.from(item.table).update({ deleted: true }).eq('id', item.id)
      }
    }

    const newWarnings = (profile.warnings_count || 0) + 1
    
    if (newWarnings >= 2) {
      await supabase.from('profiles').update({ is_banned: true, warnings_count: newWarnings }).eq('id', profile.id)
      return { blocked: true, reason: "ANTI-SPAM : Trop de messages envoyés. Votre compte est banni.", banned: true }
    } else {
      await supabase.from('profiles').update({ warnings_count: newWarnings }).eq('id', profile.id)
      return { blocked: true, reason: "ANTI-SPAM : Calmez-vous ! Trop de messages. Vos 5 derniers messages ont été supprimés.", banned: false }
    }
  }

  return { blocked: false }
}
