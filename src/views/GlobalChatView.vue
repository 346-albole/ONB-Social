<script setup>
import { ref, onMounted, onUnmounted, onActivated, nextTick, computed } from 'vue'
import { supabase } from '../lib/supabaseClient'
import { getCurrentSession } from '../lib/authStore'
import { withTimeout } from '../lib/withTimeout'
import { onlineUsers } from '../stores/presence'
import { t } from '../lib/i18n'
import { useRouter } from 'vue-router'
import { checkModeration } from '../lib/moderation'
import { recordAndCheckSpam } from '../lib/spam'

const currentUser    = ref(null)

const router = useRouter()
function goToProfile(userId) {
  if (userId === currentUser.value?.id) router.push('/profile')
  else router.push(`/profile/${userId}`)
}
const currentProfile = ref(null)
const messages       = ref([])
const loading        = ref(true)
const newMessage     = ref('')
const sending        = ref(false)
const messagesEnd    = ref(null)
const editingId      = ref(null)
const editContent    = ref('')
const onlineCount    = computed(() => onlineUsers.value.size)

let realtimeSub = null
let initialized = false   // prevents re-running full init on tab return //kiril is small daun

async function init() {
  loading.value = true
  try {
    const session = getCurrentSession()
    if (!session?.user) { loading.value = false; return }
    currentUser.value = session.user

    const { data: p } = await withTimeout(
      supabase.from('profiles')
        .select('id, username, avatar_url, username_color, is_premium, is_official, is_admin, warnings_count, is_banned')
        .eq('id', session.user.id).maybeSingle(),
      8000
    )
    currentProfile.value = p
    await loadMessages()
    subscribeMessages()
    initialized = true
  } catch (e) {
    console.warn('[GlobalChat] init error:', e)
  } finally {
    loading.value = false
  }
}

onMounted(() => { init() })

// onActivated fires when the user switches back to this tab (keep-alive).
// Only reload messages — not full init — to avoid infinite spinner.
let globalHiddenAt = 0
onActivated(async () => {
  if (!initialized) return
  const hiddenFor = Date.now() - globalHiddenAt
  // Only reload if hidden for more than 2 minutes (avoid unnecessary fetches)
  if (globalHiddenAt === 0 || hiddenFor < 2 * 60 * 1000) return
  try {
    await loadMessages()
    // Re-subscribe only if channel was lost
    if (!realtimeSub) subscribeMessages()
  } catch (e) {
    console.warn('[GlobalChat] onActivated reload error:', e)
  }
})

// Track when the view is hidden
function _gcVisHandler() {
  if (document.visibilityState !== 'visible') globalHiddenAt = Date.now()
}

onMounted(() => { document.addEventListener('visibilitychange', _gcVisHandler) })
onUnmounted(() => {
  document.removeEventListener('visibilitychange', _gcVisHandler)
  realtimeSub?.unsubscribe()
  realtimeSub = null
})

async function loadMessages() {
  try {
    const result = await withTimeout(
      supabase.from('global_messages')
        .select('*, profiles(id, username, avatar_url, username_color, is_premium, is_official, is_admin, is_anonymous)')
        .order('created_at', { ascending: true })
        .limit(200),
      10000
    )
    if (result?.error) { console.error('Global chat load error:', result.error); return }
    messages.value = (result?.data || []).filter(m => !m.deleted)
    await nextTick()
    scrollToBottom()
  } catch (e) {
    console.warn('loadMessages error:', e)
  }
}

function subscribeMessages() {
  realtimeSub?.unsubscribe()
  realtimeSub = supabase.channel('global-chat-v3')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'global_messages' }, async payload => {
      if (messages.value.find(m => m.id === payload.new.id)) return
      const { data } = await supabase
        .from('global_messages')
        .select('*, profiles(id, username, avatar_url, username_color, is_premium, is_official, is_admin, is_anonymous)')
        .eq('id', payload.new.id).single()
      if (data && !data.deleted) {
        messages.value.push(data)
        await nextTick()
        scrollToBottom()
      }
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'global_messages' }, payload => {
      const idx = messages.value.findIndex(m => m.id === payload.new.id)
      if (idx !== -1) {
        if (payload.new.deleted) messages.value.splice(idx, 1)
        else messages.value[idx] = { ...messages.value[idx], ...payload.new }
      }
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'global_messages' }, payload => {
      messages.value = messages.value.filter(m => m.id !== payload.old.id)
    })
    .subscribe()
}

