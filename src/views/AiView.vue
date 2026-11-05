<script setup>
import { ref, onMounted, nextTick, computed, watch } from 'vue'
import { supabase } from '../lib/supabaseClient'
import { sessionRef } from '../lib/authStore'
import {
  getAiResponse,
  refreshAiContext,
  loadModel,
  modelState,
  loadProgress,
  progressCallbacks,
  conversationHistory,
  clearHistory
} from '../lib/aiBrain'

const newMessage = ref('')
const isTyping = ref(false)
const chatEnd = ref(null)
const profile = ref(null)
const stats = ref({ users: 0, posts: 0 })
const progress = ref(0)
const currentModelState = ref('idle')

const suggestions = [
  "💎 Comment devenir Premium ?",
  "🪙 Combien de coins j'ai ?",
  "👥 Combien de membres sur le réseau ?",
  "🤖 Qui es-tu vraiment ?"
]

const loadingLabel = computed(() => {
  if (currentModelState.value === 'loading') return `Téléchargement du modèle IA... ${progress.value}%`
  if (currentModelState.value === 'ready') return 'Flan-T5 prêt • 100% local • Open Source'
  if (currentModelState.value === 'error') return 'Mode heuristique (modèle indisponible)'
  return 'Initialisation...'
})

const loadingColor = computed(() => {
  if (currentModelState.value === 'ready') return '#16a34a'
  if (currentModelState.value === 'error') return '#f59e0b'
  return '#6366f1'
})

const scrollToBottom = async () => {
  await nextTick()
  chatEnd.value?.scrollIntoView({ behavior: 'smooth' })
}

const sendMessage = async (text = null) => {
  const content = text || newMessage.value.trim()
  if (!content || isTyping.value) return

  newMessage.value = ''
  scrollToBottom()
  isTyping.value = true

  await getAiResponse(content, profile.value)

  isTyping.value = false
  scrollToBottom()
}

const handleClearChat = () => {
  clearHistory()
  conversationHistory.value.push({ 
    role: 'ai', 
    content: "Discussion réinitialisée. Comment puis-je t'aider à nouveau ?" 
  })
}

// Watch for history changes to scroll
watch(() => conversationHistory.value.length, () => {
  scrollToBottom()
})

onMounted(async () => {
  // Sync model state
  watch(modelState, (val) => { currentModelState.value = val }, { immediate: true })
  
  // Register live progress tracking
  progressCallbacks.push((p) => { progress.value = p })
  
  // Ensure we have a greeting if history is totally empty
  if (conversationHistory.value.length === 0) {
    conversationHistory.value.push({ 
      role: 'ai', 
      content: "Bonjour ! Je suis ONB-IA. Mon cerveau (Flan-T5) se charge dès que tu l'ouvres pour la première fois. Je suis prêt à discuter !" 
    })
  }

  scrollToBottom()

  // Load user profile & stats
  if (sessionRef.value?.user) {
    const { data } = await supabase.from('profiles').select('*').eq('id', sessionRef.value.user.id).maybeSingle()
    profile.value = data
    await refreshAiContext(data)

    const [uRes, pRes] = await Promise.all([
      supabase.from('profiles').select('id', { count: 'exact', head: true }),
      supabase.from('posts').select('id', { count: 'exact', head: true })
    ])
    stats.value.users = uRes.count || 0
    stats.value.posts = pRes.count || 0
  }

  // Auto-trigger load if we are on the AI page
  if (modelState.value === 'idle') {
    loadModel()
  }
})
</script>

