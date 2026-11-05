<script setup>
import { ref, watch, nextTick, onMounted, computed, onUnmounted } from 'vue'
import { getAiResponse, loadModel, modelState, loadProgress, progressCallbacks, conversationHistory, isTrollMode } from '../lib/aiBrain'
import { sessionRef } from '../lib/authStore'
import { supabase } from '../lib/supabaseClient'

const isOpen = ref(false)
const newMessage = ref('')
const isTyping = ref(false)
const chatEnd = ref(null)
const profile = ref(null)
const currentProgress = ref(0)
const currentModelState = ref('idle')

// Drag and drop logic
const wrapperRef = ref(null)
const position = ref({ x: 0, y: 0 })
const isDragging = ref(false)
let dragOffset = { x: 0, y: 0 }
let startCoords = { x: 0, y: 0 }
let isDraggingFlag = false

const wrapperStyle = computed(() => {
  if (position.value.x === 0 && position.value.y === 0) return {}
  return {
    bottom: 'auto',
    right: 'auto',
    left: `${position.value.x}px`,
    top: `${position.value.y}px`,
    transition: isTrollMode.value && !isOpen.value ? 'all 0.2s ease-out' : 'none'
  }
})

const windowPositionClass = computed(() => {
  if (position.value.x === 0 && position.value.y === 0) return 'fai-pos-br'
  const isTop = position.value.y < window.innerHeight / 2
  const isLeft = position.value.x < window.innerWidth / 2
  if (isTop && isLeft) return 'fai-pos-tl'
  if (isTop && !isLeft) return 'fai-pos-tr'
  if (!isTop && isLeft) return 'fai-pos-bl'
  return 'fai-pos-br'
})

const onDragStart = (e) => {
  if (isOpen.value || isTrollMode.value) return; 

  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;

  if (position.value.x === 0 && position.value.y === 0 && wrapperRef.value) {
    const rect = wrapperRef.value.getBoundingClientRect();
    position.value = { x: rect.left, y: rect.top };
  }

  dragOffset = {
    x: clientX - position.value.x,
    y: clientY - position.value.y
  };

  startCoords = { x: clientX, y: clientY };
  isDraggingFlag = false;

  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
  document.addEventListener('touchmove', onDragMove, { passive: false });
  document.addEventListener('touchend', onDragEnd);
}

const onDragMove = (e) => {
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;

  if (Math.abs(clientX - startCoords.x) > 5 || Math.abs(clientY - startCoords.y) > 5) {
    isDraggingFlag = true;
    isDragging.value = true;
  }

  if (isDraggingFlag) {
    if (e.cancelable) e.preventDefault();
    
    let newX = clientX - dragOffset.x;
    let newY = clientY - dragOffset.y;

    const maxX = window.innerWidth - 60; 
    const maxY = window.innerHeight - 60;
    
    newX = Math.max(0, Math.min(newX, maxX));
    newY = Math.max(0, Math.min(newY, maxY));

    position.value = { x: newX, y: newY };
  }
}

const onDragEnd = () => {
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);
  document.removeEventListener('touchmove', onDragMove);
  document.removeEventListener('touchend', onDragEnd);

  setTimeout(() => {
    isDraggingFlag = false;
    isDragging.value = false;
  }, 50);
}

const handleTriggerClick = (e) => {
  if (isDragging.value) {
    e.preventDefault();
    return;
  }
  toggleChat();
}

const onHoverTroll = () => {
  if (!isTrollMode.value || isOpen.value) return;
  
  const maxX = window.innerWidth - 80;
  const maxY = window.innerHeight - 80;
  
  const newX = Math.max(20, Math.floor(Math.random() * maxX));
  const newY = Math.max(20, Math.floor(Math.random() * maxY));

  position.value = { x: newX, y: newY };
}

onUnmounted(() => {
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);
  document.removeEventListener('touchmove', onDragMove);
  document.removeEventListener('touchend', onDragEnd);
})


const scrollToBottom = async () => {
  await nextTick()
  chatEnd.value?.scrollIntoView({ behavior: 'smooth' })
}

const toggleChat = async () => {
  isOpen.value = !isOpen.value
  if (isOpen.value) {
    scrollToBottom()
    
    // Lazy load model on first open
    if (modelState.value === 'idle') {
      loadModel().then(() => {
        currentModelState.value = modelState.value
      })
    }

    // Add initial message if history is empty
    if (conversationHistory.value.length === 0) {
      conversationHistory.value.push({ 
        role: 'ai', 
        content: "Besoin d'aide ? Je suis ONB-IA, propulsé par Flan-T5 (open source)." 
      })
    }

    // Load profile for context if not already loaded
    if (!profile.value && sessionRef.value?.user) {
      const { data } = await supabase.from('profiles').select('*').eq('id', sessionRef.value.user.id).maybeSingle()
      profile.value = data
    }
  }
}