async function sendMessage() {
  const content = newMessage.value.trim()
  if (!content || sending.value || !currentUser.value) return
  if (content.length > 500) return

  const mod = await checkModeration(content, currentProfile.value)
  if (mod.blocked) {
    alert(mod.reason)
    if (mod.banned) router.push('/auth')
    else {
      newMessage.value = ''
      const { data } = await supabase.from('profiles').select('warnings_count, is_banned').eq('id', currentUser.value.id).maybeSingle()
      if (data) Object.assign(currentProfile.value, data)
    }
    return
  }
  sending.value = true
  const msg = newMessage.value
  newMessage.value = ''
  try {
    const { data, error } = await supabase
      .from('global_messages')
      .insert({ sender_id: currentUser.value.id, content: msg.trim() })
      .select('*, profiles(id, username, avatar_url, username_color, is_premium, is_official, is_admin, is_anonymous)')
      .single()
    if (!error && data && !messages.value.find(m => m.id === data.id)) {
      messages.value.push(data)
      await nextTick()
      scrollToBottom()

      // Anti-spam check
      const spam = await recordAndCheckSpam(currentProfile.value, data.id, 'global_messages', msg)
      if (spam.blocked) {
        alert(spam.reason)
        if (spam.banned) router.push('/auth')
        else {
          const { data: p } = await supabase.from('profiles').select('warnings_count, is_banned').eq('id', currentUser.value.id).maybeSingle()
          if (p) Object.assign(currentProfile.value, p)
        }
      }
    } else if (error) {
      newMessage.value = msg
    }
  } catch (e) {
    newMessage.value = msg
  } finally {
    sending.value = false
  }
}

// BUG FIX: was checking currentUser.value?.id but currentUser could be null
// if the component re-mounted and init hadn't finished. Now we guard properly
// and also do an optimistic remove + rollback on error.
async function deleteMsg(msg) {
  const uid = currentUser.value?.id
  const isAdmin = currentProfile.value?.is_admin
  if (!uid) return
  if (msg.sender_id !== uid && !isAdmin) return

  // Optimistic remove
  const backup = [...messages.value]
  messages.value = messages.value.filter(m => m.id !== msg.id)

  const { error } = await supabase
    .from('global_messages')
    .update({ deleted: true })
    .eq('id', msg.id)

  if (error) {
    console.error('Delete error:', error)
    messages.value = backup // rollback
  }
}

function startEdit(msg) {
  editingId.value = msg.id
  editContent.value = msg.content
  nextTick(() => document.getElementById('edit-input-' + msg.id)?.focus())
}

async function saveEdit(msg) {
  const content = editContent.value.trim()
  if (!content) return

  const mod = await checkModeration(content, currentProfile.value)
  if (mod.blocked) {
    alert(mod.reason)
    if (mod.banned) router.push('/auth')
    cancelEdit()
    return
  }

  await supabase.from('global_messages').update({ content, edited: true }).eq('id', msg.id)
  const idx = messages.value.findIndex(m => m.id === msg.id)
  if (idx !== -1) messages.value[idx] = { ...messages.value[idx], content, edited: true }
  editingId.value = null
}

function cancelEdit() { editingId.value = null }

function scrollToBottom() {
  messagesEnd.value?.scrollIntoView({ behavior: 'smooth' })
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function fmtDay(ts) {
  const d = new Date(ts), today = new Date()
  if (d.toDateString() === today.toDateString()) return t.value.gcToday
  const yest = new Date(today); yest.setDate(today.getDate() - 1)
  if (d.toDateString() === yest.toDateString()) return t.value.gcYesterday
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })
}

const grouped = computed(() => {
  const out = []; let lastDay = null
  for (const msg of messages.value) {
    const day = new Date(msg.created_at).toDateString()
    if (day !== lastDay) { out.push({ type: 'd', label: fmtDay(msg.created_at) }); lastDay = day }
    out.push({ type: 'm', ...msg })
  }
  return out
})

function handleKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
}
</script>

<template>
  <div class="gc-page">
    <div class="gc-header">
      <div class="gc-title-row">
        <div class="gc-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        </div>
        <div>
          <div class="gc-title">{{ t.gcTitle }}</div>
          <div class="gc-subtitle">{{ t.gcSubtitle }}</div>
        </div>
      </div>
      <div class="gc-online-badge">
        <span class="online-dot-anim"></span>
        {{ onlineCount }} {{ t.gcOnline }}
      </div>
    </div>

    <div class="gc-msgs" v-if="!loading">
      <template v-for="item in grouped" :key="item.type === 'd' ? 'sep-'+item.label : 'msg-'+item.id">
        <div v-if="item.type === 'd'" class="day-sep"><span>{{ item.label }}</span></div>
        <div v-else class="gc-msg" :class="{ mine: item.sender_id === currentUser?.id }">
          <div class="msg-av">
            <template v-if="item.profiles?.is_anonymous">
              <div class="anon-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
              </div>
            </template>
            <template v-else>
              <img v-if="item.profiles?.avatar_url" :src="item.profiles.avatar_url" loading="lazy" />
              <span v-else>{{ (item.profiles?.username || '?').charAt(0).toUpperCase() }}</span>
              <span v-if="onlineUsers.has(item.profiles?.id)" class="av-online"></span>
            </template>
          </div>
          <div class="msg-col">
            <div class="msg-meta">
                <template v-if="item.profiles?.is_anonymous">
                  Anonyme
                </template>
                <template v-else>
                  @{{ item.profiles?.username || 'Anonymous' }}
                  <!-- Shield verified badge (new design, not the old ✓ text) -->
                  <span v-if="item.profiles?.is_official" class="badge-official" title="Verified Account">
                    <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" width="14" height="14">
                      <path d="M10 1.5L3 5v5.5c0 4.1 2.9 7.8 7 9 4.1-1.2 7-4.9 7-9V5L10 1.5z" fill="#1d9bf0"/>
                      <path d="M7.5 10l2 2 3-3.5" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
                    </svg>
                  </span>
                  <span v-if="item.profiles?.is_premium" class="badge-premium" title="Premium">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="10" height="10"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                  </span>
                </template>
              <span class="msg-time">{{ fmtTime(item.created_at) }}<span v-if="item.edited" class="edited-tag"> {{ t.gcEdited }}</span></span>
            </div>
            <div v-if="editingId === item.id" class="edit-area">
              <input
                :id="'edit-input-' + item.id"
                v-model="editContent"
                class="edit-input"
                @keyup.enter="saveEdit(item)"
                @keyup.escape="cancelEdit"
              />
              <div class="edit-btns">
                <button class="btn-xs btn-purple" @click="saveEdit(item)">{{ t.gcSave }}</button>
                <button class="btn-xs btn-ghost" @click="cancelEdit">{{ t.gcCancel }}</button>
              </div>
            </div>
            <div v-else class="msg-bubble">{{ item.content }}</div>
          </div>
          <div v-if="currentUser && (item.sender_id === currentUser.id || currentProfile?.is_admin)" class="msg-actions">
            <button v-if="item.sender_id === currentUser.id" class="msg-action-btn" title="Edit" @click="startEdit(item)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="msg-action-btn danger" title="Delete" @click="deleteMsg(item)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
            </button>
          </div>
        </div>
      </template>
      <div v-if="!messages.length" class="gc-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:48px;height:48px;opacity:0.2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        <p>{{ t.gcEmpty }}</p>
      </div>
      <div ref="messagesEnd"></div>
    </div>
    <div v-else class="gc-msgs gc-loading"><div class="spinner"></div></div>

    <div class="gc-input-area" v-if="currentUser">
      <div class="gc-av">
        <img v-if="currentProfile?.avatar_url" :src="currentProfile.avatar_url" />
        <span v-else>{{ currentProfile?.username?.charAt(0)?.toUpperCase() || '?' }}</span>
      </div>
      <div class="gc-input-wrap">
        <textarea
          v-model="newMessage"
          class="gc-input"
          :placeholder="t.gcPlaceholder"
          @keydown="handleKeydown"
          :disabled="sending"
          rows="1"
          maxlength="500"
        ></textarea>
        <span class="char-count" :class="{ warn: newMessage.length > 400 }">{{ newMessage.length }}/500</span>
      </div>
      <button class="gc-send" @click="sendMessage" :disabled="!newMessage.trim() || sending">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      </button>
    </div>
    <div v-else class="gc-login-cta">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      {{ t.gcLogin }}
    </div>
  </div>
