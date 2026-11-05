<script setup>
import { ref, onMounted, onUnmounted, nextTick, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { supabase } from '../lib/supabaseClient'
import { getCurrentSession } from '../lib/authStore'
import { withTimeout, makeSafeLoader } from '../lib/withTimeout'
import { triggerNotification } from '../lib/pushNotifications'
import { checkModeration } from '../lib/moderation'
import { recordAndCheckSpam } from '../lib/spam'

const route = useRoute()
const router = useRouter()
function goToProfile(userId) {
  const session = getCurrentSession()
  if (userId === session?.user?.id) router.push('/profile')
  else router.push(`/profile/${userId}`)
}
const currentUser    = ref(null)
const currentProfile = ref(null)
const loadingPanel   = ref(true)
const friends      = ref([])
const activeFriend = ref(null)
const dmMessages   = ref([])
const loadingDms   = ref(false)
const newMessage  = ref('')
const sending     = ref(false)
const messagesEnd = ref(null)
const editingMsg  = ref(null)
const editContent = ref('')
const actionLoading = ref(false)
const messageInput = ref(null)
let realtimeSub = null

const chatBgStyle = computed(() => {
  const bg = currentProfile.value?.chat_bg_url
  if (bg) return { backgroundImage: `url(${bg})`, backgroundSize: 'cover', backgroundPosition: 'center' }
  return {}
})
const groupedMessages = computed(() => {
  const out = []; let lastDay = null
  for (const msg of dmMessages.value) {
    const day = new Date(msg.created_at).toDateString()
    if (day !== lastDay) { out.push({ type: 'd', label: fmtDay(msg.created_at) }); lastDay = day }
    out.push({ type: 'm', ...msg })
  }
  return out
})

onMounted(async () => {
  const _safeLoad = makeSafeLoader(loadingPanel)
  await _safeLoad(async () => {
    const session = getCurrentSession()
    if (!session?.user) return
    currentUser.value = session.user
    const { data: myProfile } = await withTimeout(
      supabase.from('profiles')
        .select('id, username, avatar_url, is_premium, username_color, chat_bg_url, warnings_count, is_banned')
        .eq('id', session.user.id).maybeSingle(),
      8000
    )
    currentProfile.value = myProfile
    await loadFriends()
    // Nettoyer les vieux "non lus" en base (évite le badge 8+ au rechargement)
    // uid est maintenant disponible via currentUser.value (défini juste au-dessus)
    const myId = currentUser.value.id
    supabase.from('messages')
      .update({ read: true })
      .eq('receiver_id', myId)
      .eq('read', false)
      .then(() => {
        friends.value.forEach(f => { f.unread = 0 })
      })
    // Démarrer l'écoute globale des messages dès le chargement
    subscribeRealtime()
    // Enregistrer le listener ici, dans le bon scope
    document.addEventListener('visibilitychange', _visRefresh)
    const friendId = route.query.friend
    if (friendId) {
      let f = friends.value.find(f => f.id === friendId)
      if (!f) {
        const { data: profile } = await supabase.from('profiles').select('id, username, avatar_url, is_premium, username_color').eq('id', friendId).maybeSingle()
        if (profile) {
          f = { ...profile, lastMsg: null, unread: 0, iFollow: false }
          friends.value.unshift(f)
        }
      }
      if (f) openDM(f)
    }
  })
})
onUnmounted(() => {
  realtimeSub?.unsubscribe()
  document.removeEventListener('visibilitychange', _visRefresh)
})

function _visRefresh() {
  if (document.visibilityState === 'visible' && activeFriend.value) {
    supabase.from('messages').update({ read: true })
      .eq('sender_id', activeFriend.value.id)
      .eq('receiver_id', currentUser.value?.id)
      .eq('read', false)
      .then(() => {})
  }
}

async function loadFriends() {
  const uid = currentUser.value.id
  const [iFollowRes, followMeRes, msgRes, blocksRes] = await Promise.all([
    withTimeout(supabase.from('follows').select('following_id').eq('follower_id', uid), 8000),
    withTimeout(supabase.from('follows').select('follower_id').eq('following_id', uid), 8000),
    withTimeout(supabase.from('messages').select('sender_id, receiver_id').or(`sender_id.eq.${uid},receiver_id.eq.${uid}`).order('created_at', { ascending: false }).limit(200), 8000),
    withTimeout(supabase.from('blocks').select('*').or(`blocker_id.eq.${uid},blocked_id.eq.${uid}`), 5000)
  ])

  const blocks = blocksRes?.data || []
  const blockedIds = new Set(blocks.map(b => b.blocker_id === uid ? b.blocked_id : b.blocker_id))

  const iFollowIds  = new Set(iFollowRes?.data?.map(f => f.following_id) || [])
  const followMeIds = new Set(followMeRes?.data?.map(f => f.follower_id) || [])
  const mutualIds   = [...iFollowIds].filter(id => followMeIds.has(id))

  const msgIds = new Set((msgRes?.data || []).flatMap(m => [m.sender_id, m.receiver_id]))
  msgIds.delete(uid)

  const allIds = Array.from(new Set([...mutualIds, ...msgIds])).filter(id => !blockedIds.has(id))
  
  if (!allIds.length) { friends.value = []; return }

  const profilesRes = await withTimeout(
    supabase.from('profiles')
      .select('id, username, avatar_url, is_premium, username_color').in('id', allIds),
    8000
  )

  const enriched = await Promise.all((profilesRes?.data || []).map(async p => {
    const [lastRes, unreadRes] = await Promise.all([
      withTimeout(
        supabase.from('messages')
          .select('content, created_at, image_url, sender_id, deleted')
          .or(`and(sender_id.eq.${uid},receiver_id.eq.${p.id}),and(sender_id.eq.${p.id},receiver_id.eq.${uid})`)
          .order('created_at', { ascending: false }).limit(1).maybeSingle(),
        6000
      ),
      withTimeout(
        supabase.from('messages')
          .select('*', { count: 'exact', head: true })
          .eq('sender_id', p.id).eq('receiver_id', uid).eq('read', false),
        6000
      ),
    ])
    return { ...p, lastMsg: lastRes?.data, unread: unreadRes?.count || 0, iFollow: iFollowIds.has(p.id) }
  }))
  enriched.sort((a, b) => {
    if (!a.lastMsg && !b.lastMsg) return 0
    if (!a.lastMsg) return 1; if (!b.lastMsg) return -1
    return new Date(b.lastMsg.created_at) - new Date(a.lastMsg.created_at)
  })
  friends.value = enriched
}

async function openDM(friend) {
  if (activeFriend.value?.id === friend.id) return
  activeFriend.value = friend
  router.replace({ path: '/chat', query: { friend: friend.id } })
  loadingDms.value = true
  dmMessages.value = []
  try {
    const uid = currentUser.value.id
    const fid = friend.id
    const result = await withTimeout(
      supabase.from('messages').select('*')
        .or(`and(sender_id.eq.${uid},receiver_id.eq.${fid}),and(sender_id.eq.${fid},receiver_id.eq.${uid})`)
        .order('created_at', { ascending: true })
        .limit(100),
      8000
    )
    dmMessages.value = result?.data || []
    // Mark as read in background (non-blocking)
    supabase.from('messages').update({ read: true })
      .eq('sender_id', fid).eq('receiver_id', uid).eq('read', false)
    const f = friends.value.find(f => f.id === fid)
    if (f) f.unread = 0
    // subscribeRealtime() est global, pas besoin de relancer ici
  } catch (e) {
    console.warn('openDM error:', e)
  } finally {
    loadingDms.value = false
    scrollToBottom()
    nextTick(() => {
      messageInput.value?.focus()
    })
  }
}

async function sendMessage() {
  const content = newMessage.value.trim()
  if (!content || sending.value) return
  
  const mod = await checkModeration(content, currentProfile.value)
  if (mod.blocked) {
    alert(mod.reason)
    if (mod.banned) router.push('/auth')
    else {
      newMessage.value = ''
      // Refresh local profile to get updated warning count
      const { data } = await supabase.from('profiles').select('warnings_count, is_banned').eq('id', currentUser.value.id).maybeSingle()
      if (data) Object.assign(currentProfile.value, data)
    }
    return
  }

  sending.value = true
  newMessage.value = ''
  await insertDM({ content, image_url: null })
  sending.value = false
}

async function handleImagePick(e) {
  const file = e.target.files[0]
  if (!file) return
  sending.value = true
  const path = `chat/${currentUser.value.id}/${Date.now()}_${file.name}`
  const { error: upErr } = await supabase.storage.from('media').upload(path, file)
  if (upErr) { sending.value = false; return }
  const { data: { publicUrl } } = supabase.storage.from('media').getPublicUrl(path)
  await insertDM({ content: '', image_url: publicUrl })
  sending.value = false
  e.target.value = ''
}

async function insertDM({ content, image_url }) {
  const tmpId = 'tmp-' + Date.now()
  const uid = currentUser.value.id
  const fid = activeFriend.value.id
  dmMessages.value.push({ id: tmpId, sender_id: uid, receiver_id: fid, content, image_url, created_at: new Date().toISOString(), read: false, deleted: false })
  scrollToBottom()
  const { data, error } = await supabase.from('messages')
    .insert({ sender_id: uid, receiver_id: fid, content, image_url, read: false }).select().single()
  if (!error && data) {
    const idx = dmMessages.value.findIndex(m => m.id === tmpId)
    if (idx !== -1) dmMessages.value.splice(idx, 1, data)
    const f = friends.value.find(f => f.id === fid)
    if (f) f.lastMsg = data

    // Anti-spam check
    const spam = await recordAndCheckSpam(currentProfile.value, data.id, 'messages', content)
    if (spam.blocked) {
      alert(spam.reason)
      if (spam.banned) router.push('/auth')
      else {
        // Refresh local profile for warning count
        const { data: p } = await supabase.from('profiles').select('warnings_count, is_banned').eq('id', uid).maybeSingle()
        if (p) Object.assign(currentProfile.value, p)
      }
    }
  } else if (error) {
    const idx = dmMessages.value.findIndex(m => m.id === tmpId)
    if (idx !== -1) dmMessages.value.splice(idx, 1)
    alert('Impossible d\'envoyer le message. ' + (error.message || ''))
  }
}

function startEdit(msg) { editingMsg.value = { id: msg.id }; editContent.value = msg.content || '' }
function cancelEdit() { editingMsg.value = null; editContent.value = '' }

async function saveEdit() {
  if (!editingMsg.value) return
  const { id } = editingMsg.value
  const content = editContent.value.trim()
  if (!content) return

  const mod = await checkModeration(content, currentProfile.value)
  if (mod.blocked) {
    alert(mod.reason)
    if (mod.banned) router.push('/auth')
    cancelEdit()
    return
  }

  await supabase.from('messages').update({ content, edited: true, updated_at: new Date().toISOString() }).eq('id', id)
  const idx = dmMessages.value.findIndex(m => m.id === id)
  if (idx !== -1) dmMessages.value[idx] = { ...dmMessages.value[idx], content, edited: true }
  cancelEdit()
}

async function deleteMsg(msg) {
  if (!confirm('Delete this message?')) return
  await supabase.from('messages').update({ deleted: true, content: '' }).eq('id', msg.id)
  const idx = dmMessages.value.findIndex(m => m.id === msg.id)
  if (idx !== -1) dmMessages.value[idx] = { ...dmMessages.value[idx], deleted: true, content: '' }
}

function subscribeRealtime() {
  realtimeSub?.unsubscribe()
  const uid = currentUser.value.id
  // Filtre strict : uniquement les messages REÇUS par moi (pas envoyés par moi)
  realtimeSub = supabase.channel(`dm_inbox:${uid}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'messages',
      filter: `receiver_id=eq.${uid}`
    }, async payload => {
      const senderId = payload.new.sender_id
      // Sécurité : ignorer si c'est mon propre message (ne devrait pas arriver
      // avec receiver_id=eq.${uid} mais soyons prudents)
      if (senderId === uid) return

      const isActiveConv = activeFriend.value?.id === senderId

      if (isActiveConv) {
        // Conversation ouverte : ajouter le message + marquer lu
        if (!dmMessages.value.find(m => m.id === payload.new.id)) {
          dmMessages.value.push(payload.new)
          scrollToBottom()
          supabase.from('messages').update({ read: true }).eq('id', payload.new.id)
        }
        // Notif seulement si l'onglet est masqué
        if (document.hidden) {
          const senderName = activeFriend.value?.username || "Someone"
          triggerNotification(`ONBSocial — ${senderName}`, payload.new.content || '[Image]')
        }
      } else {
        // Autre ami : badge + remonter dans la liste
        const sender = friends.value.find(f => f.id === senderId)
        if (sender) {
          sender.unread = (sender.unread || 0) + 1
          sender.lastMsg = payload.new
          // Remonter cet ami en tête
          friends.value = [sender, ...friends.value.filter(f => f.id !== senderId)]
        }
        // Notif quelle que soit la visibilité (l'utilisateur regarde autre chose)
        const senderName = sender?.username || "Someone"
        triggerNotification(`ONBSocial — ${senderName}`, payload.new.content || '[Image]')
      }
    })
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'messages',
      filter: `receiver_id=eq.${uid}`
    }, payload => {
      const idx = dmMessages.value.findIndex(m => m.id === payload.new.id)
      if (idx !== -1) dmMessages.value.splice(idx, 1, { ...dmMessages.value[idx], ...payload.new })
    })
    .subscribe()
}

function scrollToBottom() { nextTick(() => messagesEnd.value?.scrollIntoView({ behavior: 'smooth' })) }

async function addActiveFriend() {
  if (!activeFriend.value || actionLoading.value) return
  actionLoading.value = true
  const tid = activeFriend.value.id
  await supabase.from('follows').insert({ follower_id: currentUser.value.id, following_id: tid })
  activeFriend.value.iFollow = true
  const f = friends.value.find(x => x.id === tid)
  if (f) f.iFollow = true
  actionLoading.value = false
}

async function blockActiveFriend() {
  if (!activeFriend.value || actionLoading.value) return
  if (!confirm(`Voulez-vous vraiment bloquer @${activeFriend.value.username} ?`)) return
  actionLoading.value = true
  const tid = activeFriend.value.id
  await supabase.from('blocks').insert({ blocker_id: currentUser.value.id, blocked_id: tid })
  friends.value = friends.value.filter(x => x.id !== tid)
  activeFriend.value = null
  actionLoading.value = false
}

function fmtTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
function fmtDay(ts) {
  const diff = Math.floor((Date.now() - new Date(ts)) / 86400000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
}
function fmtLastMsg(item) {
  if (!item.lastMsg) return 'No messages'
  const m = item.lastMsg
  if (m.deleted) return '[Message supprimé]'
  const pre = m.sender_id === currentUser.value?.id ? 'Vous : ' : ''
  if (m.image_url && !m.content) return pre + '[Image]'
  return pre + (m.content?.length > 28 ? m.content.slice(0, 28) + '...' : m.content || '')
}
function isMyMsg(msg) { return msg.sender_id === currentUser.value?.id }
</script>

<template>
  <div class="chat-page">
    <div class="chat-layout">

      <!-- LEFT PANEL -->
      <div class="left-panel">
        <div class="panel-header">
          <span class="panel-title">Messages</span>
        </div>

        <div v-if="loadingPanel" class="panel-status"><div class="spinner"></div></div>
        <div v-else-if="friends.length === 0" class="panel-status empty">
          <p>No friends yet — follow someone and get followed back!</p>
        </div>
        <div v-for="f in friends" :key="f.id" class="conv-row" :class="{ active: activeFriend?.id === f.id }" @click="openDM(f)">
          <div class="cav">
            <img v-if="f.avatar_url" :src="f.avatar_url" />
            <span v-else>{{ f.username?.charAt(0)?.toUpperCase() }}</span>
          </div>
          <div class="cinfo">
            <div class="cinfo-top">
              <span class="cname" :style="f.username_color ? { color: f.username_color } : {}">@{{ f.username }}</span>
              <span v-if="f.lastMsg" class="ctime">{{ fmtTime(f.lastMsg.created_at) }}</span>
            </div>
            <div class="cinfo-bot">
              <span class="clast" :class="{ unread: f.unread > 0 }">{{ fmtLastMsg(f) }}</span>
              <span v-if="f.unread > 0" class="badge">{{ f.unread > 9 ? '9+' : f.unread }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- MSG PANEL -->
      <div class="msg-panel">
        <div v-if="!activeFriend" class="no-chat">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="width:52px;height:52px;opacity:.2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <p>Select a conversation</p>
        </div>

        <template v-else>
          <div class="chat-head">
            <div class="cav" style="width:38px;height:38px">
              <img v-if="activeFriend.avatar_url" :src="activeFriend.avatar_url" />
              <span v-else>{{ activeFriend.username?.charAt(0)?.toUpperCase() }}</span>
            </div>
            <div class="chat-head-info">
              <span class="ch-name" @click="goToProfile(activeFriend.id)" style="cursor:pointer;text-decoration:none;" title="View profile">@{{ activeFriend.username }}</span>
              <span class="ch-sub online"><span class="online-dot"></span>Online</span>
            </div>
            <div class="chat-head-actions" v-if="!activeFriend.iFollow">
              <button class="chat-action-btn add" @click="addActiveFriend" :disabled="actionLoading">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
                <span class="btn-text">Ajouter</span>
              </button>
              <button class="chat-action-btn block" @click="blockActiveFriend" :disabled="actionLoading" title="Bloquer">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
              </button>
            </div>
          </div>

          <div class="msgs-area" :style="chatBgStyle">
            <div v-if="currentProfile?.chat_bg_url" class="bg-overlay"></div>
            <div v-if="loadingDms" class="msgs-loading"><div class="spinner"></div></div>
            <div v-else class="msgs-list">
              <template v-for="(item, i) in groupedMessages" :key="i">
                <div v-if="item.type === 'd'" class="daysep"><span>{{ item.label }}</span></div>
                <div v-else class="msg-wrap" :class="isMyMsg(item) ? 'me' : 'them'">
                  <div class="msg-col">
                    <div class="bubble-wrap">
                      <div v-if="isMyMsg(item) && !item.deleted && !String(item.id).startsWith('tmp')" class="msg-actions">
                        <button class="mact-btn" @click="startEdit(item)">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        </button>
                        <button class="mact-btn del" @click="deleteMsg(item)">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                        </button>
                      </div>
                      <div v-if="editingMsg?.id === item.id" class="edit-bubble">
                        <input v-model="editContent" class="edit-input" @keyup.enter="saveEdit" @keyup.escape="cancelEdit" autofocus />
                        <div class="edit-btns">
                          <button class="edit-cancel" @click="cancelEdit">Cancel</button>
                          <button class="edit-save" @click="saveEdit">Save</button>
                        </div>
                      </div>
                      <div v-else class="bubble" :class="{ 'bubble-bg': !!currentProfile?.chat_bg_url, deleted: item.deleted }">
                        <span v-if="item.deleted" class="deleted-text">Message supprimé</span>
                        <template v-else>
                          <img v-if="item.image_url" :src="item.image_url" class="msg-img" />
                          <span v-if="item.content">{{ item.content }}</span>
                        </template>
                        <div class="bubble-meta">
                          <span v-if="item.edited && !item.deleted" class="edited-tag">modifié</span>
                          <span class="bt">{{ fmtTime(item.created_at) }}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </template>
              <div ref="messagesEnd"></div>
            </div>
          </div>

          <div class="input-bar">
            <label class="attach-btn">
              <input type="file" accept="image/*" @change="handleImagePick" hidden />
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            </label>
            <input ref="messageInput" v-model="newMessage" placeholder="Write a message…" @keyup.enter="sendMessage" class="minput" :disabled="sending" />
            <button class="sbtn" @click="sendMessage" :disabled="!newMessage.trim() || sending">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-page { display:flex; flex-direction:column; flex:1; min-height:0; overflow:hidden; background:var(--app-bg); }
.chat-layout { display:flex; flex:1; min-height:0; overflow:hidden; }
.left-panel { width:280px; flex-shrink:0; background:white; border-right:1px solid #ede8ff; display:flex; flex-direction:column; overflow-y:auto; }
.panel-header { display:flex; align-items:center; padding:14px 16px; border-bottom:1px solid #f0ecff; flex-shrink:0; }
.panel-title { font-family:'Epilogue',sans-serif; font-weight:800; font-size:1rem; color:var(--text); }
.panel-status { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; padding:40px 20px; }
.panel-status.empty { color:var(--text-2); font-size:0.8rem; text-align:center; }
.conv-row { display:flex; align-items:center; gap:12px; padding:11px 14px; cursor:pointer; border-bottom:1px solid #f7f5ff; transition:background .15s; }
.conv-row:hover { background:#f7f4ff; }
.conv-row.active { background:#eee8ff; }
.cav { width:42px; height:42px; border-radius:50%; background:var(--purple); color:white; font-weight:700; font-size:0.95rem; display:flex; align-items:center; justify-content:center; overflow:hidden; flex-shrink:0; }
.cav img { width:100%; height:100%; object-fit:cover; }
.group-av { background:#e8e0ff; color:var(--purple); }
.cinfo { flex:1; overflow:hidden; min-width:0; display:flex; flex-direction:column; gap:3px; }
.cinfo-top { display:flex; align-items:center; gap:4px; }
.cname { font-weight:700; font-size:0.86rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; color:var(--text); }
.ctime { font-size:0.7rem; color:var(--text-2); flex-shrink:0; }
.cinfo-bot { display:flex; justify-content:space-between; align-items:center; }
.clast { font-size:0.74rem; color:var(--text-2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
.clast.unread { color:var(--text); font-weight:700; }
.badge { background:var(--purple); color:white; font-size:0.68rem; font-weight:800; min-width:18px; height:18px; border-radius:9px; padding:0 5px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
.msg-panel { flex:1; display:flex; flex-direction:column; min-height:0; overflow:hidden; }
.no-chat { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px; color:var(--text-2); font-size:0.9rem; }
.chat-head { display:flex; align-items:center; gap:12px; padding:12px 18px; background:white; border-bottom:1px solid #ede8ff; flex-shrink:0; }
.chat-head-info { flex:1; display:flex; flex-direction:column; gap:2px; }
.ch-name { font-weight:700; font-size:0.9rem; color:var(--text); }
.ch-sub { font-size:0.73rem; color:var(--text-2); }
.ch-sub.online { display:flex; align-items:center; gap:5px; color:#22c55e; font-weight:600; }
.online-dot { width:7px; height:7px; border-radius:50%; background:#22c55e; }
.chat-head-actions { display:flex; gap:8px; align-items:center; margin-left:auto; }
.chat-action-btn { display:flex; align-items:center; gap:5px; padding:6px 12px; border-radius:14px; font-size:0.8rem; font-family:'Instrument Sans', sans-serif; font-weight:600; cursor:pointer; border:none; transition:all .15s; }
.chat-action-btn:disabled { opacity:0.5; cursor:not-allowed; }
.chat-action-btn.add { background:var(--purple); color:white; }
.chat-action-btn.add:hover:not(:disabled) { background:var(--purple-d); }
.chat-action-btn.block { background:rgba(239, 68, 68, 0.1); color:#ef4444; padding:6px 8px; }
.chat-action-btn.block:hover:not(:disabled) { background:rgba(239, 68, 68, 0.2); }
.chat-action-btn svg { width:14px; height:14px; }
.head-btn { width:32px; height:32px; border-radius:50%; background:#f0eeff; border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; color:var(--purple); }
.head-btn svg { width:15px; height:15px; }
.msgs-area { flex:1; min-height:0; overflow-y:auto; padding:16px 20px; position:relative; }
.bg-overlay { position:absolute; inset:0; background:rgba(238,233,255,0.55); backdrop-filter:blur(1px); pointer-events:none; z-index:0; }
.msgs-loading { display:flex; justify-content:center; padding:40px; }
.msgs-list { display:flex; flex-direction:column; gap:2px; position:relative; z-index:1; }
.daysep { display:flex; align-items:center; gap:10px; margin:16px 0 10px; font-size:0.72rem; font-weight:600; color:var(--text-2); }
.daysep::before,.daysep::after { content:''; flex:1; height:1px; background:#e2d9ff; }
.msg-wrap { display:flex; align-items:flex-end; gap:8px; margin-bottom:4px; }
.msg-wrap.me { justify-content:flex-end; }
.msg-wrap.them { justify-content:flex-start; }
.msg-av { width:28px; height:28px; border-radius:50%; background:var(--purple); color:white; font-size:0.72rem; font-weight:700; display:flex; align-items:center; justify-content:center; overflow:hidden; flex-shrink:0; }
.msg-av img { width:100%; height:100%; object-fit:cover; }
.msg-col { display:flex; flex-direction:column; gap:2px; max-width:64%; }
.me .msg-col { align-items:flex-end; }
.them .msg-col { align-items:flex-start; }
.msg-sender { font-size:0.72rem; font-weight:700; color:var(--purple); padding:0 4px; }
.bubble-wrap { display:flex; align-items:center; gap:4px; }
.me .bubble-wrap { flex-direction:row-reverse; }
.msg-actions { display:flex; gap:2px; opacity:0; transition:opacity .15s; }
.msg-wrap:hover .msg-actions { opacity:1; }
.mact-btn { width:24px; height:24px; border-radius:6px; background:rgba(0,0,0,0.06); border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; color:var(--text-2); transition:all .15s; }
.mact-btn svg { width:11px; height:11px; }
.mact-btn:hover { background:#f0eeff; color:var(--purple); }
.mact-btn.del:hover { background:#fff0f0; color:#e74c3c; }
.edit-bubble { display:flex; flex-direction:column; gap:6px; min-width:200px; }
.edit-input { padding:8px 12px; border:1.5px solid var(--purple); border-radius:12px; font-family:'Instrument Sans',sans-serif; font-size:0.88rem; outline:none; }
.edit-btns { display:flex; gap:6px; justify-content:flex-end; }
.edit-cancel { padding:4px 10px; border:1px solid #ddd; border-radius:6px; background:none; font-size:0.78rem; cursor:pointer; }
.edit-save { padding:4px 12px; background:var(--purple); color:white; border:none; border-radius:6px; font-size:0.78rem; font-weight:700; cursor:pointer; }
.bubble { max-width:100%; padding:9px 13px; border-radius:18px; font-size:0.87rem; line-height:1.45; word-break:break-word; display:flex; flex-direction:column; gap:3px; }
.me .bubble { background:var(--purple); color:white; border-bottom-right-radius:4px; }
.them .bubble { background:white; color:var(--text); border-bottom-left-radius:4px; box-shadow:0 1px 6px rgba(76,16,224,0.1); }
.me .bubble.bubble-bg { background:rgba(76,16,224,0.92); }
.them .bubble.bubble-bg { background:rgba(255,255,255,0.92); }
.bubble.deleted { opacity:0.5; font-style:italic; }
.deleted-text { font-size:0.82rem; }
.bubble-meta { display:flex; align-items:center; gap:5px; justify-content:flex-end; }
.bt { font-size:0.67rem; opacity:0.6; }
.edited-tag { font-size:0.62rem; opacity:0.55; font-style:italic; }
.msg-img { max-width:200px; border-radius:10px; cursor:pointer; display:block; }
.input-bar { display:flex; align-items:center; gap:10px; padding:12px 16px; background:white; border-top:1px solid #ede8ff; flex-shrink:0; }
.attach-btn { width:36px; height:36px; border-radius:50%; display:flex; align-items:center; justify-content:center; cursor:pointer; color:var(--text-2); transition:all .15s; flex-shrink:0; }
.attach-btn svg { width:18px; height:18px; }
.attach-btn:hover { background:#f0ecff; color:var(--purple); }
.minput { flex:1; padding:10px 16px; border:1.5px solid #e2d9ff; border-radius:22px; font-family:'Instrument Sans',sans-serif; font-size:0.9rem; outline:none; transition:border-color .18s; background:var(--app-bg); }
.minput:focus { border-color:var(--purple); background:white; }
.sbtn { width:40px; height:40px; border-radius:50%; background:var(--purple); border:none; display:flex; align-items:center; justify-content:center; cursor:pointer; flex-shrink:0; transition:all .18s; }
.sbtn svg { width:15px; height:15px; color:white; }
.sbtn:hover { background:var(--purple-d); transform:scale(1.06); }
.sbtn:disabled { opacity:0.35; cursor:not-allowed; transform:none; }
.modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:500; display:flex; align-items:center; justify-content:center; padding:20px; backdrop-filter:blur(4px); }
.modal { background:white; border-radius:20px; width:100%; max-width:480px; max-height:85vh; display:flex; flex-direction:column; box-shadow:0 20px 60px rgba(0,0,0,0.25); overflow:hidden; }
.modal-header { display:flex; justify-content:space-between; align-items:center; padding:18px 22px; border-bottom:1px solid #f0ecff; flex-shrink:0; }
.modal-header h3 { font-family:'Epilogue',sans-serif; font-size:1.1rem; font-weight:800; color:var(--text); }
.modal-close { width:30px; height:30px; border-radius:50%; background:#f0eeff; border:none; cursor:pointer; font-size:0.9rem; color:var(--text-2); }
.modal-body { flex:1; overflow-y:auto; padding:20px 22px; display:flex; flex-direction:column; gap:16px; }
.modal-footer { padding:16px 22px; border-top:1px solid #f0ecff; display:flex; gap:10px; justify-content:flex-end; flex-shrink:0; }
.mfield { display:flex; flex-direction:column; gap:6px; }
.mfield label { font-size:0.73rem; font-weight:700; color:var(--text-2); letter-spacing:.05em; text-transform:uppercase; }
.minput-field { padding:10px 14px; border:1.5px solid #e2d9ff; border-radius:10px; font-family:'Instrument Sans',sans-serif; font-size:0.9rem; outline:none; transition:border-color .18s; }
.minput-field:focus { border-color:var(--purple); }
.no-friends-note { font-size:0.82rem; color:var(--text-2); font-style:italic; }
.members-list { display:flex; flex-direction:column; gap:4px; max-height:160px; overflow-y:auto; }
.member-pick { display:flex; align-items:center; gap:10px; padding:8px 12px; border-radius:10px; border:1.5px solid #e2d9ff; cursor:pointer; font-size:0.86rem; transition:all .15s; }
.member-pick.selected { background:#f0eeff; border-color:var(--purple); color:var(--purple); font-weight:600; }
.mp-check { width:16px; text-align:center; font-weight:900; color:var(--purple); }
.group-desc-text { font-size:0.88rem; color:var(--text-2); line-height:1.5; }
.members-info-list { display:flex; flex-direction:column; gap:4px; max-height:200px; overflow-y:auto; }
.member-info-row { display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:10px; background:#f7f4ff; }
.mi-av { width:32px; height:32px; border-radius:50%; background:var(--purple); color:white; font-weight:700; font-size:0.82rem; display:flex; align-items:center; justify-content:center; overflow:hidden; flex-shrink:0; }
.mi-av img { width:100%; height:100%; object-fit:cover; }
.mi-name { flex:1; font-size:0.86rem; font-weight:600; color:var(--text); }
.mi-admin { font-size:0.7rem; font-weight:800; padding:3px 8px; background:linear-gradient(135deg,#fbbf24,#f97316); color:white; border-radius:10px; }
.btn-cancel { padding:9px 16px; border:1px solid #ddd; border-radius:10px; background:none; font-size:0.85rem; cursor:pointer; font-family:'Instrument Sans',sans-serif; }
.btn-create { display:flex; align-items:center; gap:7px; padding:9px 20px; background:var(--purple); color:white; border:none; border-radius:10px; font-weight:700; font-size:0.85rem; cursor:pointer; }
.btn-create:disabled { opacity:0.5; cursor:not-allowed; }
.btn-leave { padding:9px 16px; border:1.5px solid #f97316; color:#f97316; border-radius:10px; background:none; font-size:0.85rem; font-weight:600; cursor:pointer; }
.btn-del-group { padding:9px 16px; background:#ef4444; color:white; border:none; border-radius:10px; font-size:0.85rem; font-weight:600; cursor:pointer; }
.btn-spin { width:14px; height:14px; border:2px solid rgba(255,255,255,0.4); border-top-color:white; border-radius:50%; animation:spin .6s linear infinite; display:inline-block; }
.spinner { width:28px; height:28px; border:3px solid #e2d9ff; border-top-color:var(--purple); border-radius:50%; animation:spin .7s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
@media (max-width:640px) {
  .left-panel { width:68px; }
  .cinfo, .groups-header span { display:none; }
  .conv-row { justify-content:center; padding:10px; }
  .ptab svg { width:18px; height:18px; }
  .chat-action-btn .btn-text { display:none; }
  .chat-action-btn { padding:6px 8px; }
}
</style>