<template>
  <div class="ai-container">
    <div class="ai-chat-box">
      <!-- Header -->
      <div class="chat-header">
        <div class="ai-avatar-wrap">
          <div class="ai-avatar" :class="{ pulse: currentModelState === 'loading' }">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
              <circle cx="12" cy="12" r="4"/>
            </svg>
          </div>
          <span class="ai-online-dot" :class="{ loading: currentModelState === 'loading' }"></span>
        </div>
        <div class="ai-info">
          <h3>ONB-IA <span class="model-tag">Flan-T5</span></h3>
          <span class="status">{{ stats.users }} membres • {{ stats.posts }} posts • Local Node</span>
        </div>
        <button class="reset-chat" @click="handleClearChat" title="Réinitialiser la conversation">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
        </button>
      </div>

      <!-- Model status bar -->
      <div class="model-status-bar" :style="{ borderColor: loadingColor + '33' }">
        <div class="model-status-inner">
          <!-- Progress ring when loading -->
          <svg v-if="currentModelState === 'loading'" class="progress-ring" viewBox="0 0 20 20">
            <circle cx="10" cy="10" r="8" fill="none" stroke="#e2d9ff" stroke-width="2"/>
            <circle cx="10" cy="10" r="8" fill="none" :stroke="loadingColor" stroke-width="2"
              stroke-dasharray="50.27" :stroke-dashoffset="50.27 * (1 - progress / 100)"
              stroke-linecap="round" transform="rotate(-90 10 10)"/>
          </svg>
          <svg v-else-if="currentModelState === 'ready'" class="status-icon" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>
          <svg v-else class="status-icon spin" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9"/></svg>

          <div class="model-label-wrap">
            <span class="model-label" :style="{ color: loadingColor }">{{ loadingLabel }}</span>
            <div v-if="currentModelState === 'loading'" class="progress-bar-track">
              <div class="progress-bar-fill" :style="{ width: progress + '%', background: loadingColor }"></div>
            </div>
          </div>
        </div>
        <div class="model-badge">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          Open Source
        </div>
      </div>

      <!-- Messages -->
      <div class="messages-list">
        <div v-for="(msg, idx) in conversationHistory" :key="idx" :class="['msg-bubble-wrap', msg.role]">
          <div class="msg-bubble">
            <div class="bubble-content" v-html="msg.content.replace(/\n/g, '<br>')"></div>
          </div>
        </div>
        <div v-if="isTyping" class="msg-bubble-wrap ai typing">
          <div class="msg-bubble">
            <div class="bubble-content">
              <span class="dot"></span><span class="dot"></span><span class="dot"></span>
            </div>
          </div>
        </div>
        <div ref="chatEnd"></div>
      </div>

      <!-- Footer -->
      <div class="ai-footer">
        <div class="suggestions-row" v-if="conversationHistory.length < 5">
          <button v-for="s in suggestions" :key="s" class="suggest-btn" @click="sendMessage(s)">
            {{ s }}
          </button>
        </div>

        <form class="input-area" @submit.prevent="sendMessage()">
          <input
            v-model="newMessage"
            type="text"
            :placeholder="currentModelState === 'loading' ? `Chargement du modèle... ${progress}%` : 'Discute avec ONB-IA...'"
            :disabled="isTyping"
          />
          <button type="submit" :disabled="!newMessage.trim() || isTyping">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </button>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-container {
  display: flex; flex-direction: column;
  height: calc(100vh - 70px);
  max-width: 900px; margin: 0 auto; padding: 20px;
}

.ai-chat-box {
  flex: 1; background: white; border-radius: 24px;
  display: flex; flex-direction: column; overflow: hidden;
  box-shadow: 0 20px 50px rgba(76, 16, 224, 0.08);
  border: 1px solid #ede8ff;
}