</template>

<style scoped>
.gc-page { display:flex; flex-direction:column; height:100%; overflow:hidden; background:#faf9ff; }
.gc-header { display:flex; align-items:center; justify-content:space-between; padding:14px 24px; background:white; border-bottom:1px solid #ede8ff; flex-shrink:0; gap:10px; }
.gc-title-row { display:flex; align-items:center; gap:12px; min-width:0; }
.gc-icon { width:40px; height:40px; border-radius:12px; background:linear-gradient(135deg,#4C10E0,#7c3aed); display:flex; align-items:center; justify-content:center; color:white; flex-shrink:0; }
.gc-icon svg { width:20px; height:20px; }
.gc-title { font-family:'Epilogue',sans-serif; font-size:1rem; font-weight:800; color:var(--text); }
.gc-subtitle { font-size:0.75rem; color:var(--text-2); }
.gc-online-badge { display:flex; align-items:center; gap:6px; padding:5px 12px; border-radius:20px; background:#f0fff4; color:#16a34a; font-size:0.78rem; font-weight:700; white-space:nowrap; flex-shrink:0; }
.online-dot-anim { width:8px; height:8px; border-radius:50%; background:#22c55e; animation:pulse-gc 2s infinite; }
@keyframes pulse-gc { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.6;transform:scale(.8)} }

.gc-msgs { flex:1; overflow-y:auto; padding:16px 24px; display:flex; flex-direction:column; gap:6px; }
.gc-loading { align-items:center; justify-content:center; }
.gc-empty { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; color:var(--text-2); font-size:.85rem; text-align:center; }

.day-sep { display:flex; align-items:center; gap:10px; font-size:.7rem; font-weight:700; color:var(--text-2); margin:8px 0 4px; }
.day-sep::before,.day-sep::after { content:''; flex:1; height:1px; background:#e8e0ff; }

.gc-msg { display:flex; align-items:flex-start; gap:8px; position:relative; }
.gc-msg:hover .msg-actions { opacity:1; }
.gc-msg.mine { flex-direction:row-reverse; }

.msg-av { position:relative; width:32px; height:32px; border-radius:50%; background:var(--purple); color:white; font-size:.78rem; font-weight:700; display:flex; align-items:center; justify-content:center; overflow:visible; flex-shrink:0; }
.msg-av img { width:100%; height:100%; object-fit:cover; border-radius:50%; }
.anon-icon { display:flex; align-items:center; justify-content:center; width:100%; height:100%; color:white; background:linear-gradient(135deg, #1e293b, #0f172a); border-radius:50%; }
.anon-icon svg { width:16px; height:16px; }
.av-online { position:absolute; bottom:0; right:0; width:9px; height:9px; border-radius:50%; background:#22c55e; border:2px solid white; }

.msg-col { display:flex; flex-direction:column; gap:3px; max-width:60%; }
.mine .msg-col { align-items:flex-end; }
.msg-meta { display:flex; align-items:center; gap:6px; padding:0 4px; flex-wrap:wrap; }
.msg-author { font-size:.72rem; font-weight:700; color:var(--purple); display:inline-flex; align-items:center; gap:3px; }

/* Shield verified badge */
.badge-official { display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px; flex-shrink:0; filter:drop-shadow(0 1px 2px rgba(29,155,240,.35)); }
.badge-premium { width:14px; height:14px; border-radius:50%; background:linear-gradient(135deg,#fbbf24,#f97316); color:white; display:inline-flex; align-items:center; justify-content:center; flex-shrink:0; }

.msg-time { font-size:.63rem; color:var(--text-2); }
.edited-tag { font-style:italic; opacity:.7; }

.msg-bubble { padding:9px 13px; border-radius:18px; font-size:.87rem; line-height:1.45; word-break:break-word; white-space:pre-wrap; }
.gc-msg:not(.mine) .msg-bubble { background:white; color:var(--text); box-shadow:0 1px 4px rgba(76,16,224,.08); border-bottom-left-radius:4px; }
.gc-msg.mine .msg-bubble { background:var(--purple); color:white; border-bottom-right-radius:4px; }

.msg-actions { opacity:0; transition:opacity .15s; display:flex; gap:3px; padding-top:6px; flex-shrink:0; }
.msg-action-btn { width:26px; height:26px; border-radius:7px; background:#f0eeff; border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; color:var(--purple); transition:all .15s; }
.msg-action-btn svg { width:12px; height:12px; }
.msg-action-btn:hover { background:#e0d5ff; }
.msg-action-btn.danger { background:#fff0f0; color:#e74c3c; }
.msg-action-btn.danger:hover { background:#ffd5d5; }

.edit-area { display:flex; flex-direction:column; gap:4px; }
.edit-input { padding:8px 12px; border:1.5px solid var(--purple); border-radius:12px; font-size:.87rem; outline:none; min-width:200px; }
.edit-btns { display:flex; gap:6px; }
.btn-xs { padding:4px 10px; border-radius:6px; font-size:.75rem; font-weight:700; cursor:pointer; border:none; font-family:'Instrument Sans',sans-serif; }
.btn-purple { background:var(--purple); color:white; }
.btn-ghost { background:#f0eeff; color:var(--text-2); }

.gc-input-area { display:flex; align-items:flex-end; gap:10px; padding:12px 20px; background:white; border-top:1px solid #ede8ff; flex-shrink:0; }
.gc-av { width:32px; height:32px; border-radius:50%; background:var(--purple); color:white; font-size:.78rem; font-weight:700; display:flex; align-items:center; justify-content:center; overflow:hidden; flex-shrink:0; margin-bottom:2px; }
.gc-av img { width:100%; height:100%; object-fit:cover; }
.gc-input-wrap { flex:1; position:relative; }
.gc-input { width:100%; padding:10px 50px 10px 16px; border:1.5px solid #e2d9ff; border-radius:20px; font-family:'Instrument Sans',sans-serif; font-size:.87rem; outline:none; resize:none; transition:border-color .18s; color:var(--text); display:block; }
.gc-input:focus { border-color:var(--purple); }
.char-count { position:absolute; right:12px; bottom:9px; font-size:.68rem; color:var(--text-2); pointer-events:none; }
.char-count.warn { color:#f97316; }
.gc-send { width:40px; height:40px; border-radius:50%; background:var(--purple); border:none; display:flex; align-items:center; justify-content:center; cursor:pointer; transition:all .18s; flex-shrink:0; color:white; margin-bottom:2px; }
.gc-send svg { width:15px; height:15px; }
.gc-send:hover:not(:disabled) { background:var(--purple-d); transform:scale(1.06); }
.gc-send:disabled { opacity:.35; cursor:not-allowed; transform:none; }
.gc-login-cta { display:flex; align-items:center; justify-content:center; gap:8px; padding:14px; background:#f0eeff; color:var(--purple); font-weight:600; font-size:.85rem; flex-shrink:0; }
.gc-login-cta svg { width:16px; height:16px; }
.spinner { width:28px; height:28px; border:3px solid #e2d9ff; border-top-color:var(--purple); border-radius:50%; animation:spin .7s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }

/* Mobile */
@media (max-width:600px) {
  .gc-header { padding:10px 14px; }
  .gc-subtitle { display:none; }
  .gc-msgs { padding:10px 10px; gap:4px; }
  .msg-col { max-width:75%; }
  .gc-input-area { padding:8px 12px; gap:7px; }
  .gc-av { display:none; }
  .gc-send { width:36px; height:36px; }
  .msg-actions { opacity:1; } /* Always visible on mobile - no hover available */
}
</style>