const sendMessage = async () => {
  const content = newMessage.value.trim()
  if (!content || isTyping.value) return

  // getAiResponse handles pushing to conversationHistory
  newMessage.value = ''
  scrollToBottom()

  isTyping.value = true
  
  // Get AI response from local brain
  await getAiResponse(content, profile.value)
  
  isTyping.value = false
  scrollToBottom()
}

onMounted(() => {
  // Sync local model state with shared state
  watch(modelState, (newVal) => { currentModelState.value = newVal }, { immediate: true })
  
  // Track progress
  progressCallbacks.push((p) => { currentProgress.value = p })

  if (sessionRef.value?.user) {
    supabase.from('profiles').select('*').eq('id', sessionRef.value.user.id).maybeSingle()
      .then(res => profile.value = res.data)
  }
})
</script>

<template>
  <div 
    class="fai-wrapper" 
    :class="[{ 'fai-open': isOpen, 'fai-troll': isTrollMode, 'fai-dragging': isDragging }, windowPositionClass]"
    ref="wrapperRef"
    :style="wrapperStyle"
  >
    <!-- Chat Window -->
    <div v-show="isOpen" class="fai-window">
      <div class="fai-header" @click="toggleChat">
        <div class="fai-header-info">
          <div class="fai-status-dot" :class="{ loading: currentModelState === 'loading' }"></div>
          <span>ONB-IA <span class="fai-model-tag">Flan-T5</span></span>
        </div>
        <button class="fai-close" @click.stop="toggleChat">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div v-if="currentModelState === 'loading'" class="fai-progress-bar">
        <div class="fai-progress-fill" :style="{ width: currentProgress + '%' }"></div>
      </div>
      
      <div class="fai-messages">
        <div v-for="(msg, idx) in conversationHistory" :key="idx" :class="['fai-msg', msg.role]">
          <div class="fai-bubble">{{ msg.content }}</div>
        </div>
        <div v-if="isTyping" class="fai-msg ai typing">
           <div class="fai-bubble">
              <span class="dot"></span><span class="dot"></span><span class="dot"></span>
           </div>
        </div>
        <div ref="chatEnd"></div>
      </div>

      <form class="fai-input-area" @submit.prevent="sendMessage">
        <input 
          v-model="newMessage" 
          type="text" 
          placeholder="Écris un message..." 
          :disabled="isTyping"
        />
        <button type="submit" :disabled="!newMessage.trim() || isTyping">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
        </button>
      </form>
    </div>

    <!-- Floating Button -->
    <button 
      class="fai-trigger" 
      @click="handleTriggerClick" 
      :class="{ 'triggered': isOpen }" 
      title="Assistant IA"
      @mousedown="onDragStart"
      @touchstart="onDragStart"
      @mouseenter="onHoverTroll"
    >
      <div class="fai-icon-wrap">
        <svg v-if="!isOpen" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
          <circle cx="12" cy="12" r="4"/>
        </svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </div>
      <span class="fai-pulse"></span>
    </button>
  </div>
</template>

<style scoped>
.fai-wrapper {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 10000;
  font-family: 'Instrument Sans', sans-serif;
  display: flex;
  gap: 16px;
}

.fai-pos-br { flex-direction: column; align-items: flex-end; }
.fai-pos-br .fai-window { transform-origin: bottom right; }

.fai-pos-bl { flex-direction: column; align-items: flex-start; }
.fai-pos-bl .fai-window { transform-origin: bottom left; }

.fai-pos-tr { flex-direction: column-reverse; align-items: flex-end; }
.fai-pos-tr .fai-window { transform-origin: top right; }

.fai-pos-tl { flex-direction: column-reverse; align-items: flex-start; }
.fai-pos-tl .fai-window { transform-origin: top left; }

/* Sidebar behavior on small screen: Hide bubble */
@media (max-width: 540px) {
  .fai-wrapper { display: none; }
}

.fai-trigger {
  width: 56px;
  height: 56px;
  border-radius: 18px;
  background: var(--purple);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 10px 25px rgba(76, 16, 224, 0.3);
  border: none;
  cursor: grab;
  transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
  position: relative;
}
.fai-trigger.triggered,
.fai-wrapper.fai-troll .fai-trigger {
  cursor: pointer;
}
.fai-wrapper.fai-dragging .fai-trigger {
  cursor: grabbing;
}
.fai-trigger:hover { transform: scale(1.08) translateY(-4px); box-shadow: 0 15px 30px rgba(76, 16, 224, 0.4); }
.fai-trigger.triggered { transform: rotate(90deg) scale(0.9); background: white; color: var(--purple); border: 2px solid var(--purple); }

