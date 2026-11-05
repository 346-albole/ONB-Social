<script setup>
import { ref, onMounted, onUnmounted, computed, nextTick } from 'vue'
import { supabase } from '../lib/supabaseClient'
import { getCurrentSession } from '../lib/authStore'
import { withTimeout, makeSafeLoader } from '../lib/withTimeout'
import { triggerNotification } from '../lib/pushNotifications'
import { useRouter } from 'vue-router'

const currentUser    = ref(null)

const router = useRouter()
function goToProfile(userId) {
  if (userId === currentUser.value?.id) router.push('/profile')
  else router.push(`/profile/${userId}`)
}
const currentProfile = ref(null)
const groups         = ref([])
const loading        = ref(true)
const searchQ        = ref('')
const activeGroup    = ref(null)
const activeTab      = ref('chat') // 'chat' | 'members'

// Group chat
const chatMessages  = ref([])
const loadingChat   = ref(false)
const newChatMsg    = ref('')
const sendingChat   = ref(false)
const chatEnd       = ref(null)
let   chatSub       = null

// Members
const groupMembers  = ref([])
const loadingMembers= ref(false)

// Create
const showCreate       = ref(false)
const newGroupName     = ref('')
const newGroupDesc     = ref('')
const newGroupIsPrivate= ref(false)
const newGroupBanner   = ref(null)
const newGroupBannerUrl= ref(null)
const creating         = ref(false)

// Membership
const memberIds = ref(new Set())
const hiddenGroups = ref(new Set()) // groups hidden from sidebar
const isAdminUser = ref(false)

// Invite modal
const showInvite    = ref(false)
const inviteSearch  = ref('')
const inviteResults = ref([])
const inviteLoading = ref(false)
const inviting      = ref(new Set())

// filteredVisible (below) replaces filtered

const isMember  = computed(() => activeGroup.value && memberIds.value.has(activeGroup.value.id))
const isOwner   = computed(() => activeGroup.value?.created_by === currentUser.value?.id)

// ── LOAD ──────────────────────────────────────────────────────
const _safeLoad = makeSafeLoader(loading)
async function load() {
  await _safeLoad(async () => {
    const session = getCurrentSession()
    currentUser.value = session?.user || null

    if (currentUser.value) {
      const { data: p } = await withTimeout(
        supabase.from('profiles')
          .select('id, username, avatar_url, username_color, is_admin')
          .eq('id', currentUser.value.id).maybeSingle(),
        8000
      )
      currentProfile.value = p
      isAdminUser.value = p?.is_admin || false
    }

    const [groupsRes, memRes] = await Promise.all([
      withTimeout(
        supabase.from('groups')
          .select('id, name, description, banner_url, created_by, created_at, is_private, group_members(count)')
          .order('created_at', { ascending: false }),
        10000
      ),
      currentUser.value
        ? withTimeout(
            supabase.from('group_members').select('group_id').eq('user_id', currentUser.value.id),
            8000
          )
        : Promise.resolve(null),
    ])
    groups.value = groupsRes?.data || []
    if (currentUser.value) {
      memberIds.value = new Set(memRes?.data?.map(m => m.group_id) || [])
    }
  })
}

// ── OPEN GROUP ────────────────────────────────────────────────
async function openGroup(group) {
  if (activeGroup.value?.id === group.id) return
  chatSub?.unsubscribe()
  chatMessages.value = []
  groupMembers.value = []
  activeGroup.value  = group
  activeTab.value    = 'chat'
  await Promise.all([loadChat(), loadMembers()])
}

// ── CHAT ──────────────────────────────────────────────────────
async function loadChat() {
  loadingChat.value = true
  try {
    const result = await withTimeout(
      supabase.from('group_messages')
        .select('*, profiles(username, avatar_url, username_color)')
        .eq('group_id', activeGroup.value.id)
        .order('created_at', { ascending: true })
        .limit(100),
      10000
    )
    if (result?.data) chatMessages.value = result.data
  } catch (e) {
    console.warn('loadChat error:', e)
  } finally {
    loadingChat.value = false
    scrollChatToBottom()
    subscribeChat()
  }
}