/* Header */
.chat-header {
  padding: 20px 24px; background: var(--purple);
  color: white; display: flex; align-items: center; gap: 15px;
}
.ai-avatar-wrap { position: relative; }
.ai-avatar {
  width: 48px; height: 48px;
  background: rgba(255,255,255,0.15); border-radius: 16px;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid rgba(255,255,255,0.2); transition: all 0.3s;
}
.ai-avatar.pulse { animation: avatar-pulse 2s infinite; }
@keyframes avatar-pulse {
  0%, 100% { background: rgba(255,255,255,0.15); }
  50% { background: rgba(255,255,255,0.3); }
}
.ai-avatar svg { width: 26px; height: 26px; }
.ai-online-dot {
  position: absolute; bottom: -2px; right: -2px;
  width: 12px; height: 12px; border-radius: 50%;
  background: #22c55e; border: 2.5px solid var(--purple);
  transition: background 0.3s;
}
.ai-online-dot.loading { background: #f59e0b; animation: blink 1s infinite; }
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

.ai-info { flex: 1; }
.ai-info h3 { font-size: 1.05rem; font-weight: 800; margin: 0; font-family: 'Epilogue', sans-serif; display: flex; align-items: center; gap: 8px; }
.model-tag {
  font-size: 0.65rem; font-weight: 800; padding: 2px 7px;
  background: rgba(255,255,255,0.2); border-radius: 6px;
  letter-spacing: 0.06em; font-family: 'Instrument Sans', sans-serif;
}
.ai-info .status { font-size: 0.72rem; opacity: 0.85; font-weight: 600; }

.reset-chat {
  width: 36px; height: 36px; border-radius: 10px;
  background: rgba(255,255,255,0.1); border: none;
  color: white; display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: all 0.2s;
}
.reset-chat:hover { background: rgba(255,255,255,0.25); transform: rotate(-90deg); }
.reset-chat svg { width: 18px; height: 18px; }

/* Status bar */
.model-status-bar {
  padding: 10px 20px; border-bottom: 1px solid #f0eeff;
  display: flex; align-items: center; justify-content: space-between;
  background: #fafaff; border-left: 3px solid #a78bfa;
}
.model-status-inner { display: flex; align-items: center; gap: 10px; flex: 1; }
.progress-ring { width: 20px; height: 20px; flex-shrink: 0; transition: stroke-dashoffset 0.3s; }
.status-icon { width: 18px; height: 18px; flex-shrink: 0; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.model-label-wrap { display: flex; flex-direction: column; gap: 4px; flex: 1; }
.model-label { font-size: 0.76rem; font-weight: 700; }
.progress-bar-track {
  width: 100%; height: 3px; background: #e2d9ff;
  border-radius: 3px; overflow: hidden;
}
.progress-bar-fill {
  height: 100%; border-radius: 3px;
  transition: width 0.4s ease; min-width: 4px;
}

.model-badge {
  display: flex; align-items: center; gap: 5px;
  font-size: 0.7rem; font-weight: 800; color: #7c3aed;
  background: #f0eeff; padding: 4px 10px; border-radius: 20px;
}
.model-badge svg { width: 12px; height: 12px; }

/* Messages */
.messages-list {
  flex: 1; overflow-y: auto; padding: 24px;
  display: flex; flex-direction: column; gap: 20px;
  background: #fbfaff;
}

.msg-bubble-wrap {
  display: flex; flex-direction: column; max-width: 85%;
  animation: slide-up 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes slide-up {
  from { opacity: 0; transform: translateY(20px) scale(0.95); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.msg-bubble { padding: 14px 20px; border-radius: 20px; font-size: 0.98rem; line-height: 1.6; }
.ai { align-self: flex-start; }
.ai .msg-bubble { background: white; color: var(--text); border: 1px solid #ede8ff; border-bottom-left-radius: 4px; box-shadow: 0 4px 12px rgba(76,16,224,0.03); }
.user { align-self: flex-end; }
.user .msg-bubble { background: var(--purple); color: white; border-bottom-right-radius: 4px; box-shadow: 0 8px 16px rgba(76,16,224,0.15); }

.typing .dot {
  display: inline-block; width: 6px; height: 6px;
  background: #cbd5e1; border-radius: 50%; margin: 0 2px;
  animation: typing 1.4s infinite ease-in-out;
}
.typing .dot:nth-child(2) { animation-delay: 0.2s; }
.typing .dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes typing {
  0%, 100% { transform: translateY(0); opacity: 0.4; }
  50% { transform: translateY(-6px); opacity: 1; }
}

/* Footer */
.ai-footer { padding: 16px 24px 24px; background: white; border-top: 1px solid #f0eeff; }
.suggestions-row { display: flex; gap: 10px; margin-bottom: 16px; overflow-x: auto; padding-bottom: 4px; scrollbar-width: none; }
.suggestions-row::-webkit-scrollbar { display: none; }
.suggest-btn {
  white-space: nowrap; padding: 8px 16px;
  background: #f8f7ff; border: 1px solid #ede8ff; border-radius: 50px;
  font-size: 0.85rem; font-weight: 700; color: var(--purple);
  cursor: pointer; transition: all 0.2s;
}
.suggest-btn:hover { background: var(--purple); color: white; transform: translateY(-2px); border-color: var(--purple); }

.input-area { display: flex; gap: 12px; }
.input-area input {
  flex: 1; border: 2px solid #f0eeff; padding: 14px 20px;
  border-radius: 16px; font-size: 0.95rem; font-weight: 500;
  transition: all 0.3s; outline: none; font-family: 'Instrument Sans', sans-serif;
}
.input-area input:focus { border-color: var(--purple); box-shadow: 0 0 0 4px rgba(76,16,224,0.05); }
.input-area button {
  width: 52px; background: var(--purple); color: white;
  display: flex; align-items: center; justify-content: center;
  border-radius: 16px; transition: all 0.3s; box-shadow: 0 4px 12px rgba(76,16,224,0.2);
}
.input-area button:hover:not(:disabled) { background: var(--purple-d); transform: scale(1.05) translateY(-2px); }
.input-area button:active { transform: scale(0.95); }
.input-area button:disabled { background: #cbd5e1; transform: none; box-shadow: none; opacity: 0.6; }
.input-area button svg { width: 20px; height: 20px; }

@media (max-width: 600px) {
  .ai-container { padding: 10px; height: calc(100vh - 120px); }
  .msg-bubble-wrap { max-width: 90%; }
  .chat-header { padding: 16px; }
}
</style>