.fai-icon-wrap { position: relative; z-index: 2; display: flex; align-items: center; justify-content: center; }
.fai-icon-wrap svg { width: 28px; height: 28px; transition: transform 0.3s; }

.fai-pulse {
  position: absolute; inset: 0; border-radius: 18px;
  background: var(--purple); opacity: 0.4;
  animation: fai-pulse-anim 3s infinite;
  z-index: 1;
}
@keyframes fai-pulse-anim {
  0% { transform: scale(1); opacity: 0.4; }
  50% { transform: scale(1.5); opacity: 0; }
  100% { transform: scale(1); opacity: 0; }
}

.fai-window {
  width: 340px;
  height: 480px;
  background: white;
  border-radius: 24px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(27, 19, 64, 0.2);
  border: 1px solid #ede8ff;
  animation: fai-window-anim 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes fai-window-anim {
  from { opacity: 0; transform: scale(0.8) translateY(20px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}

/* Top-position windows open downward */
.fai-pos-tr .fai-window,
.fai-pos-tl .fai-window {
  animation-name: fai-window-anim-top;
}
@keyframes fai-window-anim-top {
  from { opacity: 0; transform: scale(0.8) translateY(-20px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}

.fai-header {
  padding: 16px 20px;
  background: var(--purple);
  color: white;
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
}
.fai-header-info { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 0.9rem; }
.fai-status-dot { width: 8px; height: 8px; background: #22c55e; border-radius: 50%; box-shadow: 0 0 6px #22c55e; transition: background 0.3s; }
.fai-status-dot.loading { background: #f59e0b; box-shadow: 0 0 6px #f59e0b; animation: blink 1s infinite; }
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

.fai-model-tag { font-size: 0.62rem; font-weight: 800; padding: 1px 6px; background: rgba(255,255,255,0.2); border-radius: 5px; letter-spacing: 0.06em; }

.fai-progress-bar { height: 3px; background: rgba(255,255,255,0.15); }
.fai-progress-fill { height: 100%; background: #22c55e; transition: width 0.4s ease; }

.fai-close {
  width: 28px; height: 28px; border-radius: 50%;
  background: rgba(255,255,255,0.15); border: none;
  color: white; display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.2s;
}
.fai-close:hover { background: rgba(255,255,255,0.25); }
.fai-close svg { width: 14px; height: 14px; }

.fai-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: #fbf9ff;
}

.fai-msg { display: flex; flex-direction: column; max-width: 85%; animation: slide-in 0.3s ease-out; }
@keyframes slide-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

.ai { align-self: flex-start; }
.user { align-self: flex-end; }

.fai-bubble {
  padding: 10px 14px;
  border-radius: 16px;
  font-size: 0.88rem;
  line-height: 1.4;
}

.ai .fai-bubble { background: white; color: var(--text); border: 1px solid #ede8ff; border-bottom-left-radius: 4px; }
.user .fai-bubble { background: var(--purple); color: white; border-bottom-right-radius: 4px; box-shadow: 0 6px 12px rgba(76, 16, 224, 0.1); }

.typing .dot {
  display: inline-block; width: 5px; height: 5px;
  background: #cbd5e1; border-radius: 50%;
  margin: 0 1px; animation: typing 1.4s infinite ease-in-out;
}
.typing .dot:nth-child(2) { animation-delay: 0.2s; }
.typing .dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes typing {
  0%, 100% { transform: translateY(0); opacity: 0.4; }
  50% { transform: translateY(-4px); opacity: 1; }
}

.fai-input-area {
  padding: 12px 16px;
  background: white;
  border-top: 1px solid #f0eeff;
  display: flex; gap: 8px;
}
.fai-input-area input {
  flex: 1; border: 1.5px solid #f0eeff;
  padding: 8px 14px; border-radius: 12px;
  font-size: 0.88rem; outline: none; transition: all 0.2s;
}
.fai-input-area input:focus { border-color: var(--purple); background: white; }

.fai-input-area button {
  width: 38px; height: 38px;
  background: var(--purple); color: white;
  display: flex; align-items: center; justify-content: center;
  border-radius: 10px; transition: all 0.2s;
}
.fai-input-area button:hover:not(:disabled) { transform: scale(1.05); background: var(--purple-d); }
.fai-input-area button:disabled { background: #cbd5e1; opacity: 0.6; }
.fai-input-area button svg { width: 18px; height: 18px; stroke-width: 2.5; }
</style>