function subscribeChat() {
  chatSub?.unsubscribe()
  if (!activeGroup.value) return
  chatSub = supabase.channel(`grpchat:${activeGroup.value.id}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'group_messages',
      filter: `group_id=eq.${activeGroup.value.id}`
    }, async payload => {
      if (chatMessages.value.find(m => m.id === payload.new.id)) return
      const { data } = await supabase
        .from('group_messages')
        .select('*, profiles(username, avatar_url, username_color)')
        .eq('id', payload.new.id).single()
      if (data) {
        chatMessages.value.push(data); scrollChatToBottom()
        // Browser notification if message is not from current user and tab is not visible
        if (data.profiles && data.sender_id !== currentUser.value?.id) {
          const senderName = data.profiles.username || 'Someone'
          const groupName = activeGroup.value?.name || 'Group'
          const msgPreview = data.content || 'Image'
          triggerNotification(`ONBSocial — ${groupName}`, `${senderName}: ${msgPreview}`)
        }
      }
    })
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'group_messages',
      filter: `group_id=eq.${activeGroup.value.id}`
    }, payload => {
      const idx = chatMessages.value.findIndex(m => m.id === payload.new.id)
      if (idx !== -1) chatMessages.value[idx] = { ...chatMessages.value[idx], ...payload.new }
    })
    .on('postgres_changes', {
      event: 'DELETE', schema: 'public', table: 'group_messages',
      filter: `group_id=eq.${activeGroup.value.id}`
    }, payload => {
      chatMessages.value = chatMessages.value.filter(m => m.id !== payload.old.id)
    })
    // Listen for member kicks (DELETE on group_members) to update the UI
    .on('postgres_changes', {
      event: 'DELETE', schema: 'public', table: 'group_members',
      filter: `group_id=eq.${activeGroup.value.id}`
    }, payload => {
      groupMembers.value = groupMembers.value.filter(m => m.user_id !== payload.old.user_id)
      // If current user was kicked, reflect that
      if (payload.old.user_id === currentUser.value?.id) {
        memberIds.value.delete(activeGroup.value.id)
      }
    })
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'group_members',
      filter: `group_id=eq.${activeGroup.value.id}`
    }, async () => {
      // Refresh members list
      await loadMembers()
    })
    .subscribe()
}

async function sendChatMessage() {
  if (!newChatMsg.value.trim() || sendingChat.value || !isMember.value) return
  sendingChat.value = true
  const content = newChatMsg.value.trim()
  newChatMsg.value = ''
  const { data, error } = await supabase.from('group_messages').insert({
    group_id: activeGroup.value.id,
    sender_id: currentUser.value.id,
    content,
    created_at: new Date().toISOString(),
  }).select('*, profiles(username, avatar_url, username_color)').single()
  if (!error && data && !chatMessages.value.find(m => m.id === data.id)) {
    chatMessages.value.push(data)
    scrollChatToBottom()
  }
  sendingChat.value = false
}

function scrollChatToBottom() {
  nextTick(() => chatEnd.value?.scrollIntoView({ behavior: 'smooth' }))
}

// ── MEMBERS ───────────────────────────────────────────────────
async function loadMembers() {
  loadingMembers.value = true
  try {
    const result = await withTimeout(
      supabase.from('group_members')
        .select('user_id, role, joined_at, profiles(id, username, avatar_url, is_official, is_premium, username_color)')
        .eq('group_id', activeGroup.value.id)
        .order('joined_at', { ascending: true }),
      8000
    )
    if (!result?.error) groupMembers.value = result?.data || []
  } catch (e) {
    console.warn('loadMembers error:', e)
  } finally {
    loadingMembers.value = false
  }
}

async function kickMember(member) {
  if (!isOwner.value) return
  if (member.user_id === currentUser.value.id) return
  if (!confirm(`Remove @${member.profiles?.username} from the group?`)) return
  const { error } = await supabase.from('group_members')
    .delete()
    .eq('group_id', activeGroup.value.id)
    .eq('user_id', member.user_id)
  if (!error) {
    groupMembers.value = groupMembers.value.filter(m => m.user_id !== member.user_id)
    memberIds.value.delete(member.user_id)
    const g = groups.value.find(g => g.id === activeGroup.value.id)
    if (g?.group_members?.[0]) g.group_members[0].count = Math.max(0, (g.group_members[0].count || 1) - 1)
  } else {
    alert('Erreur lors de l\'expulsion : ' + (error.message || 'Permission refusée'))
  }
}

// ── MEMBERSHIP ────────────────────────────────────────────────
async function toggleMembership(group) {
  if (!currentUser.value) return
  const was = memberIds.value.has(group.id)
  if (was) {
    if (group.created_by === currentUser.value.id) return // owner can't leave
    memberIds.value.delete(group.id)
    await supabase.from('group_members').delete()
      .eq('group_id', group.id).eq('user_id', currentUser.value.id)
    const g = groups.value.find(g => g.id === group.id)
    if (g?.group_members?.[0]) g.group_members[0].count = Math.max(0, (g.group_members[0].count || 1) - 1)
  } else {
    // Block joining private groups — must be invited by owner
    if (group.is_private) {
      alert('This group is private. You must be invited by the owner to join.')
      return
    }
    memberIds.value.add(group.id)
    const { error } = await supabase.from('group_members')
      .insert({ group_id: group.id, user_id: currentUser.value.id, role: 'member' })
    if (error) { memberIds.value.delete(group.id); alert('Erreur : ' + error.message); return }
    const g = groups.value.find(g => g.id === group.id)
    if (g?.group_members?.[0]) g.group_members[0].count = (g.group_members[0].count || 0) + 1
  }
}

// ── CREATE ────────────────────────────────────────────────────
async function createGroup() {
  if (!newGroupName.value.trim() || !currentUser.value) return
  creating.value = true
  let bannerUrl = null
  if (newGroupBanner.value) {
    const fn = `group-banners/${currentUser.value.id}_${Date.now()}`
    const { error: upErr } = await supabase.storage.from('media').upload(fn, newGroupBanner.value)
    if (!upErr) {
      const { data: { publicUrl } } = supabase.storage.from('media').getPublicUrl(fn)
      bannerUrl = publicUrl
    }
  }
  const { data, error } = await supabase.from('groups').insert({
    name: newGroupName.value.trim(),
    description: newGroupDesc.value.trim() || null,
    banner_url: bannerUrl,
    created_by: currentUser.value.id,
    is_private: newGroupIsPrivate.value,
    created_at: new Date().toISOString(),
  }).select().single()

  if (!error && data) {
    await supabase.from('group_members')
      .insert({ group_id: data.id, user_id: currentUser.value.id, role: 'admin' })
    memberIds.value.add(data.id)
    newGroupName.value = ''; newGroupDesc.value = ''
    newGroupIsPrivate.value = false; newGroupBanner.value = null; newGroupBannerUrl.value = null
    showCreate.value = false; creating.value = false
    const fresh = { ...data, group_members: [{ count: 1 }] }
    groups.value.unshift(fresh)
    openGroup(fresh)
  } else if (error) {
    alert('Could not create group: ' + error.message)
    creating.value = false
  }
}

const handleBannerFile = (e) => {
  const f = e.target.files[0]; if (!f) return
  newGroupBanner.value = f; newGroupBannerUrl.value = URL.createObjectURL(f)
}

// ── INVITE ────────────────────────────────────────────────────
async function searchInvite() {
  if (!inviteSearch.value.trim()) { inviteResults.value = []; return }
  inviteLoading.value = true
  const { data } = await supabase.from('profiles')
    .select('id, username, avatar_url')
    .ilike('username', `%${inviteSearch.value}%`)
    .limit(8)
  const memberUserIds = new Set(groupMembers.value.map(m => m.user_id))
  inviteResults.value = (data || []).filter(u => !memberUserIds.has(u.id) && u.id !== currentUser.value?.id)
  inviteLoading.value = false
}

async function inviteUser(user) {
  if (inviting.value.has(user.id)) return
  inviting.value.add(user.id)
  const { error } = await supabase.from('group_members')
    .insert({ group_id: activeGroup.value.id, user_id: user.id, role: 'member' })
  if (!error) {
    inviteResults.value = inviteResults.value.filter(u => u.id !== user.id)
    groupMembers.value.push({ user_id: user.id, role: 'member', joined_at: new Date().toISOString(), profiles: user })
    const g = groups.value.find(g => g.id === activeGroup.value.id)
    if (g?.group_members?.[0]) g.group_members[0].count = (g.group_members[0].count || 0) + 1
  } else { alert('Erreur : ' + error.message) }
  inviting.value.delete(user.id)
}

// ── UTILS ─────────────────────────────────────────────────────
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
function fmtDate(ts) {
  const d = new Date(ts), now = new Date()
  if (d.toDateString() === now.toDateString()) return "Aujourd'hui"
  const y = new Date(now); y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return 'Hier'
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
}
function groupedMessages_raw() {
  const out = []; let lastDay = null
  for (const msg of chatMessages.value) {
    const day = new Date(msg.created_at).toDateString()
    if (day !== lastDay) { out.push({ type: 'sep', label: fmtDate(msg.created_at) }); lastDay = day }
    out.push({ type: 'msg', ...msg })
  }
  return out
}
const groupedMsgsComputed = computed(() => groupedMessages_raw())


// ── HIDE/SHOW GROUPS ──────────────────────────────────────────
function toggleHideGroup(e, group) {
  e.stopPropagation()
  if (hiddenGroups.value.has(group.id)) {
    hiddenGroups.value.delete(group.id)
  } else {
    hiddenGroups.value.add(group.id)
    if (activeGroup.value?.id === group.id) {
      activeGroup.value = null
      chatSub?.unsubscribe()
    }
  }
  // Persist in localStorage
  localStorage.setItem('onb_hidden_groups', JSON.stringify([...hiddenGroups.value]))
}

function loadHiddenGroups() {
  try {
    const stored = localStorage.getItem('onb_hidden_groups')
    if (stored) hiddenGroups.value = new Set(JSON.parse(stored))
  } catch {}
}

// Admin: delete group entirely
async function adminDeleteGroup(group) {
  if (!isAdminUser.value) return
  if (!confirm(`Permanently delete the group "${group.name}" ?`)) return
  const { error } = await supabase.from('groups').delete().eq('id', group.id)
  if (!error) {
    groups.value = groups.value.filter(g => g.id !== group.id)
    if (activeGroup.value?.id === group.id) activeGroup.value = null
  } else {
    alert('Error: ' + error.message)
  }
}

// Toggle group visibility (admin: hide from all, or just hide locally)
const showHiddenGroups = ref(false)
// Computed to force reactivity on Set changes
const hiddenGroupsSize = computed(() => hiddenGroups.value.size)
const isGroupHidden = (id) => hiddenGroups.value.has(id)

const filteredVisible = computed(() => {
  const q = searchQ.value.toLowerCase()
  return groups.value.filter(g => {
    if (!showHiddenGroups.value && hiddenGroups.value.has(g.id)) return false
    if (!q) return true
    return g.name?.toLowerCase().includes(q) || g.description?.toLowerCase().includes(q)
  })
})

onMounted(() => { loadHiddenGroups(); load() })
onUnmounted(() => chatSub?.unsubscribe())
</script>

<template>
  <div class="gp-page">
    <div class="gp-layout">

      <!-- ═══ SIDEBAR ═══ -->
      <aside class="gp-sidebar">
        <div class="sb-top">
          <span class="sb-title">Groups</span>
          <div class="sb-top-btns">
            <button
              v-if="hiddenGroupsSize > 0"
              class="icon-btn"
              :class="showHiddenGroups ? 'purple' : 'ghost'"
              @click="showHiddenGroups = !showHiddenGroups"
              :title="showHiddenGroups ? 'Hide hidden groups' : `Show ${hiddenGroupsSize} hidden group(s)`"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
            <button class="icon-btn purple" @click="showCreate = !showCreate" title="Create a group">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
          </div>
        </div>

        <div class="sb-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input v-model="searchQ" placeholder="Search…" />
        </div>

        <!-- Create form -->
        <transition name="slide">
          <div v-if="showCreate" class="create-form">
            <label class="cf-banner-label">
              <input type="file" accept="image/*" @change="handleBannerFile" hidden />
              <div v-if="newGroupBannerUrl" class="cf-banner-img">
                <img :src="newGroupBannerUrl" />
                <div class="cf-banner-over">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                  Changer
                </div>
              </div>
              <div v-else class="cf-banner-placeholder">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                <span>Bannière (optionnel)</span>
              </div>
            </label>
            <input v-model="newGroupName" placeholder="Nom du groupe *" class="cf-field" />
            <textarea v-model="newGroupDesc" placeholder="Description…" rows="2" class="cf-field cf-ta"></textarea>
            <label class="cf-toggle">
              <input type="checkbox" v-model="newGroupIsPrivate" />
              <span class="cf-track" :class="{ on: newGroupIsPrivate }"><span class="cf-thumb"></span></span>
              <span class="cf-toggle-label">
                <svg v-if="newGroupIsPrivate" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 1 1 10 0"/></svg>
                {{ newGroupIsPrivate ? 'Private' : 'Public' }}
              </span>
            </label>
            <div class="cf-actions">
              <button class="btn-ghost-sm" @click="showCreate = false">Cancel</button>
              <button class="btn-purple-sm" @click="createGroup" :disabled="!newGroupName.trim() || creating">
                <span v-if="creating" class="mini-spin"></span>
                Create
              </button>
            </div>
          </div>
        </transition>

        <!-- List -->
        <div v-if="loading" class="sb-state"><div class="spinner"></div></div>
        <div v-else-if="filteredVisible.length === 0" class="sb-state muted">No groups</div>
        <div v-else class="group-list">
          <div
            v-for="g in filteredVisible" :key="g.id"
            class="group-row"
            :class="{ active: activeGroup?.id === g.id }"
            @click="openGroup(g)"
          >
            <div class="gr-avatar" :style="g.banner_url ? { backgroundImage: `url(${g.banner_url})` } : {}">
              <span v-if="!g.banner_url">{{ g.name?.charAt(0)?.toUpperCase() }}</span>
            </div>
            <div class="gr-info">
              <div class="gr-name-row">
                <span class="gr-name">{{ g.name }}</span>
                <span v-if="g.is_private" class="gr-lock-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                </span>
              </div>
              <span class="gr-meta">{{ g.group_members?.[0]?.count || 0 }} members</span>
            </div>
            <button
              class="gr-join-btn"
              :class="{ joined: memberIds.has(g.id) }"
              @click.stop="toggleMembership(g)"
              :title="memberIds.has(g.id) ? 'Leave' : 'Join'"
            >
              <svg v-if="memberIds.has(g.id)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <button
              class="gr-hide-btn"
              @click.stop="toggleHideGroup($event, g)"
              :title="isGroupHidden(g.id) ? 'Show' : 'Hide'"
            >
              <svg v-if="isGroupHidden(g.id)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            </button>
            <button
              v-if="isAdminUser"
              class="gr-admin-del-btn"
              @click.stop="adminDeleteGroup(g)"
              title="Delete (admin)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M9 6V4h6v2"/></svg>
            </button>
          </div>
        </div>
      </aside>

      <!-- ═══ MAIN ═══ -->
      <main class="gp-main">

        <!-- Empty state -->
        <div v-if="!activeGroup" class="gp-empty-state">
          <div class="es-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          </div>
          <p class="es-title">Sélectionnez un groupe</p>
          <p class="es-sub">Join or create a group to start chatting</p>
        </div>

        <template v-else>
          <!-- Banner -->
          <div class="group-banner" :style="activeGroup.banner_url ? { backgroundImage: `url(${activeGroup.banner_url})` } : {}">
            <div class="gb-grad"></div>
            <div class="gb-info">
              <div class="gb-badges">
                <span class="gb-badge" :class="activeGroup.is_private ? 'private' : 'public'">
                  <svg v-if="activeGroup.is_private" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                  <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                  {{ activeGroup.is_private ? 'Private' : 'Public' }}
                </span>
                <span v-if="isOwner" class="gb-badge owner">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg>
                  Owner
                </span>
              </div>
              <h1 class="gb-name">{{ activeGroup.name }}</h1>
              <p v-if="activeGroup.description" class="gb-desc">{{ activeGroup.description }}</p>
            </div>
            <div class="gb-actions">
              <button
                v-if="(activeGroup.is_private && (isMember || isOwner)) || isOwner"
                class="gb-btn outline"
                @click="showInvite = true; loadMembers()"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
                Invite
              </button>
              <button
                class="gb-btn"
                :class="{ joined: isMember }"
                @click="toggleMembership(activeGroup)"
                :disabled="isOwner"
                :title="isOwner ? 'Vous êtes propriétaire' : ''"
              >
                <svg v-if="isMember" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
                <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                {{ isOwner ? 'Owner' : isMember ? 'Joined' : 'Join' }}
              </button>
            </div>
          </div>

          <!-- Tabs -->
          <div class="group-tabs">
            <button class="gtab" :class="{ active: activeTab === 'chat' }" @click="activeTab = 'chat'">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              Chat
            </button>
            <button class="gtab" :class="{ active: activeTab === 'members' }" @click="activeTab = 'members'; loadMembers()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              Members
              <span class="gtab-count">{{ activeGroup.group_members?.[0]?.count || 0 }}</span>
            </button>
          </div>

          <!-- ── CHAT ── -->
          <div v-show="activeTab === 'chat'" class="chat-panel">
            <div class="chat-msgs" ref="chatMsgsArea">
              <div v-if="loadingChat" class="panel-state"><div class="spinner"></div></div>
              <template v-else>
                <div v-if="chatMessages.length === 0" class="panel-state muted">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="width:40px;height:40px;opacity:.25"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                  <span>Pas encore de messages</span>
                </div>
                <template v-else v-for="item in groupedMsgsComputed" :key="item.id || item.label">
                  <div v-if="item.type === 'sep'" class="day-sep"><span>{{ item.label }}</span></div>
                  <div v-else class="chat-msg" :class="{ mine: item.sender_id === currentUser?.id }">
                    <div v-if="item.sender_id !== currentUser?.id" class="msg-av">
                      <img v-if="item.profiles?.avatar_url" :src="item.profiles.avatar_url" loading="lazy" />
                      <span v-else>{{ item.profiles?.username?.charAt(0)?.toUpperCase() }}</span>
                    </div>
                    <div class="msg-col">
                      <span v-if="item.sender_id !== currentUser?.id" class="msg-author" :style="item.profiles?.username_color ? { color: item.profiles.username_color } : {}" @click="goToProfile(item.sender_id)" style="cursor:pointer">
                        @{{ item.profiles?.username }}
                      </span>
                      <div class="msg-bubble">{{ item.content }}</div>
                      <span class="msg-time">{{ fmtTime(item.created_at) }}</span>
                    </div>
                  </div>
                </template>
                <div ref="chatEnd"></div>
              </template>
            </div>

            <div class="chat-input-area">
              <template v-if="isMember">
                <input
                  v-model="newChatMsg"
                  placeholder="Write a message…"
                  class="chat-input"
                  @keyup.enter="sendChatMessage"
                  :disabled="sendingChat"
                />
                <button class="chat-send-btn" @click="sendChatMessage" :disabled="!newChatMsg.trim() || sendingChat">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                </button>
              </template>
              <div v-else-if="activeGroup.is_private" class="join-cta join-cta-locked">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                Private group — invitation required to participate
              </div>
              <div v-else class="join-cta" @click="toggleMembership(activeGroup)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                Rejoignez ce groupe pour participer au chat
              </div>
            </div>
          </div>

          <!-- ── MEMBERS ── -->
          <div v-show="activeTab === 'members'" class="members-panel">
            <div class="members-header">
              <span class="members-title">{{ groupMembers.length }} members</span>
              <button v-if="isOwner || isMember" class="btn-purple-sm" @click="showInvite = true; loadMembers()">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Invite
              </button>
            </div>
            <div v-if="loadingMembers" class="panel-state"><div class="spinner"></div></div>
            <div v-else class="members-list">
              <div v-for="m in groupMembers" :key="m.user_id" class="member-card">
                <div class="mc-av">
                  <img v-if="m.profiles?.avatar_url" :src="m.profiles.avatar_url" loading="lazy" />
                  <span v-else>{{ m.profiles?.username?.charAt(0)?.toUpperCase() }}</span>
                </div>
                <span class="mc-name" :style="m.profiles?.username_color ? { color: m.profiles.username_color } : {}" @click="goToProfile(m.user_id)" style="cursor:pointer">
                  @{{ m.profiles?.username }}
                </span>
                <span v-if="m.user_id === activeGroup.created_by" class="mc-role owner">
                  <svg viewBox="0 0 24 24" fill="currentColor" style="width:10px;height:10px"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg>
                  Owner
                </span>
                <span v-else-if="m.role === 'admin'" class="mc-role admin">Admin</span>
                <button
                  v-if="isOwner && m.user_id !== currentUser?.id"
                  class="mc-kick"
                  @click="kickMember(m)"
                  title="Remove"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h4a3 3 0 0 1 3 3v1"/></svg>
                </button>
              </div>
            </div>
          </div>

        </template>
      </main>
    </div>

    <!-- ═══ INVITE MODAL ═══ -->
    <Teleport to="body">
      <div v-if="showInvite" class="modal-backdrop" @click.self="showInvite = false">
        <div class="modal">
          <div class="modal-head">
            <span class="modal-title">Invite members</span>
            <button class="modal-close-btn" @click="showInvite = false">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="modal-body">
            <div class="invite-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input v-model="inviteSearch" @input="searchInvite" placeholder="Search by username…" class="invite-input" autofocus />
            </div>
            <div v-if="inviteLoading" class="panel-state" style="padding:16px"><div class="spinner small"></div></div>
            <div v-else-if="inviteResults.length" class="invite-list">
              <div v-for="u in inviteResults" :key="u.id" class="invite-row">
                <div class="ir-av">
                  <img v-if="u.avatar_url" :src="u.avatar_url" loading="lazy" />
                  <span v-else>{{ u.username?.charAt(0)?.toUpperCase() }}</span>
                </div>
                <span class="ir-name">@{{ u.username }}</span>
                <button class="btn-purple-sm" @click="inviteUser(u)" :disabled="inviting.has(u.id)">
                  <span v-if="inviting.has(u.id)" class="mini-spin"></span>
                  <span v-else>Invite</span>
                </button>
              </div>
            </div>
            <p v-else-if="inviteSearch && !inviteLoading" class="muted-text">No results</p>

            <div class="current-members-section">
              <span class="section-label">Current members</span>
              <div class="invite-list">
                <div v-for="m in groupMembers" :key="m.user_id" class="invite-row">
                  <div class="ir-av sm">
                    <img v-if="m.profiles?.avatar_url" :src="m.profiles.avatar_url" loading="lazy" />
                    <span v-else>{{ m.profiles?.username?.charAt(0)?.toUpperCase() }}</span>
                  </div>
                  <span class="ir-name">@{{ m.profiles?.username }}</span>
                  <span class="mc-role" :class="m.user_id === activeGroup.created_by ? 'owner' : m.role">
                    {{ m.user_id === activeGroup.created_by ? 'Owner' : m.role === 'admin' ? 'Admin' : 'Member' }}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* ── SHELL ── */
.gp-page { height: 100%; overflow: hidden; display: flex; flex-direction: column; }
.gp-layout { display: flex; flex: 1; min-height: 0; overflow: hidden; }

/* ── SIDEBAR ── */
.gp-sidebar { width: 280px; flex-shrink: 0; background: #fff; border-right: 1px solid #ede8ff; display: flex; flex-direction: column; overflow: hidden; }
.sb-top { display: flex; align-items: center; justify-content: space-between; padding: 16px 16px 12px; border-bottom: 1px solid #f0ecff; flex-shrink: 0; }
.sb-title { font-family: 'Epilogue', sans-serif; font-size: 1rem; font-weight: 800; color: var(--text); }
.sb-search { display: flex; align-items: center; gap: 8px; padding: 9px 13px; border-bottom: 1px solid #f0ecff; flex-shrink: 0; }
.sb-search svg { width: 14px; height: 14px; color: var(--text-2); flex-shrink: 0; }
.sb-search input { border: none; outline: none; font-family: 'Instrument Sans', sans-serif; font-size: 0.83rem; width: 100%; color: var(--text); background: transparent; }
.sb-state { display: flex; justify-content: center; align-items: center; padding: 28px; }
.sb-state.muted { color: var(--text-2); font-size: 0.82rem; }

/* Create form */
.create-form { padding: 13px; border-bottom: 1px solid #ede8ff; display: flex; flex-direction: column; gap: 8px; background: #faf8ff; flex-shrink: 0; }
.cf-banner-label { cursor: pointer; display: block; }
.cf-banner-img { position: relative; height: 64px; border-radius: 9px; overflow: hidden; }
.cf-banner-img img { width: 100%; height: 100%; object-fit: cover; }
.cf-banner-over { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 5px; background: rgba(0,0,0,0.4); color: white; font-size: 0.75rem; font-weight: 600; }
.cf-banner-over svg { width: 14px; height: 14px; }
.cf-banner-placeholder { height: 64px; border: 2px dashed #d8d0f5; border-radius: 9px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; color: var(--text-2); font-size: 0.73rem; cursor: pointer; transition: border-color .18s; }
.cf-banner-placeholder:hover { border-color: var(--purple); }
.cf-banner-placeholder svg { width: 18px; height: 18px; }
.cf-field { padding: 7px 10px; border: 1.5px solid #e2d9ff; border-radius: 7px; font-family: 'Instrument Sans', sans-serif; font-size: 0.83rem; outline: none; background: white; color: var(--text); transition: border-color .18s; }
.cf-field:focus { border-color: var(--purple); }
.cf-ta { resize: none; }
.cf-toggle { display: flex; align-items: center; gap: 9px; cursor: pointer; user-select: none; }
.cf-toggle input { display: none; }
.cf-track { width: 32px; height: 18px; border-radius: 9px; background: #d8d0f5; position: relative; transition: background .2s; flex-shrink: 0; }
.cf-track.on { background: var(--purple); }
.cf-thumb { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: white; transition: transform .2s; box-shadow: 0 1px 3px rgba(0,0,0,0.2); }
.cf-track.on .cf-thumb { transform: translateX(14px); }
.cf-toggle-label { display: flex; align-items: center; gap: 5px; font-size: 0.8rem; font-weight: 600; color: var(--text-2); }
.cf-toggle-label svg { width: 13px; height: 13px; }
.cf-actions { display: flex; gap: 7px; justify-content: flex-end; }

/* Slide transition */
.slide-enter-active, .slide-leave-active { transition: all .2s ease; overflow: hidden; }
.slide-enter-from, .slide-leave-to { opacity: 0; max-height: 0; padding-top: 0; padding-bottom: 0; }
.slide-enter-to, .slide-leave-from { opacity: 1; max-height: 500px; }

/* Group list */
.group-list { flex: 1; overflow-y: auto; }
.group-row { display: flex; align-items: center; gap: 10px; padding: 10px 13px; cursor: pointer; border-bottom: 1px solid #f5f3ff; transition: background .13s; }
.group-row:hover { background: #f7f4ff; }
.group-row.active { background: #eee8ff; }
.gr-avatar { width: 40px; height: 40px; border-radius: 10px; background: var(--purple); display: flex; align-items: center; justify-content: center; font-weight: 800; color: white; font-size: 1rem; flex-shrink: 0; background-size: cover; background-position: center; }
.gr-info { flex: 1; overflow: hidden; display: flex; flex-direction: column; gap: 1px; }
.gr-name-row { display: flex; align-items: center; gap: 5px; }
.gr-name { font-weight: 700; font-size: 0.86rem; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gr-lock-icon { width: 12px; height: 12px; color: var(--text-2); flex-shrink: 0; }
.gr-lock-icon svg { width: 12px; height: 12px; }
.gr-meta { font-size: 0.71rem; color: var(--text-2); }
.gr-join-btn { width: 26px; height: 26px; border-radius: 50%; border: none; cursor: pointer; flex-shrink: 0; display: flex; align-items: center; justify-content: center; transition: all .15s; background: var(--purple); color: white; }
.gr-join-btn svg { width: 12px; height: 12px; }
.gr-join-btn.joined { background: #e0d9ff; color: var(--purple); }

/* ── MAIN ── */
.gp-main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }

.gp-empty-state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; }
.es-icon { width: 68px; height: 68px; background: #f0eeff; border-radius: 18px; display: flex; align-items: center; justify-content: center; }
.es-icon svg { width: 36px; height: 36px; color: var(--purple); opacity: 0.4; }
.es-title { font-family: 'Epilogue', sans-serif; font-weight: 800; font-size: 1.05rem; color: var(--text); }
.es-sub { font-size: 0.82rem; color: var(--text-2); text-align: center; max-width: 260px; }

/* Banner */
.group-banner { position: relative; height: 154px; background: linear-gradient(135deg, #4C10E0, #7c3aed); background-size: cover; background-position: center; display: flex; align-items: flex-end; flex-shrink: 0; }
.gb-grad { position: absolute; inset: 0; background: linear-gradient(to top, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.1) 100%); }
.gb-info { position: relative; z-index: 1; padding: 14px 22px; flex: 1; }
.gb-badges { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
.gb-badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: 20px; font-size: 0.7rem; font-weight: 700; }
.gb-badge svg { width: 11px; height: 11px; }
.gb-badge.private { background: rgba(0,0,0,0.35); color: rgba(255,255,255,0.9); border: 1px solid rgba(255,255,255,0.2); }
.gb-badge.public { background: rgba(34,197,94,0.3); color: #86efac; border: 1px solid rgba(134,239,172,0.3); }
.gb-badge.owner { background: rgba(251,191,36,0.3); color: #fde68a; border: 1px solid rgba(253,230,138,0.3); }
.gb-name { font-family: 'Epilogue', sans-serif; font-size: 1.4rem; font-weight: 800; color: white; line-height: 1.2; }
.gb-desc { color: rgba(255,255,255,0.7); font-size: 0.8rem; margin-top: 3px; }
.gb-actions { position: relative; z-index: 1; display: flex; gap: 8px; padding: 12px 18px; align-self: flex-end; flex-shrink: 0; }
.gb-btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 16px; border-radius: 20px; border: none; font-family: 'Instrument Sans', sans-serif; font-weight: 700; font-size: 0.82rem; cursor: pointer; transition: all .18s; white-space: nowrap; }
.gb-btn svg { width: 14px; height: 14px; }
.gb-btn { background: white; color: var(--purple); }
.gb-btn:hover { opacity: 0.9; }
.gb-btn.joined { background: rgba(255,255,255,0.2); color: white; border: 1.5px solid rgba(255,255,255,0.5); }
.gb-btn:disabled { opacity: 0.5; cursor: default; }
.gb-btn.outline { background: rgba(255,255,255,0.15); color: white; border: 1.5px solid rgba(255,255,255,0.4); }
.gb-btn.outline:hover { background: rgba(255,255,255,0.25); }

/* Tabs */
.group-tabs { display: flex; border-bottom: 1px solid #ede8ff; background: white; flex-shrink: 0; padding: 0 18px; }
.gtab { display: flex; align-items: center; gap: 6px; padding: 11px 14px; border: none; background: none; font-family: 'Instrument Sans', sans-serif; font-size: 0.84rem; font-weight: 600; color: var(--text-2); cursor: pointer; border-bottom: 2px solid transparent; transition: all .18s; margin-bottom: -1px; }
.gtab svg { width: 15px; height: 15px; }
.gtab:hover { color: var(--purple); }
.gtab.active { color: var(--purple); border-bottom-color: var(--purple); }
.gtab-count { background: #f0eeff; color: var(--purple); font-size: 0.68rem; font-weight: 800; padding: 1px 6px; border-radius: 10px; }

/* ── CHAT PANEL ── */
.chat-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
.chat-msgs { flex: 1; overflow-y: auto; padding: 16px 22px; display: flex; flex-direction: column; gap: 6px; }
.panel-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 40px; color: var(--text-2); font-size: 0.83rem; }
.panel-state.muted { flex: 1; }
.day-sep { display: flex; align-items: center; gap: 10px; margin: 10px 0 4px; font-size: 0.7rem; font-weight: 700; color: var(--text-2); }
.day-sep::before, .day-sep::after { content: ''; flex: 1; height: 1px; background: #e8e0ff; }
.chat-msg { display: flex; align-items: flex-end; gap: 8px; }
.chat-msg.mine { flex-direction: row-reverse; }
.msg-av { width: 28px; height: 28px; border-radius: 50%; background: var(--purple); color: white; font-size: 0.72rem; font-weight: 700; display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0; }
.msg-av img { width: 100%; height: 100%; object-fit: cover; }
.msg-col { display: flex; flex-direction: column; gap: 2px; max-width: 65%; }
.mine .msg-col { align-items: flex-end; }
.msg-author { font-size: 0.69rem; font-weight: 700; color: var(--purple); padding: 0 4px; }
.msg-bubble { padding: 8px 12px; border-radius: 16px; font-size: 0.86rem; line-height: 1.4; word-break: break-word; }
.chat-msg:not(.mine) .msg-bubble { background: white; color: var(--text); box-shadow: 0 1px 4px rgba(76,16,224,0.09); border-bottom-left-radius: 3px; }
.chat-msg.mine .msg-bubble { background: var(--purple); color: white; border-bottom-right-radius: 3px; }
.msg-time { font-size: 0.64rem; color: var(--text-2); padding: 0 4px; }
.chat-input-area { display: flex; align-items: center; gap: 10px; padding: 11px 18px; background: white; border-top: 1px solid #ede8ff; flex-shrink: 0; }
.chat-input { flex: 1; padding: 10px 15px; border: 1.5px solid #e2d9ff; border-radius: 22px; font-family: 'Instrument Sans', sans-serif; font-size: 0.87rem; outline: none; transition: border-color .18s; }
.chat-input:focus { border-color: var(--purple); }
.chat-send-btn { width: 38px; height: 38px; border-radius: 50%; background: var(--purple); border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; transition: all .18s; }
.chat-send-btn svg { width: 14px; height: 14px; color: white; }
.chat-send-btn:hover:not(:disabled) { background: var(--purple-d); transform: scale(1.06); }
.chat-send-btn:disabled { opacity: 0.35; cursor: not-allowed; transform: none; }
.join-cta { flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 11px; background: #f0eeff; border-radius: 12px; color: var(--purple); font-weight: 600; font-size: 0.84rem; cursor: pointer; transition: background .18s; }
.join-cta:hover { background: #e5daff; }
.join-cta svg { width: 15px; height: 15px; flex-shrink: 0; }
.join-cta-locked { cursor: default; background: #f5f3ff; color: var(--text-2); opacity: 0.85; }
.join-cta-locked:hover { background: #f5f3ff; }

/* ── MEMBERS PANEL ── */
.members-panel { flex: 1; overflow-y: auto; padding: 20px 22px; }
.members-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.members-title { font-size: 0.78rem; font-weight: 700; color: var(--text-2); text-transform: uppercase; letter-spacing: .05em; }
.members-list { display: flex; flex-direction: column; gap: 6px; }
.member-card { display: flex; align-items: center; gap: 10px; padding: 10px 13px; background: white; border-radius: 12px; box-shadow: 0 1px 5px rgba(76,16,224,0.07); }
.mc-av { width: 34px; height: 34px; border-radius: 50%; background: var(--purple); color: white; font-size: 0.84rem; font-weight: 700; display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0; }
.mc-av img { width: 100%; height: 100%; object-fit: cover; }
.mc-name { flex: 1; font-weight: 600; font-size: 0.85rem; color: var(--text); }
.mc-role { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 20px; font-size: 0.68rem; font-weight: 700; flex-shrink: 0; }
.mc-role.owner { background: linear-gradient(135deg,#fbbf24,#f97316); color: white; }
.mc-role.admin { background: #f0eeff; color: var(--purple); }
.mc-role.member { background: #f5f5f5; color: var(--text-2); }
.mc-kick { width: 28px; height: 28px; border-radius: 8px; background: #fff0f0; border: none; color: #e74c3c; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all .15s; flex-shrink: 0; }
.mc-kick:hover { background: #ffd5d5; }
.mc-kick svg { width: 14px; height: 14px; }

/* ── MODAL ── */
.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.42); z-index: 600; display: flex; align-items: center; justify-content: center; padding: 20px; backdrop-filter: blur(4px); }
.modal { background: white; border-radius: 20px; width: 100%; max-width: 440px; max-height: 78vh; display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0,0,0,0.2); overflow: hidden; }
.modal-head { display: flex; align-items: center; justify-content: space-between; padding: 17px 20px; border-bottom: 1px solid #f0ecff; flex-shrink: 0; }
.modal-title { font-family: 'Epilogue', sans-serif; font-size: 0.98rem; font-weight: 800; color: var(--text); }
.modal-close-btn { width: 28px; height: 28px; border-radius: 50%; background: #f0eeff; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--text-2); }
.modal-close-btn svg { width: 13px; height: 13px; }
.modal-body { flex: 1; overflow-y: auto; padding: 17px 20px; display: flex; flex-direction: column; gap: 13px; }
.invite-search { display: flex; align-items: center; gap: 9px; padding: 9px 12px; border: 1.5px solid #e2d9ff; border-radius: 11px; }
.invite-search svg { width: 14px; height: 14px; color: var(--text-2); flex-shrink: 0; }
.invite-input { border: none; outline: none; font-family: 'Instrument Sans', sans-serif; font-size: 0.85rem; flex: 1; color: var(--text); }
.invite-list { display: flex; flex-direction: column; gap: 6px; }
.invite-row { display: flex; align-items: center; gap: 10px; padding: 6px 2px; }
.ir-av { width: 32px; height: 32px; border-radius: 50%; background: var(--purple); color: white; font-size: 0.8rem; font-weight: 700; display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0; }
.ir-av.sm { width: 26px; height: 26px; font-size: 0.72rem; }
.ir-av img { width: 100%; height: 100%; object-fit: cover; }
.ir-name { flex: 1; font-weight: 600; font-size: 0.84rem; color: var(--text); }
.current-members-section { display: flex; flex-direction: column; gap: 10px; border-top: 1px solid #f0ecff; padding-top: 13px; margin-top: 4px; }
.section-label { font-size: 0.72rem; font-weight: 700; color: var(--text-2); text-transform: uppercase; letter-spacing: .05em; }
.muted-text { font-size: 0.82rem; color: var(--text-2); text-align: center; padding: 8px 0; }

/* ── BUTTONS ── */
.icon-btn { width: 30px; height: 30px; border-radius: 50%; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background .18s; }
.icon-btn.purple { background: var(--purple); color: white; }
.icon-btn.purple:hover { background: var(--purple-d); }
.icon-btn svg { width: 14px; height: 14px; }
.btn-ghost-sm { padding: 6px 12px; border: 1.5px solid #e2d9ff; border-radius: 7px; background: none; font-size: 0.79rem; cursor: pointer; color: var(--text-2); font-family: 'Instrument Sans', sans-serif; }
.btn-purple-sm { display: inline-flex; align-items: center; gap: 5px; padding: 6px 13px; background: var(--purple); color: white; border: none; border-radius: 7px; font-weight: 700; font-size: 0.79rem; cursor: pointer; transition: background .18s; font-family: 'Instrument Sans', sans-serif; }
.btn-purple-sm:hover { background: var(--purple-d); }
.btn-purple-sm:disabled { opacity: 0.45; cursor: not-allowed; }
.btn-purple-sm svg { width: 12px; height: 12px; }

/* ── SPINNERS ── */
.spinner { width: 26px; height: 26px; border: 3px solid #e2d9ff; border-top-color: var(--purple); border-radius: 50%; animation: spin .7s linear infinite; }
.spinner.small { width: 18px; height: 18px; border-width: 2px; }
@keyframes spin { to { transform: rotate(360deg); } }
.mini-spin { width: 11px; height: 11px; border: 2px solid rgba(76,16,224,0.3); border-top-color: var(--purple); border-radius: 50%; animation: spin .6s linear infinite; display: inline-block; }

@media (max-width: 680px) {
  .gp-sidebar { width: 64px; }
  .sb-top span, .sb-search, .gr-info, .create-form { display: none; }
  .group-row { justify-content: center; padding: 10px 0; }
  .gr-join-btn { display: none; }
}

/* ── HIDE/SHOW BUTTONS ── */
.sb-top-btns { display:flex; align-items:center; gap:4px; }
.icon-btn.ghost { background:#f0eeff; color:var(--text-2); }
.icon-btn.ghost:hover { background:#e2d9ff; color:var(--purple); }
.group-row-hidden { opacity:0.45; }
.group-row-hidden:hover { opacity:0.75; }
.gr-hide-btn { width:22px; height:22px; border-radius:6px; border:none; background:transparent; color:var(--text-2); cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0; transition:all .15s; opacity:0; }
.group-row:hover .gr-hide-btn { opacity:1; }
.gr-hide-btn:hover { background:#f0eeff; color:var(--purple); }
.gr-hide-btn svg { width:11px; height:11px; }
.gr-admin-del-btn { width:22px; height:22px; border-radius:6px; border:none; background:transparent; color:#e74c3c; cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0; transition:all .15s; opacity:0; }
.group-row:hover .gr-admin-del-btn { opacity:1; }
.gr-admin-del-btn:hover { background:#fff0f0; }
.gr-admin-del-btn svg { width:11px; height:11px; }

</style>
