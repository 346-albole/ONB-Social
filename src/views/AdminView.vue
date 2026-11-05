<script setup>
import { ref, onMounted, computed } from 'vue'
import { supabase } from '../lib/supabaseClient'
import { getCurrentSession } from '../lib/authStore'
import { withTimeout, makeSafeLoader } from '../lib/withTimeout'
import { useRouter } from 'vue-router'

const router = useRouter()
const currentUser = ref(null)
const isAdmin = ref(false)
const loading = ref(true)
const activeTab = ref('dashboard')

// Stats
const stats = ref({ users: 0, posts: 0, comments: 0, messages: 0, groups: 0, globalMsgs: 0 })

// Users
const users = ref([])
const loadingUsers = ref(false)
const userSearch = ref('')
const userError = ref('')
const editingUser = ref(null)
const editUserBio = ref('')

// Posts
const posts = ref([])
const loadingPosts = ref(false)

// Reels
const adminReels = ref([])
const loadingAdminReels = ref(false)

// Groups
const groups = ref([])
const loadingGroups = ref(false)

// Global chat messages
const globalMsgs = ref([])
const loadingGlobalMsgs = ref(false)

// DMs
const dms = ref([])
const loadingDms = ref(false)

// Comments
const comments = ref([])
const loadingComments = ref(false)

// Announcements
const announcements = ref([])
const newAnnouncement = ref('')
const announcementType = ref('info')
const sendingAnnouncement = ref(false)

// Broadcasts
const broadcasts = ref([])
const newBroadcastTitle = ref('')
const newBroadcastHtml = ref('')
const newBroadcastJs = ref('')
const broadcastType = ref('banner')
const sendingBroadcast = ref(false)
const bcSubTab = ref('announcements')

// SQL runner
const sqlQuery = ref('')
const sqlResult = ref(null)
const sqlError = ref('')
const runningSql = ref(false)

const filteredUsers = computed(() => {
  const q = userSearch.value.toLowerCase()
  if (!q) return users.value
  return users.value.filter(u =>
    u.username?.toLowerCase().includes(q) ||
    u.id?.toLowerCase().includes(q)
  )
})

async function checkAdmin() {
  const _safeLoad = makeSafeLoader(loading)
  await _safeLoad(async () => {
    const session = getCurrentSession()
    if (!session?.user) { router.push('/auth'); return }
    currentUser.value = session.user
    const { data: profile } = await withTimeout(
      supabase.from('profiles').select('is_admin, username').eq('id', session.user.id).maybeSingle(),
      8000
    )
    if (!profile?.is_admin) { router.push('/'); return }
    isAdmin.value = true
    await loadDashboard()
  })
}

async function loadDashboard() {
  try {
    const [u, p, c, m, g, gm] = await Promise.all([
      withTimeout(supabase.from('profiles').select('*', { count: 'exact', head: true }), 8000),
      withTimeout(supabase.from('posts').select('*', { count: 'exact', head: true }), 8000),
      withTimeout(supabase.from('comments').select('*', { count: 'exact', head: true }), 8000),
      withTimeout(supabase.from('messages').select('*', { count: 'exact', head: true }), 8000),
      withTimeout(supabase.from('groups').select('*', { count: 'exact', head: true }), 8000),
      withTimeout(supabase.from('global_messages').select('*', { count: 'exact', head: true }), 8000),
    ])
    stats.value = {
      users: u?.count||0, posts: p?.count||0,
      comments: c?.count||0, messages: m?.count||0,
      groups: g?.count||0, globalMsgs: gm?.count||0
    }
  } catch (e) {
    console.warn('loadDashboard error:', e)
  }
}

async function loadUsers() {
  loadingUsers.value = true; userError.value = ''
  try {
    const result = await withTimeout(
      supabase.from('profiles')
        .select('id, username, avatar_url, is_premium, is_official, is_admin, is_banned, bio, updated_at, username_color, banner_url, is_anonymous, is_invisible')
        .order('updated_at', { ascending: false, nullsFirst: false }),
      10000
    )
    users.value = result?.data || []
  } catch (e) { userError.value = e.message
  } finally { loadingUsers.value = false }
}

async function loadPosts() {
  loadingPosts.value = true
  try {
    const result = await withTimeout(
      supabase.from('posts').select('*, profiles(username, avatar_url)')
        .order('created_at', { ascending: false }).limit(100),
      10000
    )
    posts.value = (result?.data || []).filter(p => !p.media_url?.match(/\.(mp4|webm|mov|m4v)/i))
  } catch (e) { console.warn(e)
  } finally { loadingPosts.value = false }
}

async function loadAdminReels() {
  loadingAdminReels.value = true
  try {
    const { data } = await withTimeout(
      supabase.from('posts').select('*, profiles(username), likes(count), comments(count), views')
        .or('media_url.ilike.%.mp4,media_url.ilike.%.webm,media_url.ilike.%.mov,media_url.ilike.%.m4v')
        .order('created_at', { ascending: false }),
      10000
    )
    adminReels.value = data || []
  } catch (e) { console.warn(e)
  } finally { loadingAdminReels.value = false }
}

async function loadGroups() {
  loadingGroups.value = true
  try {
    const result = await withTimeout(
      supabase.from('groups').select('*, group_members(count)')
        .order('created_at', { ascending: false }),
      10000
    )
    groups.value = result?.data || []
  } catch (e) { console.warn(e)
  } finally { loadingGroups.value = false }
}

async function loadGlobalMsgs() {
  loadingGlobalMsgs.value = true
  try {
    const result = await withTimeout(
      supabase.from('global_messages').select('*, profiles(username, avatar_url)')
        .order('created_at', { ascending: false }).limit(100),
      10000
    )
    globalMsgs.value = result?.data || []
  } catch (e) { console.warn(e)
  } finally { loadingGlobalMsgs.value = false }
}

async function loadDms() {
  loadingDms.value = true
  try {
    const { data: msgs, error } = await withTimeout(
      supabase.from('messages')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100),
      10000
    )
    if (error) { console.warn('query error', error); dms.value = []; return }
    const dmsData = msgs || []

    const userIds = [...new Set(dmsData.flatMap(m => [m.sender_id, m.receiver_id]))]
    if (userIds.length > 0) {
      const { data: profiles } = await supabase.from('profiles').select('id, username, avatar_url').in('id', userIds)
      const pMap = {}
      if (profiles) profiles.forEach(p => pMap[p.id] = p)
      
      dms.value = dmsData.map(m => ({
        ...m,
        sender: pMap[m.sender_id] || { username: 'Unknown' },
        receiver: pMap[m.receiver_id] || { username: 'Unknown' }
      }))
    } else {
      dms.value = []
    }
  } catch (e) {
    console.warn('loadDms exception:', e)
  } finally {
    loadingDms.value = false
  }
}

async function loadComments() {
  loadingComments.value = true
  try {
    const { data } = await withTimeout(
      supabase.from('comments')
        .select('*, profiles(username, avatar_url)')
        .order('created_at', { ascending: false })
        .limit(100),
      10000
    )
    comments.value = data || []
  } catch (e) {
    console.warn(e)
  } finally {
    loadingComments.value = false
  }
}

async function loadAnnouncements() {
  const { data } = await supabase.from('announcements').select('*').order('created_at', { ascending: false })
  announcements.value = data || []
}

async function loadBroadcasts() {
  const { data } = await supabase.from('admin_broadcasts').select('*').order('created_at', { ascending: false })
  broadcasts.value = data || []
}

// ── USER MANAGEMENT ────────────────────────────────────────────
async function toggleField(user, field) {
  const newVal = !user[field]
  const { error } = await supabase.from('profiles').update({ [field]: newVal }).eq('id', user.id)
  if (!error) {
    user[field] = newVal
    if (field === 'is_admin' && user.id === currentUser.value.id && !newVal) {
      router.push('/')
    }
  } else {
    alert('Erreur: ' + error.message)
  }
}

function startEditUser(user) {
  editingUser.value = user.id
  editUserBio.value = user.bio || ''
}

async function saveEditUser(user) {
  const { error } = await supabase.from('profiles').update({ bio: editUserBio.value }).eq('id', user.id)
  if (!error) user.bio = editUserBio.value
  editingUser.value = null
}

async function deleteUser(user) {
  if (!confirm(`Delete @${user.username}? This action is irreversible.`)) return
  // Delete related data
  await supabase.from('posts').delete().eq('user_id', user.id)
  await supabase.from('comments').delete().eq('user_id', user.id)
  await supabase.from('likes').delete().eq('user_id', user.id)
  await supabase.from('group_members').delete().eq('user_id', user.id)
  await supabase.from('global_messages').delete().eq('sender_id', user.id)
  const { error } = await supabase.from('profiles').delete().eq('id', user.id)
  if (!error) {
    users.value = users.value.filter(u => u.id !== user.id)
    stats.value.users = Math.max(0, stats.value.users - 1)
  } else {
    alert('Erreur: ' + error.message)
  }
}

async function setUsernameColor(user, color) {
  await supabase.from('profiles').update({ username_color: color }).eq('id', user.id)
  user.username_color = color
}

async function forceReload(user) {
  if (!confirm(`Forcer l'actualisation de la page de @${user.username} à distance ?`)) return
  const { error } = await supabase.from('admin_commands').insert({ target_user_id: user.id, admin_id: currentUser.value.id, command: 'reload' })
  if (error) alert('Erreur: ' + error.message)
}

// ── POSTS & REELS MANAGEMENT ──────────────────────────────────────────
async function deletePost(post) {
  if (!confirm('Delete this post/reel?')) return
  await supabase.from('likes').delete().eq('post_id', post.id)
  await supabase.from('comments').delete().eq('post_id', post.id)
  const { error } = await supabase.from('posts').delete().eq('id', post.id)
  if (!error) {
    posts.value = posts.value.filter(p => p.id !== post.id)
    adminReels.value = adminReels.value.filter(p => p.id !== post.id)
    stats.value.posts = Math.max(0, stats.value.posts - 1)
  }
}

// ── GROUPS MANAGEMENT ─────────────────────────────────────────
async function deleteGroup(group) {
  if (!confirm(`Delete the group "${group.name}"?`)) return
  const { error } = await supabase.from('groups').delete().eq('id', group.id)
  if (!error) groups.value = groups.value.filter(g => g.id !== group.id)
  else alert('Erreur: ' + error.message)
}

async function toggleGroupPrivacy(group) {
  const newVal = !group.is_private
  const { error } = await supabase.from('groups').update({ is_private: newVal }).eq('id', group.id)
  if (!error) group.is_private = newVal
}

// ── GLOBAL CHAT MANAGEMENT ────────────────────────────────────
async function deleteGlobalMsg(msg) {
  await supabase.from('global_messages').delete().eq('id', msg.id)
  globalMsgs.value = globalMsgs.value.filter(m => m.id !== msg.id)
  stats.value.globalMsgs = Math.max(0, stats.value.globalMsgs - 1)
}

async function clearAllGlobalMsgs() {
  if (!confirm('Vider tout le chat global ? Irréversible.')) return
  await supabase.from('global_messages').delete().neq('id', 0)
  globalMsgs.value = []
  stats.value.globalMsgs = 0
}

// ── DM & COMMENTS ─────────────────────────────────────────────
async function deleteDm(dm) {
  if (!confirm('Supprimer ce DM définitivement ?')) return
  await supabase.from('messages').delete().eq('id', dm.id)
  dms.value = dms.value.filter(m => m.id !== dm.id)
  stats.value.messages = Math.max(0, stats.value.messages - 1)
}

async function deleteComment(comment) {
  if (!confirm('Supprimer ce commentaire définitivement ?')) return
  await supabase.from('comments').delete().eq('id', comment.id)
  comments.value = comments.value.filter(c => c.id !== comment.id)
  stats.value.comments = Math.max(0, stats.value.comments - 1)
}

// ── ANNOUNCEMENTS ─────────────────────────────────────────────
async function sendAnnouncement() {
  if (!newAnnouncement.value.trim()) return
  sendingAnnouncement.value = true
  try {
    const { data, error } = await supabase.from('announcements').insert({
      admin_id: currentUser.value.id,
      content: newAnnouncement.value.trim(),
      type: announcementType.value,
      active: true,
    }).select().single()
    if (!error && data) { announcements.value.unshift(data); newAnnouncement.value = '' }
  } catch (e) {
    console.warn('sendAnnouncement error:', e)
  } finally {
    sendingAnnouncement.value = false
  }
}

async function deleteAnnouncement(ann) {
  await supabase.from('announcements').delete().eq('id', ann.id)
  announcements.value = announcements.value.filter(a => a.id !== ann.id)
}

async function toggleAnnouncement(ann) {
  await supabase.from('announcements').update({ active: !ann.active }).eq('id', ann.id)
  ann.active = !ann.active
}

// ── BROADCASTS ────────────────────────────────────────────────
async function sendBroadcast() {
  if (!newBroadcastTitle.value.trim() && !newBroadcastHtml.value.trim()) return
  sendingBroadcast.value = true
  try {
    const { data, error } = await supabase.from('admin_broadcasts').insert({
      admin_id: currentUser.value.id,
      title: newBroadcastTitle.value.trim(),
      html_content: newBroadcastHtml.value.trim(),
      js_content: newBroadcastJs.value.trim(),
      broadcast_type: broadcastType.value,
      active: true,
    }).select().single()
    if (!error && data) {
      broadcasts.value.unshift(data)
      newBroadcastTitle.value = ''; newBroadcastHtml.value = ''; newBroadcastJs.value = ''
    }
  } catch (e) {
    console.warn('sendBroadcast error:', e)
  } finally {
    sendingBroadcast.value = false
  }
}

async function deleteBroadcast(bc) {
  await supabase.from('admin_broadcasts').delete().eq('id', bc.id)
  broadcasts.value = broadcasts.value.filter(b => b.id !== bc.id)
}

async function toggleBroadcast(bc) {
  await supabase.from('admin_broadcasts').update({ active: !bc.active }).eq('id', bc.id)
  bc.active = !bc.active
}

// ── SQL RUNNER ────────────────────────────────────────────────
async function runSql() {
  if (!sqlQuery.value.trim()) return
  runningSql.value = true; sqlResult.value = null; sqlError.value = ''
  try {
    const { data, error } = await supabase.rpc('admin_run_sql', { query: sqlQuery.value })
    if (error) sqlError.value = error.message
    else sqlResult.value = data
  } catch (e) {
    sqlError.value = e.message
  }
  runningSql.value = false
}

// ── NAVIGATION ────────────────────────────────────────────────
const tabs = [
  { id: 'dashboard', label: 'Dashboard', icon: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z' },
  { id: 'users', label: 'Utilisateurs', icon: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75' },
  { id: 'posts', label: 'Posts', icon: 'M19 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h10l6 6v8a2 2 0 0 1-2 2zM14 2v6h6M16 13H8M16 17H8M10 9H8' },
  { id: 'reels', label: 'Reels', icon: 'M5 3l14 9-14 9v-18z' },
  { id: 'comments', label: 'Commentaires', icon: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' },
  { id: 'groups', label: 'Groups', icon: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8z' },
  { id: 'globalchat', label: 'Chat Global', icon: 'M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z' },
  { id: 'dms', label: 'Messages DM', icon: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' },
  { id: 'coins', label: 'Coins', icon: 'M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2z' },
  { id: 'analytics', label: 'Analytics', icon: 'M3 3v18h18V3zm9 4v8m-4-6v10m8-8v6' },
  { id: 'moderation', label: 'Modération', icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM7 12l2 2 4-4' },
  { id: 'content', label: 'Contenu', icon: 'M4 4v16h16V4zm4 6h8m-8 4h8M8 8h8' },
  { id: 'broadcast', label: 'Diffusion', icon: 'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 8.8a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 0h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z' },
  { id: 'sql', label: 'SQL', icon: 'M4 7h16M4 12h10M4 17h7' },
  { id: 'settings', label: 'Paramètres', icon: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' },
]

// Admin coins management
const coinUsers = ref([])
const coinSearch = ref('')
const coinAmount = ref(1000)
const coinReason = ref('admin_grant')
const grantingCoins = ref(false)
const grantResult = ref(null)
const selectedCoinUser = ref(null)
const loadingCoinUsers = ref(false)

const filteredCoinUsers = computed(() => {
  const q = coinSearch.value.toLowerCase()
  if (!q) return coinUsers.value
  return coinUsers.value.filter(u => u.username?.toLowerCase().includes(q) || u.id?.includes(q))
})

async function loadCoinUsers() {
  loadingCoinUsers.value = true
  try {
    const result = await withTimeout(
      supabase.from('profiles')
        .select('id, username, avatar_url, onb_coins, is_premium, is_official, premium_is_permanent, official_is_permanent, premium_expires_at, official_expires_at')
        .order('onb_coins', { ascending: false }),
      10000
    )
    coinUsers.value = result?.data || []
  } catch (e) { console.warn(e)
  } finally { loadingCoinUsers.value = false }
}

async function grantCoins() {
  if (!selectedCoinUser.value || !coinAmount.value) return
  grantingCoins.value = true
  grantResult.value = null
  const { data, error } = await supabase.rpc('admin_grant_coins', {
    target_user_id: selectedCoinUser.value.id,
    coin_amount: parseInt(coinAmount.value),
    grant_reason: coinReason.value || 'admin_grant'
  })
  grantingCoins.value = false
  if (error) {
    grantResult.value = { success: false, error: error.message }
  } else {
    grantResult.value = { success: true, ...data }
    // Update local list
    const u = coinUsers.value.find(u => u.id === selectedCoinUser.value.id)
    if (u && data?.new_balance !== undefined) u.onb_coins = data.new_balance
    selectedCoinUser.value = { ...selectedCoinUser.value, onb_coins: data?.new_balance ?? selectedCoinUser.value.onb_coins }
  }
}

async function setPermament(userId, field, value) {
  const { error } = await supabase.from('profiles').update({ [field]: value }).eq('id', userId)
  if (!error) {
    const u = coinUsers.value.find(u => u.id === userId)
    if (u) u[field] = value
  }
}

// ── ANALYTICS TAB ─────────────────────────────────────────────
const analyticsLoading = ref(false)
const analyticsError = ref('')
const analyticsTimeRange = ref('7d')

// Summary metrics
const activeUsersToday = ref(0)
const newSignupsWeek = ref(0)
const totalEngagement = ref(0)
const coinVolume = ref(0)
const platformRevenue = ref(0)

// Analytics data for charts
const userGrowthData = ref([])
const engagementData = ref([])
const topCreators = ref([])
const topPosts = ref([])
const coinEconomy = ref([])
const contentBreakdown = ref({ posts: 0, comments: 0, reels: 0 })

async function loadAnalytics() {
  analyticsLoading.value = true
  analyticsError.value = ''
  try {
    const range = analyticsTimeRange.value
    const daysBack = range === '7d' ? 7 : range === '30d' ? 30 : null
    const cutoff = daysBack ? new Date(Date.now() - daysBack * 86400000).toISOString() : null
    const activityCutoff = new Date(Date.now() - 86400000).toISOString()

    const usersQuery = supabase.from('profiles').select('created_at').order('created_at', { ascending: true })
    if (cutoff) usersQuery.gte('created_at', cutoff)
    const postsQuery = supabase.from('posts').select('created_at, media_url, user_id')
    if (cutoff) postsQuery.gte('created_at', cutoff)
    const commentsQuery = supabase.from('comments').select('created_at, user_id')
    if (cutoff) commentsQuery.gte('created_at', cutoff)
    const coinQuery = supabase.from('coin_transactions').select('amount, reason, created_at')
    if (cutoff) coinQuery.gte('created_at', cutoff)

    const [usersRes, postsRes, commentsRes, coinRes, activePostsRes, activeCommentsRes, activeGlobalRes] = await Promise.all([
      withTimeout(usersQuery, 10000),
      withTimeout(postsQuery, 10000),
      withTimeout(commentsQuery, 10000),
      withTimeout(coinQuery, 10000),
      withTimeout(supabase.from('posts').select('user_id').gte('created_at', activityCutoff), 10000),
      withTimeout(supabase.from('comments').select('user_id').gte('created_at', activityCutoff), 10000),
      withTimeout(
        supabase.from('global_messages').select('sender_id').gte('created_at', activityCutoff).eq('deleted', false),
        10000
      ),
    ])

    if (usersRes?.error) throw usersRes.error
    if (postsRes?.error) throw postsRes.error
    if (commentsRes?.error) throw commentsRes.error
    if (coinRes?.error) throw coinRes.error
    if (activePostsRes?.error) throw activePostsRes.error
    if (activeCommentsRes?.error) throw activeCommentsRes.error
    if (activeGlobalRes?.error) throw activeGlobalRes.error

    const usersData = usersRes?.data || []
    const grouped = {}
    usersData.forEach(u => {
      const date = new Date(u.created_at).toISOString().split('T')[0]
      grouped[date] = (grouped[date] || 0) + 1
    })
    userGrowthData.value = Object.entries(grouped).map(([date, count]) => ({ date, count }))
    newSignupsWeek.value = usersData.length

    const postsData = postsRes?.data || []
    const commentsData = commentsRes?.data || []
    const reelsCount = postsData.filter(p => p.media_url?.match(/\.(mp4|webm|mov|m4v)/i)).length
    const postsCount = postsData.length - reelsCount
    contentBreakdown.value = { posts: postsCount, comments: commentsData.length, reels: reelsCount }
    totalEngagement.value = postsData.length + commentsData.length

    const activeUsers = new Set()
    activePostsRes?.data?.forEach(p => p.user_id && activeUsers.add(p.user_id))
    activeCommentsRes?.data?.forEach(c => c.user_id && activeUsers.add(c.user_id))
    activeGlobalRes?.data?.forEach(m => m.sender_id && activeUsers.add(m.sender_id))
    activeUsersToday.value = activeUsers.size

    const creatorCounts = postsData.reduce((acc, post) => {
      if (!post.user_id) return acc
      acc[post.user_id] = (acc[post.user_id] || 0) + 1
      return acc
    }, {})
    const topIds = Object.entries(creatorCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)
    if (topIds.length) {
      const { data: profilesData, error: profilesError } = await withTimeout(
        supabase.from('profiles').select('id, username, avatar_url').in('id', topIds.map(([id]) => id)),
        10000
      )
      if (profilesError) throw profilesError
      const profileMap = {}
      ;(profilesData || []).forEach(p => { profileMap[p.id] = p })
      topCreators.value = topIds.map(([id, count]) => ({
        id,
        posts_count: count,
        username: profileMap[id]?.username,
        avatar_url: profileMap[id]?.avatar_url,
      }))
    } else {
      topCreators.value = []
    }

    const coinData = coinRes?.data || []
    coinVolume.value = coinData.reduce((sum, t) => sum + Math.abs(t.amount || 0), 0)
    platformRevenue.value = coinData
      .filter(t => ['purchase_premium', 'purchase_official'].includes(t.reason))
      .reduce((sum, t) => sum + Math.abs(t.amount || 0), 0)
    coinEconomy.value = coinData
  } catch (e) {
    analyticsError.value = e?.message || 'Unable to load analytics.'
  } finally {
    analyticsLoading.value = false
  }
}

// ── MODERATION TAB ────────────────────────────────────────────
const moderationSubTab = ref('reports')
const moderationTabs = [
  { id: 'reports', label: 'Reports', icon: 'M4 4h16v16H4zM8 8h8M8 12h8M8 16h4' },
  { id: 'flagged', label: 'Flagged', icon: 'M6 3v18M6 4h12l-2 4 2 4H6' },
  { id: 'users', label: 'Users', icon: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8z' },
  { id: 'rules', label: 'Rules', icon: 'M12 2l7 4v6c0 5-3 9-7 11-4-2-7-6-7-11V6l7-4z' },
]
const modReportsLoading = ref(false)
const modReports = ref([])
const reportFilter = ref('pending')
const reportSortBy = ref('created_at')

const flaggedContentLoading = ref(false)
const flaggedContent = ref([])

const forbiddenWordsLoading = ref(false)
const forbiddenWords = ref([])
const newForbiddenWord = ref('')
const newWordSeverity = ref('medium')
const addingForbiddenWord = ref(false)

const moderationUsersLoading = ref(false)
const moderationUsers = ref([])
const selectedUserForModeration = ref(null)
const userWarningHistory = ref([])
const warningReasonInput = ref('')
const moderationUsersFiltered = computed(() =>
  moderationUsers.value.filter(u => (u.warnings_count || 0) > 0 || u.is_banned)
)
const moderationCounts = computed(() => ({
  reports: modReports.value.length,
  flagged: flaggedContent.value.length,
  users: moderationUsersFiltered.value.length,
  rules: forbiddenWords.value.length,
}))

async function loadModReports() {
  modReportsLoading.value = true
  try {
    const query = supabase.from('user_reports').select('*, reporter:reporter_id(*), resolved_by(*)')

    if (reportFilter.value !== 'all') {
      query.eq('status', reportFilter.value)
    }

    const { data } = await withTimeout(query.order('created_at', { ascending: false }), 10000)
    modReports.value = data || []
  } catch (e) {
    console.warn('loadModReports error:', e)
  } finally {
    modReportsLoading.value = false
  }
}

async function loadFlaggedContent() {
  flaggedContentLoading.value = true
  try {
    const { data } = await withTimeout(
      supabase.from('moderation_flags').select('*').eq('resolved', false).order('created_at', { ascending: false }),
      10000
    )
    flaggedContent.value = data || []
  } catch (e) {
    console.warn('loadFlaggedContent error:', e)
  } finally {
    flaggedContentLoading.value = false
  }
}

async function resolveFlag(flag) {
  if (!confirm('Mark this flag as resolved?')) return
  const { error } = await supabase.from('moderation_flags').update({ resolved: true }).eq('id', flag.id)
  if (!error) {
    flaggedContent.value = flaggedContent.value.filter(f => f.id !== flag.id)
  }
}

async function loadForbiddenWords() {
  forbiddenWordsLoading.value = true
  try {
    const { data } = await withTimeout(
      supabase.from('forbidden_words').select('*').order('created_at', { ascending: false }),
      10000
    )
    forbiddenWords.value = data || []
  } catch (e) {
    console.warn('loadForbiddenWords error:', e)
  } finally {
    forbiddenWordsLoading.value = false
  }
}

async function addForbiddenWord() {
  if (!newForbiddenWord.value.trim()) return
  addingForbiddenWord.value = true
  try {
    const { data, error } = await withTimeout(
      supabase.from('forbidden_words').insert({
        word: newForbiddenWord.value.trim(),
        severity: newWordSeverity.value,
        enabled: true,
        created_by: currentUser.value.id
      }).select(),
      10000
    )
    if (!error && data) {
      forbiddenWords.value.unshift(data[0])
      newForbiddenWord.value = ''
      newWordSeverity.value = 'medium'
    }
  } catch (e) {
    console.warn('addForbiddenWord error:', e)
  } finally {
    addingForbiddenWord.value = false
  }
}

async function toggleForbiddenWord(word) {
  const { error } = await supabase.from('forbidden_words').update({ enabled: !word.enabled }).eq('id', word.id)
  if (!error) word.enabled = !word.enabled
}

async function deleteForbiddenWord(word) {
  if (!confirm(`Delete forbidden word "${word.word}"?`)) return
  const { error } = await supabase.from('forbidden_words').delete().eq('id', word.id)
  if (!error) {
    forbiddenWords.value = forbiddenWords.value.filter(w => w.id !== word.id)
  }
}

async function loadModerationUsers() {
  moderationUsersLoading.value = true
  try {
    const { data } = await withTimeout(
      supabase.from('profiles').select('id, username, avatar_url, warnings_count, is_banned, updated_at').order('warnings_count', { ascending: false }),
      10000
    )
    moderationUsers.value = data || []
  } catch (e) {
    console.warn('loadModerationUsers error:', e)
  } finally {
    moderationUsersLoading.value = false
  }
}

async function warnUser(userId) {
  const reason = warningReasonInput.value.trim() || 'Admin warning'
  try {
    const user = moderationUsers.value.find(u => u.id === userId)
    if (user) {
      const newWarnings = (user.warnings_count || 0) + 1
      const willBan = newWarnings >= 2

      const { error } = await supabase.from('profiles').update({
        warnings_count: newWarnings,
        is_banned: willBan ? true : user.is_banned
      }).eq('id', userId)

      if (!error) {
        user.warnings_count = newWarnings
        if (willBan) user.is_banned = true
        await supabase.from('moderation_action_logs').insert({
          admin_id: currentUser.value.id,
          action_type: 'warn_user',
          target_user_id: userId,
          reason
        })
        warningReasonInput.value = ''
      }
    }
  } catch (e) {
    console.warn('warnUser error:', e)
  }
}

async function removeWarning(userId) {
  const user = moderationUsers.value.find(u => u.id === userId)
  if (!user || !user.warnings_count) return
  if (!confirm('Remove one warning from this user?')) return
  const reason = warningReasonInput.value.trim() || 'Admin removed warning'
  const newWarnings = Math.max(0, (user.warnings_count || 0) - 1)
  const updates = { warnings_count: newWarnings }
  if (user.is_banned && newWarnings < 2) {
    updates.is_banned = false
  }
  try {
    const { error } = await supabase.from('profiles').update(updates).eq('id', userId)
    if (!error) {
      user.warnings_count = newWarnings
      if (updates.is_banned === false) user.is_banned = false
      const actionType = updates.is_banned === false ? 'unban_user' : 'warn_user'
      await supabase.from('moderation_action_logs').insert({
        admin_id: currentUser.value.id,
        action_type: actionType,
        target_user_id: userId,
        reason
      })
      warningReasonInput.value = ''
    }
  } catch (e) {
    console.warn('removeWarning error:', e)
  }
}

async function banUser(userId, reason) {
  if (!confirm('Ban this user?')) return
  try {
    const { error } = await supabase.from('profiles').update({ is_banned: true }).eq('id', userId)
    if (!error) {
      const user = moderationUsers.value.find(u => u.id === userId)
      if (user) user.is_banned = true
      await supabase.from('moderation_action_logs').insert({
        admin_id: currentUser.value.id,
        action_type: 'ban_user',
        target_user_id: userId,
        reason: reason || 'Admin ban'
      })
    }
  } catch (e) {
    console.warn('banUser error:', e)
  }
}

// ── CONTENT MANAGEMENT TAB ────────────────────────────────────
const featuredContentLoading = ref(false)
const featuredContent = ref([])
const selectedFeaturedItem = ref(null)
const featuredUntilDate = ref(null)
const featuredSection = ref('homepage')
const addingFeaturedContent = ref(false)

const trendingContentLoading = ref(false)
const trendingContent = ref([])
const trendingTimeWindow = ref('24h')
const trendingThreshold = ref(50)

const curationRulesLoading = ref(false)
const curationRules = ref([])
const newRuleName = ref('')
const newRuleType = ref('boost')
const newRuleMinEngagement = ref(100)
const addingCurationRule = ref(false)

const contentQualityLoading = ref(false)
const contentQuality = ref([])

async function loadFeaturedContent() {
  featuredContentLoading.value = true
  try {
    const { data } = await withTimeout(
      supabase.from('featured_content').select('*').order('position', { ascending: true }),
      10000
    )
    featuredContent.value = data || []
  } catch (e) {
    console.warn('loadFeaturedContent error:', e)
  } finally {
    featuredContentLoading.value = false
  }
}

async function addFeaturedContent(contentId) {
  if (!contentId || !featuredUntilDate.value) return
  addingFeaturedContent.value = true
  try {
    const { data, error } = await withTimeout(
      supabase.from('featured_content').insert({
        content_type: 'post',
        content_id: contentId,
        featured_by: currentUser.value.id,
        featured_until: featuredUntilDate.value,
        section: featuredSection.value,
        position: featuredContent.value.length
      }).select(),
      10000
    )
    if (!error && data) {
      featuredContent.value.push(data[0])
      featuredUntilDate.value = null
    }
  } catch (e) {
    console.warn('addFeaturedContent error:', e)
  } finally {
    addingFeaturedContent.value = false
  }
}

async function removeFeaturedContent(id) {
  if (!confirm('Remove featured content?')) return
  const { error } = await supabase.from('featured_content').delete().eq('id', id)
  if (!error) {
    featuredContent.value = featuredContent.value.filter(f => f.id !== id)
  }
}

async function loadTrendingContent() {
  trendingContentLoading.value = true
  try {
    const timeWindowMs = trendingTimeWindow.value === '24h' ? 86400000 : trendingTimeWindow.value === '7d' ? 604800000 : Infinity
    const cutoff = new Date(Date.now() - timeWindowMs).toISOString()

    const { data: posts } = await withTimeout(
      supabase.from('posts').select('id, caption, user_id, created_at, profiles(username, avatar_url), likes(count), comments(count)')
        .gte('created_at', cutoff)
        .order('created_at', { ascending: false }),
      10000
    )

    const withScores = (posts || []).map(p => {
      const engagement = (p.likes?.[0]?.count || 0) + (p.comments?.[0]?.count || 0)
      return { ...p, engagement, trend_score: engagement }
    })

    trendingContent.value = withScores.filter(p => p.engagement >= trendingThreshold.value).sort((a, b) => b.engagement - a.engagement)
  } catch (e) {
    console.warn('loadTrendingContent error:', e)
  } finally {
    trendingContentLoading.value = false
  }
}

async function loadCurationRules() {
  curationRulesLoading.value = true
  try {
    const { data } = await withTimeout(
      supabase.from('content_curation_rules').select('*').order('created_at', { ascending: false }),
      10000
    )
    curationRules.value = data || []
  } catch (e) {
    console.warn('loadCurationRules error:', e)
  } finally {
    curationRulesLoading.value = false
  }
}

async function addCurationRule() {
  if (!newRuleName.value.trim()) return
  addingCurationRule.value = true
  try {
    const { data, error } = await withTimeout(
      supabase.from('content_curation_rules').insert({
        rule_name: newRuleName.value,
        rule_type: newRuleType.value,
        criteria: { minEngagement: newRuleMinEngagement.value },
        action: newRuleType.value === 'boost' ? 'feature' : 'hide',
        enabled: true,
        created_by: currentUser.value.id
      }).select(),
      10000
    )
    if (!error && data) {
      curationRules.value.unshift(data[0])
      newRuleName.value = ''
      newRuleType.value = 'boost'
      newRuleMinEngagement.value = 100
    }
  } catch (e) {
    console.warn('addCurationRule error:', e)
  } finally {
    addingCurationRule.value = false
  }
}

async function toggleCurationRule(rule) {
  const { error } = await supabase.from('content_curation_rules').update({ enabled: !rule.enabled }).eq('id', rule.id)
  if (!error) rule.enabled = !rule.enabled
}

async function deleteCurationRule(id) {
  if (!confirm('Delete this rule?')) return
  const { error } = await supabase.from('content_curation_rules').delete().eq('id', id)
  if (!error) {
    curationRules.value = curationRules.value.filter(r => r.id !== id)
  }
}

// ── SETTINGS ──────────────────────────────────────────────────
const isTrollMode = ref(false)
const savingTrollMode = ref(false)

async function loadSettings() {
  const { data } = await supabase.from('site_settings').select('is_troll_mode').eq('id', 1).maybeSingle();
  if (data) isTrollMode.value = data.is_troll_mode;
}

async function toggleTrollMode() {
  savingTrollMode.value = true;
  const newVal = !isTrollMode.value;
  const { error } = await supabase.from('site_settings').update({ is_troll_mode: newVal }).eq('id', 1);
  if (!error) isTrollMode.value = newVal;
  savingTrollMode.value = false;
}

function fmtExpiry(ts) {
  if (!ts) return '—'
  const days = Math.ceil((new Date(ts) - Date.now()) / 86400000)
  if (days < 0) return `Expired ${Math.abs(days)}d ago`
  return `${days}d left`
}

function formatCompact(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString()
}

function switchTab(tab) {
  activeTab.value = tab
  if (tab === 'users' && !users.value.length) loadUsers()
  if (tab === 'posts' && !posts.value.length) loadPosts()
  if (tab === 'reels' && !adminReels.value.length) loadAdminReels()
  if (tab === 'groups' && !groups.value.length) loadGroups()
  if (tab === 'globalchat' && !globalMsgs.value.length) loadGlobalMsgs()
  if (tab === 'dms' && !dms.value.length) loadDms()
  if (tab === 'comments' && !comments.value.length) loadComments()
  if (tab === 'broadcast') { loadAnnouncements(); loadBroadcasts() }
  if (tab === 'coins') loadCoinUsers()
  if (tab === 'analytics' && !userGrowthData.value.length) loadAnalytics()
  if (tab === 'moderation') { loadModReports(); loadFlaggedContent(); loadForbiddenWords(); loadModerationUsers() }
  if (tab === 'content') { loadFeaturedContent(); loadTrendingContent(); loadCurationRules() }
  if (tab === 'settings') loadSettings()
}

function fmtDate(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text) } catch {}
}

onMounted(checkAdmin)
</script>

<template>
  <div class="admin-page" v-if="!loading && isAdmin">

    <!-- Tabs -->
    <div class="admin-tabs">
      <button
        v-for="t in tabs" :key="t.id"
        class="tab-btn" :class="{ active: activeTab === t.id }"
        @click="switchTab(t.id)"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path :d="t.icon"/></svg>
        {{ t.label }}
      </button>
    </div>

    <div class="admin-content">

      <!-- ── DASHBOARD ── -->
      <div v-if="activeTab === 'dashboard'" class="dashboard">
        <div class="stats-grid">
          <div class="stat-card" @click="switchTab('users')">
            <div class="stat-icon users"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div>
            <div class="stat-val">{{ stats.users }}</div>
            <div class="stat-label">Utilisateurs</div>
          </div>
          <div class="stat-card" @click="switchTab('posts')">
            <div class="stat-icon posts"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>
            <div class="stat-val">{{ stats.posts }}</div>
            <div class="stat-label">Posts</div>
          </div>
          <div class="stat-card" @click="switchTab('comments')">
            <div class="stat-icon comments"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>
            <div class="stat-val">{{ stats.comments }}</div>
            <div class="stat-label">Commentaires</div>
          </div>
          <div class="stat-card" @click="switchTab('dms')">
            <div class="stat-icon messages"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>
            <div class="stat-val">{{ stats.messages }}</div>
            <div class="stat-label">Messages DM</div>
          </div>
          <div class="stat-card" @click="switchTab('groups')">
            <div class="stat-icon groups"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div>
            <div class="stat-val">{{ stats.groups }}</div>
            <div class="stat-label">Groups</div>
          </div>
          <div class="stat-card" @click="switchTab('globalchat')">
            <div class="stat-icon global"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/></svg></div>
            <div class="stat-val">{{ stats.globalMsgs }}</div>
            <div class="stat-label">Messages globaux</div>
          </div>
        </div>

        <div class="quick-actions">
          <div class="qa-title">Actions rapides</div>
          <div class="qa-grid">
            <button class="qa-btn" @click="switchTab('broadcast')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 8.8"/><path d="M23 6l-9-4L5 6M5 6l9 4 9-4"/></svg>
              Nouvelle annonce
            </button>
            <button class="qa-btn" @click="switchTab('users'); loadUsers()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              Gérer les utilisateurs
            </button>
            <button class="qa-btn" @click="switchTab('globalchat'); loadGlobalMsgs()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/></svg>
              Modérer le chat global
            </button>
            <button class="qa-btn" @click="switchTab('sql')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h10M4 17h7"/></svg>
              Exécuter SQL
            </button>
          </div>
        </div>
      </div>

      <!-- ── USERS ── -->
      <div v-else-if="activeTab === 'users'" class="tab-section">
        <div class="section-bar">
          <h2>Utilisateurs <span class="count-badge">{{ filteredUsers.length }}</span></h2>
          <div class="section-bar-right">
            <div class="search-box">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input v-model="userSearch" placeholder="Search…" />
            </div>
            <button class="btn-purple-sm" @click="loadUsers">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
              Actualiser
            </button>
          </div>
        </div>
        <div v-if="userError" class="error-banner">{{ userError }}</div>
        <div v-if="loadingUsers" class="loading-state"><div class="spinner"></div></div>
        <div v-else class="users-table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Utilisateur</th>
                <th>Badges</th>
                <th>Bio</th>
                <th>Couleur pseudo</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in filteredUsers" :key="u.id">
                <td>
                  <div class="user-cell">
                    <div class="user-av">
                      <img v-if="u.avatar_url" :src="u.avatar_url" />
                      <span v-else>{{ u.username?.charAt(0)?.toUpperCase() }}</span>
                    </div>
                    <div>
                      <div class="user-cell-name" :style="u.username_color ? { color: u.username_color } : {}">@{{ u.username || '—' }}</div>
                      <div class="user-cell-id" @click="copyText(u.id)" title="Copier l'ID">{{ u.id?.slice(0,12) }}…</div>
                    </div>
                  </div>
                </td>
                <td>
                  <div class="badge-toggles">
                    <button
                      class="badge-toggle" :class="{ active: u.is_premium }"
                      @click="toggleField(u, 'is_premium')" title="Premium"
                    >
                      <svg viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px;margin-right:4px"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                      Premium
                    </button>
                    <button
                      class="badge-toggle" :class="{ active: u.is_official }"
                      @click="toggleField(u, 'is_official')" title="Officiel"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>
                      Officiel
                    </button>
                    <button
                      class="badge-toggle danger" :class="{ active: u.is_admin }"
                      @click="toggleField(u, 'is_admin')" title="Admin"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;margin-right:4px"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                      Admin
                    </button>
                    <button
                      class="badge-toggle" :class="{ active: u.is_anonymous }"
                      @click="toggleField(u, 'is_anonymous')" title="Anonyme"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;margin-right:4px"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
                      Anonyme
                    </button>
                    <button
                      class="badge-toggle" :class="{ active: u.is_invisible }"
                      @click="toggleField(u, 'is_invisible')" title="Invisible"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;margin-right:4px"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                      Invisible
                    </button>
                    <button
                      class="badge-toggle danger" :class="{ active: u.is_banned }"
                      @click="toggleField(u, 'is_banned')" title="Banni"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;margin-right:4px"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
                      Banni
                    </button>
                  </div>
                </td>
                <td>
                  <div v-if="editingUser === u.id" style="display:flex;gap:4px">
                    <input v-model="editUserBio" class="inline-input" style="min-width:120px" @keyup.enter="saveEditUser(u)" @keyup.escape="editingUser=null" />
                    <button class="btn-xs-green" @click="saveEditUser(u)">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><polyline points="20 6 9 17 4 12"/></svg>
                    </button>
                    <button class="btn-xs-gray" @click="editingUser=null">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  </div>
                  <div v-else @click="startEditUser(u)" class="editable-cell" title="Cliquer pour modifier">
                    {{ u.bio || '—' }}
                  </div>
                </td>
                <td>
                  <div class="color-row">
                    <div class="color-dot" :style="{ background: u.username_color || '#888' }"></div>
                    <input type="color" :value="u.username_color || '#4C10E0'" @change="setUsernameColor(u, $event.target.value)" class="color-picker" title="Changer la couleur" />
                    <button v-if="u.username_color" class="btn-xs-gray" @click="setUsernameColor(u, null)" title="Réinitialiser">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  </div>
                </td>
                <td>
                  <div class="action-btns">
                    <button class="action-btn" @click="forceReload(u)" title="Actualiser l'application" style="color:var(--text-2)">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.92-12.28l5.67-5.67"/></svg>
                    </button>
                    <button class="action-btn danger" @click="deleteUser(u)" title="Delete user">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- ── POSTS ── -->
      <div v-else-if="activeTab === 'posts'" class="tab-section">
        <div class="section-bar">
          <h2>Posts <span class="count-badge">{{ posts.length }}</span></h2>
          <button class="btn-purple-sm" @click="loadPosts">Actualiser</button>
        </div>
        <div v-if="loadingPosts" class="loading-state"><div class="spinner"></div></div>
        <div v-else class="posts-grid">
          <div v-for="p in posts" :key="p.id" class="post-card">
            <div class="post-card-media">
              <video v-if="p.media_url?.match(/\.(mp4|webm|mov|m4v)/i)" :src="p.media_url" style="width:100%;height:100%;object-fit:cover" controls></video>
              <img v-else-if="p.media_url" :src="p.media_url" loading="lazy" />
              <div v-else class="post-card-no-media">Aucun média</div>
            </div>
            <div class="post-card-info">
              <div class="post-card-author">@{{ p.profiles?.username }}</div>
              <div class="post-card-stats">
                <span title="Likes"><svg viewBox="0 0 24 24" fill="currentColor" style="width:10px;height:10px;margin-right:2px"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg> {{ p.likes?.[0]?.count || 0 }}</span>
                <span title="Commentaires"><svg viewBox="0 0 24 24" fill="currentColor" style="width:10px;height:10px;margin-right:2px"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> {{ p.comments?.[0]?.count || 0 }}</span>
                <span title="Vues"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:10px;height:10px;margin-right:2px"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> {{ p.views || 0 }}</span>
              </div>
              <div class="post-card-caption">{{ p.caption?.slice(0, 60) }}{{ p.caption?.length > 60 ? '…' : '' }}</div>
              <div class="post-card-date">{{ fmtDate(p.created_at) }}</div>
            </div>
            <button class="post-card-del" @click="deletePost(p)" title="Delete">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
            </button>
          </div>
        </div>
      </div>

      <!-- ── REELS ── -->
      <div v-else-if="activeTab === 'reels'" class="tab-section">
        <div class="section-bar">
          <h2>Reels <span class="count-badge">{{ adminReels.length }}</span></h2>
          <button class="btn-purple-sm" @click="loadAdminReels">Actualiser</button>
        </div>
        <div v-if="loadingAdminReels" class="loading-state"><div class="spinner"></div></div>
        <div v-else class="posts-grid">
          <div v-for="r in adminReels" :key="r.id" class="post-card">
            <div class="post-card-media">
              <video :src="r.media_url" style="width:100%;height:100%;object-fit:cover" controls></video>
            </div>
            <div class="post-card-info">
              <div class="post-card-author">@{{ r.profiles?.username }}</div>
              <div class="post-card-stats">
                <span title="Likes"><svg viewBox="0 0 24 24" fill="currentColor" style="width:10px;height:10px;margin-right:2px"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg> {{ r.likes?.[0]?.count || 0 }}</span>
                <span title="Commentaires"><svg viewBox="0 0 24 24" fill="currentColor" style="width:10px;height:10px;margin-right:2px"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> {{ r.comments?.[0]?.count || 0 }}</span>
                <span title="Vues"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:10px;height:10px;margin-right:2px"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> {{ r.views || 0 }}</span>
              </div>
              <div class="post-card-caption">{{ r.caption?.slice(0, 60) }}{{ r.caption?.length > 60 ? '…' : '' }}</div>
              <div class="post-card-date">{{ fmtDate(r.created_at) }}</div>
            </div>
            <button class="post-card-del" @click="deletePost(r)" title="Delete Reel">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
            </button>
          </div>
        </div>
      </div>

      <!-- ── GROUPS ── -->
      <div v-else-if="activeTab === 'groups'" class="tab-section">
        <div class="section-bar">
          <h2>Groups <span class="count-badge">{{ groups.length }}</span></h2>
          <button class="btn-purple-sm" @click="loadGroups">Actualiser</button>
        </div>
        <div v-if="loadingGroups" class="loading-state"><div class="spinner"></div></div>
        <div v-else class="data-list">
          <div v-for="g in groups" :key="g.id" class="data-row">
            <div class="dr-avatar" :style="g.banner_url ? { backgroundImage: `url(${g.banner_url})`, backgroundSize: 'cover' } : {}">
              <span v-if="!g.banner_url">{{ g.name?.charAt(0) }}</span>
            </div>
            <div class="dr-info">
              <div class="dr-name">{{ g.name }}</div>
              <div class="dr-meta">{{ g.group_members?.[0]?.count || 0 }} members · <span v-if="g.is_private"><svg style="width:12px;height:12px;display:inline;margin-right:2px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Private</span><span v-else><svg style="width:12px;height:12px;display:inline;margin-right:2px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"/><path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/></svg>Public</span> · {{ fmtDate(g.created_at) }}</div>
              <div v-if="g.description" class="dr-desc">{{ g.description?.slice(0, 80) }}</div>
            </div>
            <div class="action-btns">
              <button class="action-btn" :class="g.is_private ? 'active' : ''" @click="toggleGroupPrivacy(g)" :title="g.is_private ? 'Rendre public' : 'Rendre privé'">
                <svg v-if="g.is_private" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/></svg>
              </button>
              <button class="action-btn danger" @click="deleteGroup(g)" title="Delete">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- ── GLOBAL CHAT ── -->
      <div v-else-if="activeTab === 'globalchat'" class="tab-section">
        <div class="section-bar">
          <h2>Chat Global <span class="count-badge">{{ globalMsgs.length }}</span></h2>
          <div class="section-bar-right">
            <button class="btn-purple-sm" @click="loadGlobalMsgs">Actualiser</button>
            <button class="btn-danger-sm" @click="clearAllGlobalMsgs">Vider tout</button>
          </div>
        </div>
        <div v-if="loadingGlobalMsgs" class="loading-state"><div class="spinner"></div></div>
        <div v-else class="data-list">
          <div v-for="m in globalMsgs" :key="m.id" class="data-row">
            <div class="dr-avatar sm">
              <img v-if="m.profiles?.avatar_url" :src="m.profiles.avatar_url" />
              <span v-else>{{ m.profiles?.username?.charAt(0) }}</span>
            </div>
            <div class="dr-info">
              <div class="dr-name">@{{ m.profiles?.username }}</div>
              <div class="dr-message">{{ m.content }}</div>
              <div class="dr-meta">{{ fmtDate(m.created_at) }}</div>
            </div>
            <button class="action-btn danger" @click="deleteGlobalMsg(m)" title="Delete">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
            </button>
          </div>
          <div v-if="!globalMsgs.length" class="empty-state">No messages in the global chat</div>
        </div>
      </div>

      <!-- ── DMS ── -->
      <div v-else-if="activeTab === 'dms'" class="tab-section">
        <div class="section-bar">
          <h2>Messages Privés (God Mode) <span class="count-badge">{{ dms.length }}</span></h2>
          <button class="btn-purple-sm" @click="loadDms">Actualiser</button>
        </div>
        <div v-if="loadingDms" class="loading-state"><div class="spinner"></div></div>
        <div v-else class="data-list">
          <div v-for="m in dms" :key="m.id" class="data-row">
            <div class="dr-info">
              <div class="dr-name">@{{ m.sender?.username }} <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin:0 4px"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg> @{{ m.receiver?.username }}</div>
              <div class="dr-message">{{ m.content }}</div>
              <div class="dr-meta">{{ fmtDate(m.created_at) }}</div>
            </div>
            <button class="action-btn danger" @click="deleteDm(m)" title="Delete">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
            </button>
          </div>
          <div v-if="!dms.length" class="empty-state">No DMs found</div>
        </div>
      </div>

      <!-- ── COMMENTS ── -->
      <div v-else-if="activeTab === 'comments'" class="tab-section">
        <div class="section-bar">
          <h2>Commentaires <span class="count-badge">{{ comments.length }}</span></h2>
          <button class="btn-purple-sm" @click="loadComments">Actualiser</button>
        </div>
        <div v-if="loadingComments" class="loading-state"><div class="spinner"></div></div>
        <div v-else class="data-list">
          <div v-for="c in comments" :key="c.id" class="data-row">
            <div class="dr-avatar sm">
              <img v-if="c.profiles?.avatar_url" :src="c.profiles.avatar_url" />
              <span v-else>{{ c.profiles?.username?.charAt(0) }}</span>
            </div>
            <div class="dr-info">
              <div class="dr-name">@{{ c.profiles?.username }}</div>
              <div class="dr-message">{{ c.content }}</div>
              <div class="dr-meta">Post: {{ c.post_id }} · {{ fmtDate(c.created_at) }}</div>
            </div>
            <button class="action-btn danger" @click="deleteComment(c)" title="Delete">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
            </button>
          </div>
          <div v-if="!comments.length" class="empty-state">No comments found</div>
        </div>
      </div>

      <!-- ── BROADCAST ── -->
      <!-- ── COINS TAB ── -->
      <div v-else-if="activeTab === 'coins'" class="tab-section">
        <div class="coins-admin-layout">

          <!-- Grant coins panel -->
          <div class="coins-grant-panel">
            <h3 class="coins-panel-title">
              <svg viewBox="0 0 24 24" fill="currentColor" style="width:18px;height:18px;color:#fbbf24"><circle cx="12" cy="12" r="10"/></svg>
              Grant ONB Coins
            </h3>

            <!-- User search + select -->
            <div class="cg-field">
              <label>Search user</label>
              <input v-model="coinSearch" placeholder="Username…" class="cg-input" @focus="loadCoinUsers" />
            </div>
            <div v-if="filteredCoinUsers.length && coinSearch" class="coin-user-list">
              <div v-for="u in filteredCoinUsers.slice(0,8)" :key="u.id"
                class="coin-user-row" :class="{ selected: selectedCoinUser?.id === u.id }"
                @click="selectedCoinUser = u; coinSearch = u.username"
              >
                <div class="cu-av">
                  <img v-if="u.avatar_url" :src="u.avatar_url" />
                  <span v-else>{{ u.username?.charAt(0)?.toUpperCase() }}</span>
                </div>
                <span class="cu-name">@{{ u.username }}</span>
                <span class="cu-bal">{{ (u.onb_coins ?? 0).toLocaleString() }} C</span>
              </div>
            </div>

            <div v-if="selectedCoinUser" class="selected-user-card">
              <div class="suc-row">
                <span>Selected:</span>
                <strong>@{{ selectedCoinUser.username }}</strong>
                <span class="suc-bal">{{ (selectedCoinUser.onb_coins ?? 0).toLocaleString() }} coins</span>
              </div>
            </div>

            <div class="cg-field">
              <label>Amount (positive = add, negative = deduct)</label>
              <input v-model.number="coinAmount" type="number" class="cg-input" placeholder="e.g. 5000" />
            </div>
            <div class="cg-field">
              <label>Reason</label>
              <select v-model="coinReason" class="cg-input">
                <option value="admin_grant">Admin grant</option>
                <option value="welcome_bonus">Welcome bonus</option>
                <option value="event_reward">Event reward</option>
                <option value="refund">Refund</option>
                <option value="correction">Correction</option>
              </select>
            </div>

            <div v-if="grantResult" class="grant-result" :class="grantResult.success ? 'ok' : 'err'">
              <template v-if="grantResult.success">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;display:inline;vertical-align:text-bottom;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>
                Done! New balance: <strong>{{ grantResult.new_balance?.toLocaleString() }}</strong> coins
              </template>
              <template v-else>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;display:inline;vertical-align:text-bottom;margin-right:4px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                {{ grantResult.error }}
              </template>
            </div>

            <button class="grant-btn" :disabled="!selectedCoinUser || !coinAmount || grantingCoins" @click="grantCoins">
              <span v-if="grantingCoins" class="mini-spin"></span>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="width:16px;height:16px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Grant Coins
            </button>
          </div>

          <!-- Users coin overview -->
          <div class="coins-overview-panel">
            <h3 class="coins-panel-title">All Users — Coin Balances</h3>
            <div v-if="loadingCoinUsers" class="center-spin"><div class="spinner"></div></div>
            <div v-else class="coin-overview-list">
              <div v-for="u in coinUsers" :key="u.id" class="co-row">
                <div class="cu-av small">
                  <img v-if="u.avatar_url" :src="u.avatar_url" />
                  <span v-else>{{ u.username?.charAt(0)?.toUpperCase() }}</span>
                </div>
                <div class="co-info">
                  <span class="co-name">@{{ u.username }}</span>
                  <div class="co-subs">
                    <span v-if="u.is_premium" class="co-sub-chip premium">
                      <svg viewBox="0 0 24 24" fill="currentColor" style="width:10px;height:10px;display:inline;margin-right:2px"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                      {{ u.premium_is_permanent ? '∞' : fmtExpiry(u.premium_expires_at) }}
                    </span>
                    <span v-if="u.is_official" class="co-sub-chip official">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:10px;height:10px;display:inline;margin-right:2px"><polyline points="20 6 9 17 4 12"/></svg>
                      {{ u.official_is_permanent ? '∞' : fmtExpiry(u.official_expires_at) }}
                    </span>
                  </div>
                </div>
                <span class="co-bal">{{ (u.onb_coins ?? 0).toLocaleString() }}</span>
                <!-- Permanent toggles -->
                <div class="co-perms">
                  <button class="perm-toggle" :class="{ on: u.premium_is_permanent }"
                    @click="setPermament(u.id, 'premium_is_permanent', !u.premium_is_permanent)"
                    title="Toggle permanent premium">
                    <svg viewBox="0 0 24 24" fill="currentColor" style="width:12px;height:12px;display:inline;margin-right:2px"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                    ∞
                  </button>
                  <button class="perm-toggle official" :class="{ on: u.official_is_permanent }"
                    @click="setPermament(u.id, 'official_is_permanent', !u.official_is_permanent)"
                    title="Toggle permanent official">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;display:inline;margin-right:2px"><polyline points="20 6 9 17 4 12"/></svg>
                    ∞
                  </button>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>

      <div v-else-if="activeTab === 'broadcast'" class="tab-section">
        <div class="bc-subtabs">
          <button class="bc-subtab" :class="{ active: bcSubTab === 'announcements' }" @click="bcSubTab = 'announcements'">Annonces</button>
          <button class="bc-subtab" :class="{ active: bcSubTab === 'html' }" @click="bcSubTab = 'html'">HTML/JS</button>
        </div>

        <!-- Announcements -->
        <div v-if="bcSubTab === 'announcements'">
          <div class="form-card">
            <h3>Nouvelle annonce</h3>
            <textarea v-model="newAnnouncement" placeholder="Contenu de l'annonce…" rows="3" class="form-textarea"></textarea>
            <div class="form-row">
              <select v-model="announcementType" class="form-select">
                <option value="info">Info</option>
                <option value="success">Succès</option>
                <option value="warning">Avertissement</option>
                <option value="danger">Danger</option>
              </select>
              <button class="btn-purple" @click="sendAnnouncement" :disabled="!newAnnouncement.trim() || sendingAnnouncement">
                {{ sendingAnnouncement ? '…' : 'Publish' }}
              </button>
            </div>
          </div>
          <div class="data-list" style="margin-top:16px">
            <div v-for="ann in announcements" :key="ann.id" class="data-row" :class="'ann-'+ann.type">
              <div class="dr-info">
                <div class="dr-message">{{ ann.content }}</div>
                <div class="dr-meta">{{ ann.type }} · {{ fmtDate(ann.created_at) }}</div>
              </div>
              <div class="action-btns">
                <button class="action-btn" :class="{ active: ann.active }" @click="toggleAnnouncement(ann)" :title="ann.active ? 'Désactiver' : 'Activer'">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                </button>
                <button class="action-btn danger" @click="deleteAnnouncement(ann)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- HTML/JS Broadcasts -->
        <div v-else>
          <div class="form-card">
            <h3>Nouveau broadcast HTML/JS</h3>
            <input v-model="newBroadcastTitle" placeholder="Titre" class="form-input" />
            <div class="form-row" style="gap:8px;align-items:center">
              <label style="font-size:.82rem;font-weight:600;color:var(--text-2)">Type:</label>
              <select v-model="broadcastType" class="form-select">
                <option value="banner">Bannière</option>
                <option value="modal">Modal</option>
                <option value="inline">Inline</option>
              </select>
            </div>
            <label class="form-label">HTML</label>
            <textarea v-model="newBroadcastHtml" placeholder="<div>Contenu HTML…</div>" rows="4" class="form-textarea code"></textarea>
            <label class="form-label">JavaScript (optionnel)</label>
            <textarea v-model="newBroadcastJs" placeholder="console.log('hello')" rows="3" class="form-textarea code"></textarea>
            <button class="btn-purple" @click="sendBroadcast" :disabled="sendingBroadcast">
              {{ sendingBroadcast ? '…' : 'Diffuser' }}
            </button>
          </div>
          <div class="data-list" style="margin-top:16px">
            <div v-for="bc in broadcasts" :key="bc.id" class="data-row">
              <div class="dr-info">
                <div class="dr-name">{{ bc.title || 'Sans titre' }}</div>
                <div class="dr-meta">{{ bc.broadcast_type }} · {{ fmtDate(bc.created_at) }}</div>
              </div>
              <div class="action-btns">
                <button class="action-btn" :class="{ active: bc.active }" @click="toggleBroadcast(bc)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                </button>
                <button class="action-btn danger" @click="deleteBroadcast(bc)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ── SQL ── -->
      <div v-else-if="activeTab === 'sql'" class="tab-section">
        <div class="form-card">
          <h3>Exécuter SQL</h3>
          <p class="form-hint">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;display:inline;vertical-align:text-bottom;margin-right:4px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            Requiert la fonction RPC <code>admin_run_sql</code> — voir le SQL de migration.
          </p>
          <textarea v-model="sqlQuery" placeholder="SELECT * FROM profiles LIMIT 10;" rows="6" class="form-textarea code"></textarea>
          <button class="btn-purple" @click="runSql" :disabled="runningSql || !sqlQuery.trim()">
            {{ runningSql ? 'Exécution…' : 'Exécuter' }}
          </button>
        </div>
        <div v-if="sqlError" class="error-banner" style="margin-top:12px">{{ sqlError }}</div>
        <div v-if="sqlResult !== null" class="sql-result">
          <pre>{{ JSON.stringify(sqlResult, null, 2) }}</pre>
        </div>

        <div class="form-card" style="margin-top:16px">
          <h3>Snippets utiles</h3>
          <div class="snippets">
            <button class="snippet-btn" @click="sqlQuery = `SELECT id, username, is_admin, is_premium FROM profiles ORDER BY updated_at DESC LIMIT 20;`">Voir tous les users</button>
            <button class="snippet-btn" @click="sqlQuery = `UPDATE profiles SET is_premium = true WHERE username = 'USERNAME';`">Activer Premium</button>
            <button class="snippet-btn" @click="sqlQuery = `SELECT COUNT(*) as total FROM global_messages WHERE deleted = false;`">Compter messages globaux</button>
            <button class="snippet-btn" @click="sqlQuery = `DELETE FROM global_messages WHERE deleted = true;`">Purger messages supprimés</button>
            <button class="snippet-btn" @click="sqlQuery = `SELECT g.name, COUNT(gm.user_id) as members FROM groups g LEFT JOIN group_members gm ON g.id = gm.group_id GROUP BY g.id ORDER BY members DESC;`">Group stats</button>
          </div>
        </div>
      </div>

      <!-- ANALYTICS TAB -->
      <div v-else-if="activeTab === 'analytics'" class="tab-section">
        <div class="section-bar">
          <h2>Platform Analytics</h2>
          <div class="tab-controls">
            <select v-model="analyticsTimeRange" @change="loadAnalytics" class="sm-input">
              <option value="7d">7 Days</option>
              <option value="30d">30 Days</option>
              <option value="all">All Time</option>
            </select>
            <button @click="loadAnalytics" class="sm-btn" title="Refresh data">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36M20.49 15a9 9 0 0 1-14.85 3.36"/></svg>
              Refresh
            </button>
          </div>
        </div>

        <div v-if="analyticsLoading" class="center-spin"><div class="spinner"></div></div>
        <div v-else-if="analyticsError" class="error-banner">{{ analyticsError }}</div>
        <div v-else>
          <!-- Summary Cards -->
          <div class="analytics-cards">
            <div class="stat-card">
              <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              <div class="stat-content">
                <div class="stat-label">Active Users (24h)</div>
                <div class="stat-value">{{ activeUsersToday.toLocaleString() }}</div>
              </div>
            </div>
            <div class="stat-card">
              <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              <div class="stat-content">
                <div class="stat-label">New Signups</div>
                <div class="stat-value">{{ newSignupsWeek.toLocaleString() }}</div>
              </div>
            </div>
            <div class="stat-card">
              <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              <div class="stat-content">
                <div class="stat-label">Total Engagement</div>
                <div class="stat-value">{{ totalEngagement.toLocaleString() }}</div>
              </div>
            </div>
            <div class="stat-card">
              <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
              <div class="stat-content">
                <div class="stat-label">Coin Volume</div>
                <div class="stat-value">{{ formatCompact(coinVolume) }}</div>
              </div>
            </div>
            <div class="stat-card">
              <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1v22M4 7h8a4 4 0 0 1 0 8H6a4 4 0 0 0 0 8h8"/></svg>
              <div class="stat-content">
                <div class="stat-label">Revenue (Coins)</div>
                <div class="stat-value">{{ formatCompact(platformRevenue) }}</div>
              </div>
            </div>
          </div>

          <!-- Content Breakdown -->
          <div class="analytics-grid" style="margin-top:20px">
            <div class="chart-card">
              <h4>Content Breakdown</h4>
              <div class="breakdown-chart">
                <div class="breakdown-item">
                  <span class="breakdown-label">Posts</span>
                  <div class="breakdown-bar" :style="{width: (contentBreakdown.posts/(contentBreakdown.posts+contentBreakdown.comments+contentBreakdown.reels||1)*100)+'%', background: 'var(--purple)'}"></div>
                  <span class="breakdown-count">{{ contentBreakdown.posts }}</span>
                </div>
                <div class="breakdown-item">
                  <span class="breakdown-label">Comments</span>
                  <div class="breakdown-bar" :style="{width: (contentBreakdown.comments/(contentBreakdown.posts+contentBreakdown.comments+contentBreakdown.reels||1)*100)+'%', background: '#a78bfa'}"></div>
                  <span class="breakdown-count">{{ contentBreakdown.comments }}</span>
                </div>
                <div class="breakdown-item">
                  <span class="breakdown-label">Reels</span>
                  <div class="breakdown-bar" :style="{width: (contentBreakdown.reels/(contentBreakdown.posts+contentBreakdown.comments+contentBreakdown.reels||1)*100)+'%', background: '#f472b6'}"></div>
                  <span class="breakdown-count">{{ contentBreakdown.reels }}</span>
                </div>
              </div>
            </div>

            <div class="chart-card">
              <h4>Top 10 Creators</h4>
              <div class="analytics-table">
                <div v-for="(creator, idx) in topCreators" :key="creator.id" class="table-row">
                  <span class="rank">{{ idx + 1 }}</span>
                  <img v-if="creator.avatar_url" :src="creator.avatar_url" class="avatar-sm" />
                  <span v-else class="avatar-sm placeholder">{{ creator.username?.charAt(0).toUpperCase() }}</span>
                  <span class="creator-name">@{{ creator.username }}</span>
                  <span class="creator-stats">{{ creator.posts_count ?? creator.posts?.[0]?.count ?? 0 }} posts</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- MODERATION TAB -->
      <div v-else-if="activeTab === 'moderation'" class="tab-section">
        <div class="section-bar">
          <h2>Moderation Center</h2>
          <button @click="() => { loadModReports(); loadFlaggedContent(); loadForbiddenWords(); loadModerationUsers() }" class="sm-btn" title="Refresh all data">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36M20.49 15a9 9 0 0 1-14.85 3.36"/></svg>
            Refresh All
          </button>
        </div>

        <!-- Moderation Sub-tabs -->
        <div class="mod-subtabs">
          <button v-for="subtab in moderationTabs" :key="subtab.id"
            class="subtab-btn" :class="{ active: moderationSubTab === subtab.id }"
            @click="moderationSubTab = subtab.id">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path :d="subtab.icon"/></svg>
            <span>{{ subtab.label }}</span>
            <span v-if="moderationCounts[subtab.id]" class="count-badge mod-count">{{ moderationCounts[subtab.id] }}</span>
          </button>
        </div>

        <!-- REPORTS SUB-TAB -->
        <div v-if="moderationSubTab === 'reports'" class="mod-panel">
          <div class="form-card mod-filter">
            <label style="margin-right:12px">Filter:</label>
            <select v-model="reportFilter" @change="loadModReports" class="sm-input">
              <option value="all">All</option>
              <option value="pending">Pending</option>
              <option value="reviewing">Reviewing</option>
              <option value="resolved">Resolved</option>
              <option value="dismissed">Dismissed</option>
            </select>
          </div>

          <div v-if="modReportsLoading" class="center-spin"><div class="spinner"></div></div>
          <div v-else-if="modReports.length === 0" class="empty-state">No reports found</div>
          <div v-else class="reports-list">
            <div v-for="report in modReports" :key="report.id" class="report-card" :class="'severity-' + report.severity">
              <div class="report-header">
                <span class="report-id">#{{ report.id.slice(0, 8) }}</span>
                <span class="report-status" :class="report.status">{{ report.status }}</span>
                <span class="report-severity">{{ report.severity }}</span>
              </div>
              <div class="report-body">
                <p><strong>Reporter:</strong> {{ report.reporter?.username || 'Unknown' }}</p>
                <p><strong>Reason:</strong> {{ report.reason }}</p>
                <p><strong>Type:</strong> {{ report.content_type }}</p>
                <p><small>{{ fmtDate(report.created_at) }}</small></p>
              </div>
              <div class="report-actions">
                <button class="action-btn approve" @click="async () => { const {error} = await supabase.from('user_reports').update({status:'resolved'}).eq('id',report.id); if(!error) report.status='resolved' }">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 12 9 17 20 6"/></svg>
                  Approve
                </button>
                <button class="action-btn reject" @click="async () => { const {error} = await supabase.from('user_reports').update({status:'dismissed'}).eq('id',report.id); if(!error) report.status='dismissed' }">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  Reject
                </button>
              </div>
            </div>
          </div>
        </div>

        <div v-else-if="moderationSubTab === 'flagged'" class="mod-panel">
          <div v-if="flaggedContentLoading" class="center-spin"><div class="spinner"></div></div>
          <div v-else-if="flaggedContent.length === 0" class="empty-state">No flagged content</div>
          <div v-else class="flagged-list">
            <div v-for="flag in flaggedContent" :key="flag.id" class="flag-card">
              <div class="flag-header">
                <span class="flag-type">{{ flag.content_type || 'Content' }}</span>
                <span class="flag-reason">{{ flag.flag_type || 'Flagged item' }}</span>
                <span class="flag-date">{{ fmtDate(flag.created_at) }}</span>
              </div>
              <div class="flag-meta">
                <span v-if="flag.content_id">ID: {{ flag.content_id }}</span>
                <span v-if="flag.severity">Severity: {{ flag.severity }}</span>
                <span v-if="flag.flagged_by">Flagged by: {{ flag.flagged_by.slice(0, 8) }}</span>
                <span v-if="flag.auto_flagged">Auto-flagged</span>
              </div>
              <div class="flag-actions">
                <button class="action-btn approve" @click="resolveFlag(flag)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 12 9 17 20 6"/></svg>
                  Resolve
                </button>
              </div>
            </div>
          </div>
        </div>

        <div v-else-if="moderationSubTab === 'users'" class="mod-panel">
          <div class="form-card warning-tools">
            <h4>Warning reason</h4>
            <div class="warning-input">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              <input v-model="warningReasonInput" placeholder="Reason (optional)..." class="cg-input" />
              <button class="sm-btn" @click="warningReasonInput = ''">Clear</button>
            </div>
            <p class="form-hint">Optional reason used for warning and warning removal logs.</p>
          </div>

          <div v-if="moderationUsersLoading" class="center-spin"><div class="spinner"></div></div>
          <div v-else-if="moderationUsersFiltered.length === 0" class="empty-state">No warned or banned users</div>
          <div v-else class="users-mod-table">
            <div class="mod-table-header">
              <span style="flex:0.5">Warnings</span>
              <span style="flex:2">Username</span>
              <span style="flex:1">Status</span>
              <span style="flex:1.5">Actions</span>
            </div>
            <div v-for="user in moderationUsersFiltered" :key="user.id" class="mod-table-row">
              <span style="flex:0.5; font-weight:bold; color:#dc2626">{{ user.warnings_count }}</span>
              <span style="flex:2">@{{ user.username }}</span>
              <span style="flex:1" :class="{ 'text-danger': user.is_banned }">{{ user.is_banned ? 'BANNED' : 'warned' }}</span>
              <span style="flex:1.5; display:flex; gap:6px; flex-wrap:wrap;">
                <button v-if="!user.is_banned" class="micro-btn warn" @click="warnUser(user.id)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                  Warn
                </button>
                <button v-if="user.warnings_count > 0" class="micro-btn remove" @click="removeWarning(user.id)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>
                  Remove warn
                </button>
                <button v-if="!user.is_banned" class="micro-btn ban" @click="banUser(user.id, 'Admin action')">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
                  Ban
                </button>
              </span>
            </div>
          </div>
        </div>

        <div v-else-if="moderationSubTab === 'rules'" class="mod-panel">
          <div class="form-card">
            <h4>Forbidden Words</h4>
            <div style="display:flex; gap:8px; margin-bottom:12px">
              <input v-model="newForbiddenWord" placeholder="New forbidden word..." class="cg-input" style="flex:1" />
              <select v-model="newWordSeverity" class="cg-input" style="flex:0.5">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
              <button @click="addForbiddenWord" class="grant-btn" :disabled="addingForbiddenWord">
                <span v-if="addingForbiddenWord" class="mini-spin"></span>
                <span v-else>Add</span>
              </button>
            </div>

            <div v-if="forbiddenWordsLoading" class="center-spin"><div class="spinner"></div></div>
            <div v-else class="words-list">
              <div v-for="word in forbiddenWords" :key="word.id" class="word-item">
                <span class="word-text">"{{ word.word }}"</span>
                <span class="word-severity" :class="word.severity">{{ word.severity }}</span>
                <button class="toggle-btn" :class="{ on: word.enabled }" @click="toggleForbiddenWord(word)" title="Toggle status">
                  <svg v-if="word.enabled" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
                  <svg v-else viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/></svg>
                </button>
                <button class="delete-btn" @click="deleteForbiddenWord(word)" title="Delete">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- CONTENT MANAGEMENT TAB -->
      <div v-else-if="activeTab === 'content'" class="tab-section">
        <div class="section-bar">
          <h2>Content Management</h2>
          <button @click="() => { loadFeaturedContent(); loadTrendingContent(); loadCurationRules() }" class="sm-btn" title="Refresh all data">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36M20.49 15a9 9 0 0 1-14.85 3.36"/></svg>
            Refresh
          </button>
        </div>

        <!-- Featured Content -->
        <div class="content-section">
          <h3>Featured Content</h3>
          <div v-if="featuredContentLoading" class="center-spin"><div class="spinner"></div></div>
          <div v-else class="featured-list">
            <div v-for="(featured, idx) in featuredContent" :key="featured.id" class="featured-item">
              <span class="featured-position">{{ idx + 1 }}</span>
              <div class="featured-info">
                <p><strong>{{ featured.content_type }}</strong> • {{ featured.section }}</p>
                <small>{{ fmtDate(featured.featured_until) }}</small>
              </div>
              <div class="featured-stats">
                <span>Views: {{ featured.views_count }}</span>
                <span>Clicks: {{ featured.clicks_count }}</span>
              </div>
              <button class="delete-btn" @click="removeFeaturedContent(featured.id)" title="Remove">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </div>
        </div>

        <!-- Trending Content -->
        <div class="content-section" style="margin-top:20px">
          <h3>Trending Content</h3>
          <div style="display:flex; gap:8px; margin-bottom:12px">
            <select v-model="trendingTimeWindow" @change="loadTrendingContent" class="sm-input">
              <option value="24h">24 Hours</option>
              <option value="7d">7 Days</option>
              <option value="all">All Time</option>
            </select>
            <input v-model.number="trendingThreshold" type="number" placeholder="Min engagement" class="sm-input" style="width:120px" />
            <button @click="loadTrendingContent" class="sm-btn">Load</button>
          </div>
          <div v-if="trendingContentLoading" class="center-spin"><div class="spinner"></div></div>
          <div v-else class="trending-list">
            <div v-for="(trend, idx) in trendingContent.slice(0, 10)" :key="trend.id" class="trending-item">
              <span class="trend-rank">#{{ idx + 1 }}</span>
              <div class="trend-info">
                <p>{{ trend.caption?.slice(0, 60) }}...</p>
                <small>by @{{ trend.profiles?.username }}</small>
              </div>
              <span class="trend-score"><svg style="width:14px;height:14px;display:inline;margin-right:4px;vertical-align:text-bottom" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>{{ trend.engagement }}</span>
              <button class="feature-btn" @click="addFeaturedContent(trend.id)">Feature</button>
            </div>
          </div>
        </div>

        <!-- Curation Rules -->
        <div class="content-section" style="margin-top:20px">
          <h3>Curation Rules</h3>
          <div class="form-card">
            <div style="display:flex; gap:8px; margin-bottom:12px">
              <input v-model="newRuleName" placeholder="Rule name..." class="cg-input" style="flex:1" />
              <select v-model="newRuleType" class="cg-input" style="flex:0.5">
                <option value="boost">Boost</option>
                <option value="hide">Hide</option>
                <option value="recommend">Recommend</option>
              </select>
              <input v-model.number="newRuleMinEngagement" type="number" placeholder="Min engagement" class="cg-input" style="flex:0.5" />
              <button @click="addCurationRule" class="grant-btn" :disabled="addingCurationRule">Add</button>
            </div>
          </div>

          <div v-if="curationRulesLoading" class="center-spin"><div class="spinner"></div></div>
          <div v-else class="rules-table">
            <div v-for="rule in curationRules" :key="rule.id" class="rule-row">
              <span class="rule-name">{{ rule.rule_name }}</span>
              <span class="rule-type" :class="rule.rule_type">{{ rule.rule_type }}</span>
              <button class="toggle-btn" :class="{ on: rule.enabled }" @click="toggleCurationRule(rule)" title="Toggle rule status">
                <svg v-if="rule.enabled" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
                <svg v-else viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/></svg>
              </button>
              <button class="delete-btn" @click="deleteCurationRule(rule.id)" title="Delete">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- ── SETTINGS ── -->
      <div v-else-if="activeTab === 'settings'" class="tab-section">
        <div class="section-bar">
          <h2>Paramètres Globaux</h2>
        </div>
        <div class="dashboard">
          <div class="form-card" style="max-width: 600px;">
            <h3>Mode Troll IA</h3>
            <p class="form-hint">Si activé, le bouton de l'IA fuira le curseur de la souris pour piéger les utilisateurs (s'applique globalement à tout le site).</p>
            <div style="display:flex; align-items:center; gap: 12px; margin-top: 10px;">
              <span>Activer le mode Troll :</span>
              <button class="toggle-btn" :class="{ on: isTrollMode }" @click="toggleTrollMode" :disabled="savingTrollMode">
                <svg v-if="isTrollMode" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
                <svg v-else viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/></svg>
              </button>
            </div>
          </div>
        </div>
      </div>

    </div>
  </div>

  <div v-else-if="loading" class="admin-loading">
    <div class="spinner"></div>
  </div>
</template>

<style scoped>
.admin-page { display:flex; flex-direction:column; height:100%; overflow:hidden; }
.admin-tabs { display:flex; gap:2px; padding:16px 24px 0; background:white; border-bottom:1px solid #ede8ff; overflow-x:auto; flex-shrink:0; }
.tab-btn { display:flex; align-items:center; gap:7px; padding:10px 16px; background:none; border:none; border-bottom:2.5px solid transparent; font-family:'Instrument Sans',sans-serif; font-size:.85rem; font-weight:600; color:var(--text-2); cursor:pointer; white-space:nowrap; transition:all .18s; margin-bottom:-1px; }
.tab-btn svg { width:15px; height:15px; flex-shrink:0; }
.tab-btn:hover { color:var(--purple); }
.tab-btn.active { color:var(--purple); border-bottom-color:var(--purple); }
.admin-content { flex:1; overflow-y:auto; padding:24px; }
.tab-section { max-width:1100px; }

/* Stats */
.dashboard { display:flex; flex-direction:column; gap:24px; }
.stats-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:14px; }
.stat-card { background:white; border-radius:16px; padding:20px 16px; display:flex; flex-direction:column; align-items:center; gap:8px; box-shadow:0 2px 12px rgba(76,16,224,.07); cursor:pointer; transition:all .18s; }
.stat-card:hover { transform:translateY(-2px); box-shadow:0 4px 20px rgba(76,16,224,.13); }
.stat-icon { width:44px; height:44px; border-radius:12px; display:flex; align-items:center; justify-content:center; }
.stat-icon svg { width:22px; height:22px; }
.stat-icon.users { background:#eef2ff; color:#6366f1; }
.stat-icon.posts { background:#fef3c7; color:#f59e0b; }
.stat-icon.comments { background:#fce7f3; color:#ec4899; }
.stat-icon.messages { background:#dbeafe; color:#3b82f6; }
.stat-icon.groups { background:#d1fae5; color:#10b981; }
.stat-icon.global { background:#ede9fe; color:var(--purple); }
.stat-val { font-family:'Epilogue',sans-serif; font-size:1.8rem; font-weight:800; color:var(--text); }
.stat-label { font-size:.75rem; font-weight:600; color:var(--text-2); }

/* Quick actions */
.quick-actions { background:white; border-radius:16px; padding:20px; box-shadow:0 2px 12px rgba(76,16,224,.07); }
.qa-title { font-family:'Epilogue',sans-serif; font-weight:800; font-size:.95rem; color:var(--text); margin-bottom:14px; }
.qa-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:10px; }
.qa-btn { display:flex; align-items:center; gap:8px; padding:12px 16px; background:#f7f4ff; border:1.5px solid #e2d9ff; border-radius:12px; font-family:'Instrument Sans',sans-serif; font-size:.84rem; font-weight:600; color:var(--purple); cursor:pointer; transition:all .18s; }
.qa-btn svg { width:16px; height:16px; flex-shrink:0; }
.qa-btn:hover { background:#eee8ff; border-color:var(--purple); }

/* Section bar */
.section-bar { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; flex-wrap:wrap; gap:10px; }
.section-bar h2 { font-family:'Epilogue',sans-serif; font-size:1.1rem; font-weight:800; color:var(--text); display:flex; align-items:center; gap:8px; }
.section-bar-right { display:flex; align-items:center; gap:8px; }
.count-badge { background:#f0eeff; color:var(--purple); font-size:.72rem; font-weight:800; padding:2px 8px; border-radius:10px; font-family:'Instrument Sans',sans-serif; }
.search-box { display:flex; align-items:center; gap:7px; padding:7px 12px; border:1.5px solid #e2d9ff; border-radius:10px; background:white; }
.search-box svg { width:14px; height:14px; color:var(--text-2); flex-shrink:0; }
.search-box input { border:none; outline:none; font-size:.84rem; font-family:'Instrument Sans',sans-serif; min-width:150px; color:var(--text); }

/* Table */
.users-table-wrap { overflow-x:auto; border-radius:14px; box-shadow:0 2px 12px rgba(76,16,224,.07); }
.data-table { width:100%; border-collapse:collapse; background:white; border-radius:14px; overflow:hidden; }
.data-table th { padding:12px 16px; text-align:left; font-size:.75rem; font-weight:700; color:var(--text-2); text-transform:uppercase; letter-spacing:.05em; border-bottom:1px solid #f0ecff; background:#faf8ff; white-space:nowrap; }
.data-table td { padding:10px 16px; border-bottom:1px solid #f7f4ff; vertical-align:middle; }
.data-table tr:last-child td { border-bottom:none; }
.data-table tr:hover td { background:#faf8ff; }

.user-cell { display:flex; align-items:center; gap:10px; }
.user-av { width:34px; height:34px; border-radius:50%; background:var(--purple); color:white; font-size:.82rem; font-weight:700; display:flex; align-items:center; justify-content:center; overflow:hidden; flex-shrink:0; }
.user-av img { width:100%; height:100%; object-fit:cover; }
.user-cell-name { font-weight:700; font-size:.86rem; color:var(--text); }
.user-cell-id { font-size:.7rem; color:var(--text-2); cursor:pointer; font-family:monospace; }
.user-cell-id:hover { color:var(--purple); }

.badge-toggles { display:flex; gap:4px; flex-wrap:wrap; }
.badge-toggle { padding:3px 8px; border-radius:6px; border:1.5px solid #e2d9ff; background:white; font-size:.72rem; font-weight:700; cursor:pointer; color:var(--text-2); transition:all .15s; white-space:nowrap; }
.badge-toggle:hover { border-color:var(--purple); color:var(--purple); }
.badge-toggle.active { background:var(--purple); color:white; border-color:var(--purple); }
.badge-toggle.danger.active { background:#ef4444; border-color:#ef4444; }

.editable-cell { cursor:pointer; font-size:.82rem; color:var(--text-2); max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.editable-cell:hover { color:var(--purple); text-decoration:underline dotted; }
.inline-input { padding:4px 8px; border:1.5px solid var(--purple); border-radius:6px; font-size:.82rem; outline:none; }

.color-row { display:flex; align-items:center; gap:6px; }
.color-dot { width:16px; height:16px; border-radius:50%; border:2px solid #e2d9ff; flex-shrink:0; }
.color-picker { width:28px; height:28px; border-radius:6px; border:1.5px solid #e2d9ff; cursor:pointer; padding:1px; }

/* Buttons */
.action-btns { display:flex; gap:5px; }
.action-btn { width:30px; height:30px; border-radius:8px; border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all .15s; background:#f0eeff; color:var(--purple); }
.action-btn svg { width:13px; height:13px; }
.action-btn:hover { background:#e0d5ff; }
.action-btn.active { background:var(--purple); color:white; }
.action-btn.danger { background:#fff0f0; color:#e74c3c; }
.action-btn.danger:hover { background:#ffd5d5; }
.btn-purple-sm { display:inline-flex; align-items:center; gap:5px; padding:7px 14px; background:var(--purple); color:white; border:none; border-radius:8px; font-weight:700; font-size:.8rem; cursor:pointer; transition:background .18s; }
.btn-purple-sm svg { width:12px; height:12px; }
.btn-purple-sm:hover { background:var(--purple-d); }
.btn-danger-sm { padding:7px 14px; background:#fff0f0; color:#e74c3c; border:1.5px solid #fca5a5; border-radius:8px; font-weight:700; font-size:.8rem; cursor:pointer; }
.btn-danger-sm:hover { background:#ffd5d5; }
.btn-xs-green { width:24px; height:24px; border-radius:5px; border:none; background:#d1fae5; color:#10b981; cursor:pointer; font-size:.8rem; font-weight:700; }
.btn-xs-gray { width:24px; height:24px; border-radius:5px; border:none; background:#f5f3ff; color:var(--text-2); cursor:pointer; font-size:.8rem; }
.btn-purple { padding:9px 20px; background:var(--purple); color:white; border:none; border-radius:9px; font-weight:700; font-size:.85rem; cursor:pointer; }
.btn-purple:hover:not(:disabled) { background:var(--purple-d); }
.btn-purple:disabled { opacity:.4; cursor:not-allowed; }

/* Posts grid */
.posts-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:12px; }
.post-card { background:white; border-radius:12px; overflow:hidden; box-shadow:0 2px 10px rgba(76,16,224,.07); position:relative; }
.post-card-media { height:120px; background:#f0eeff; }
.post-card-media img,.post-card-media video { width:100%; height:100%; object-fit:cover; }
.post-card-no-media { display:flex; align-items:center; justify-content:center; height:100%; color:var(--text-2); font-size:.8rem; }
.post-card-info { padding:8px 10px; }
.post-card-author { font-weight:700; font-size:.78rem; color:var(--purple); }
.post-card-caption { font-size:.75rem; color:var(--text-2); margin-top:2px; line-height:1.3; }
.post-card-date { font-size:.68rem; color:var(--text-2); margin-top:4px; }
.post-card-del { position:absolute; top:6px; right:6px; width:26px; height:26px; border-radius:8px; background:rgba(0,0,0,.5); border:none; color:white; cursor:pointer; display:flex; align-items:center; justify-content:center; opacity:0; transition:opacity .15s; }
.post-card:hover .post-card-del { opacity:1; }
.post-card-del svg { width:12px; height:12px; }

/* Data list */
.data-list { display:flex; flex-direction:column; gap:6px; }
.data-row { display:flex; align-items:center; gap:12px; background:white; border-radius:12px; padding:12px 16px; box-shadow:0 1px 6px rgba(76,16,224,.06); }
.dr-avatar { width:38px; height:38px; border-radius:10px; background:var(--purple); color:white; font-weight:700; font-size:.9rem; display:flex; align-items:center; justify-content:center; overflow:hidden; flex-shrink:0; background-size:cover; background-position:center; }
.dr-avatar.sm { width:32px; height:32px; border-radius:50%; font-size:.78rem; }
.dr-avatar img { width:100%; height:100%; object-fit:cover; }
.dr-info { flex:1; min-width:0; }
.dr-name { font-weight:700; font-size:.87rem; color:var(--text); }
.dr-message { font-size:.84rem; color:var(--text); word-break:break-word; }
.dr-meta { font-size:.72rem; color:var(--text-2); margin-top:2px; }
.dr-desc { font-size:.77rem; color:var(--text-2); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ann-info .data-row { border-left:3px solid #3b82f6; }
.ann-success .data-row { border-left:3px solid #10b981; }
.ann-warning .data-row { border-left:3px solid #f59e0b; }
.ann-danger .data-row { border-left:3px solid #ef4444; }

/* Forms */
.form-card { background:white; border-radius:16px; padding:20px; box-shadow:0 2px 12px rgba(76,16,224,.07); display:flex; flex-direction:column; gap:10px; }
.form-card h3 { font-family:'Epilogue',sans-serif; font-size:.95rem; font-weight:800; color:var(--text); }
.form-hint { font-size:.78rem; color:var(--text-2); }
.form-hint code { background:#f0eeff; color:var(--purple); padding:1px 5px; border-radius:4px; font-size:.8rem; }
.form-input { padding:9px 13px; border:1.5px solid #e2d9ff; border-radius:9px; font-size:.85rem; font-family:'Instrument Sans',sans-serif; outline:none; transition:border-color .18s; }
.form-input:focus { border-color:var(--purple); }
.form-textarea { padding:9px 13px; border:1.5px solid #e2d9ff; border-radius:9px; font-size:.84rem; font-family:'Instrument Sans',sans-serif; outline:none; resize:vertical; transition:border-color .18s; }
.form-textarea:focus { border-color:var(--purple); }
.form-textarea.code { font-family:monospace; font-size:.82rem; }
.form-select { padding:8px 12px; border:1.5px solid #e2d9ff; border-radius:9px; font-size:.84rem; font-family:'Instrument Sans',sans-serif; outline:none; background:white; }
.form-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.form-label { font-size:.78rem; font-weight:700; color:var(--text-2); }

/* Broadcast sub-tabs */
.bc-subtabs { display:flex; gap:4px; margin-bottom:20px; background:#f7f4ff; border-radius:12px; padding:4px; width:fit-content; }
.bc-subtab { padding:7px 18px; border-radius:9px; border:none; font-family:'Instrument Sans',sans-serif; font-size:.83rem; font-weight:600; cursor:pointer; color:var(--text-2); background:transparent; transition:all .18s; }
.bc-subtab.active { background:white; color:var(--purple); box-shadow:0 1px 4px rgba(76,16,224,.12); }

/* SQL result */
.sql-result { background:#1e1b2e; border-radius:12px; padding:16px; overflow:auto; max-height:400px; }
.sql-result pre { color:#e2d9ff; font-family:monospace; font-size:.82rem; line-height:1.5; white-space:pre-wrap; }
.snippets { display:flex; flex-wrap:wrap; gap:8px; }
.snippet-btn { padding:6px 12px; background:#f0eeff; color:var(--purple); border:1.5px solid #e2d9ff; border-radius:8px; font-size:.78rem; font-weight:600; cursor:pointer; font-family:'Instrument Sans',sans-serif; transition:all .15s; }
.snippet-btn:hover { background:#e5daff; border-color:var(--purple); }

/* Other */
.error-banner { background:#fff0f0; color:#e74c3c; border:1px solid #fca5a5; border-radius:10px; padding:10px 14px; font-size:.84rem; }
.loading-state { display:flex; justify-content:center; padding:40px; }
.empty-state { text-align:center; color:var(--text-2); font-size:.85rem; padding:30px; }
.spinner { width:28px; height:28px; border:3px solid #e2d9ff; border-top-color:var(--purple); border-radius:50%; animation:spin .7s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
.admin-loading { display:flex; align-items:center; justify-content:center; height:100%; }

@media (max-width:768px) {
  .admin-content { padding:16px; }
  .stats-grid { grid-template-columns:repeat(2,1fr); }
  .users-table-wrap { font-size:.8rem; }
  .data-table th, .data-table td { padding:8px 10px; }
  .analytics-grid { grid-template-columns:1fr; }
}
/* ── COINS ADMIN TAB ── */
.coins-admin-layout { display:grid; grid-template-columns:340px 1fr; gap:20px; }
@media(max-width:900px) { .coins-admin-layout { grid-template-columns:1fr; } }

.coins-panel-title { display:flex; align-items:center; gap:8px; font-family:'Epilogue',sans-serif; font-size:1rem; font-weight:800; color:var(--text); margin:0 0 16px; }
.coins-grant-panel, .coins-overview-panel { background:white; border-radius:16px; padding:22px; box-shadow:0 2px 12px rgba(76,16,224,0.07); display:flex; flex-direction:column; gap:12px; }

.cg-field { display:flex; flex-direction:column; gap:5px; }
.cg-field label { font-size:0.75rem; font-weight:700; color:var(--text-2); text-transform:uppercase; letter-spacing:.05em; }
.cg-input { padding:9px 12px; border:1.5px solid #e2d9ff; border-radius:9px; font-family:'Instrument Sans',sans-serif; font-size:0.88rem; outline:none; transition:border-color .18s; background:white; }
.cg-input:focus { border-color:var(--purple); }

.coin-user-list { border:1.5px solid #e2d9ff; border-radius:10px; overflow:hidden; max-height:200px; overflow-y:auto; }
.coin-user-row { display:flex; align-items:center; gap:8px; padding:9px 12px; cursor:pointer; border-bottom:1px solid #f7f5ff; transition:background .12s; }
.coin-user-row:last-child { border-bottom:none; }
.coin-user-row:hover, .coin-user-row.selected { background:#f0eeff; }
.cu-av { width:28px; height:28px; border-radius:50%; background:var(--purple); color:white; display:flex; align-items:center; justify-content:center; font-size:0.75rem; font-weight:700; overflow:hidden; flex-shrink:0; }
.cu-av img { width:100%; height:100%; object-fit:cover; }
.cu-av.small { width:24px; height:24px; font-size:0.7rem; }
.cu-name { font-size:0.84rem; font-weight:600; flex:1; }
.cu-bal { font-size:0.75rem; color:var(--text-2); font-weight:600; }

.selected-user-card { background:#f7f4ff; border-radius:10px; padding:10px 14px; }
.suc-row { display:flex; align-items:center; gap:8px; font-size:0.85rem; color:var(--text-2); }
.suc-row strong { color:var(--text); }
.suc-bal { margin-left:auto; font-weight:700; color:var(--purple); }

.grant-result { padding:10px 14px; border-radius:9px; font-size:0.85rem; font-weight:600; }
.grant-result.ok { background:#f0fdf4; color:#15803d; border:1px solid #22c55e; }
.grant-result.err { background:#fff0f0; color:#b91c1c; border:1px solid #fca5a5; }

.grant-btn { display:flex; align-items:center; justify-content:center; gap:8px; padding:11px; background:linear-gradient(135deg,#fbbf24,#f97316); color:white; border:none; border-radius:11px; font-weight:700; font-size:0.9rem; cursor:pointer; transition:opacity .15s; }
.grant-btn:disabled { opacity:0.4; cursor:not-allowed; }
.mini-spin { width:13px; height:13px; border:2px solid rgba(255,255,255,0.35); border-top-color:white; border-radius:50%; animation:spin .6s linear infinite; display:inline-block; }

/* Coin overview list */
.coin-overview-list { display:flex; flex-direction:column; gap:2px; max-height:460px; overflow-y:auto; }
.co-row { display:flex; align-items:center; gap:10px; padding:10px 8px; border-radius:9px; transition:background .12s; }
.co-row:hover { background:#f7f4ff; }
.co-info { flex:1; display:flex; flex-direction:column; gap:3px; min-width:0; }
.co-name { font-size:0.84rem; font-weight:600; color:var(--text); }
.co-subs { display:flex; gap:5px; flex-wrap:wrap; }
.co-sub-chip { font-size:0.68rem; font-weight:700; padding:2px 7px; border-radius:8px; }
.co-sub-chip.premium  { background:#fffbeb; color:#b45309; }
.co-sub-chip.official { background:#eff6ff; color:#1d4ed8; }
.co-bal { font-family:'Epilogue',sans-serif; font-weight:800; font-size:0.9rem; color:var(--purple); white-space:nowrap; }

.co-perms { display:flex; gap:4px; }
.perm-toggle { padding:3px 7px; border-radius:7px; border:1.5px solid #e2d9ff; background:none; font-size:0.72rem; font-weight:700; cursor:pointer; color:#aaa; transition:all .15s; }
.perm-toggle.on { background:#fffbeb; color:#b45309; border-color:#fbbf24; }
.perm-toggle.official.on { background:#eff6ff; color:#1d4ed8; border-color:#3b82f6; }

.center-spin { display:flex; justify-content:center; padding:30px; }

/* ── ANALYTICS STYLES ── */
.analytics-cards { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px; margin-bottom:20px; }
.analytics-cards .stat-card { display:flex; align-items:center; gap:12px; padding:16px; background:#f7f4ff; border-radius:12px; border:1.5px solid #ede9fe; }
.analytics-cards .stat-icon { font-size:1.8rem; width:32px; height:32px; flex-shrink:0; color:var(--purple); display:block; border-radius:0; }
.analytics-cards .stat-icon svg { width:100%; height:100%; }
.analytics-cards .stat-content { flex:1; }
.analytics-cards .stat-label { font-size:0.75rem; color:var(--text-2); text-transform:uppercase; font-weight:600; }
.analytics-cards .stat-value { font-size:1.5rem; font-weight:800; color:var(--purple); margin-top:4px; }

.analytics-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
.chart-card { background:white; border:1.5px solid #ede9fe; border-radius:12px; padding:16px; }
.chart-card h4 { margin:0 0 12px 0; font-size:0.9rem; font-weight:700; }

.breakdown-chart { display:flex; flex-direction:column; gap:8px; }
.breakdown-item { display:flex; align-items:center; gap:8px; font-size:0.8rem; }
.breakdown-label { flex:0 0 70px; font-weight:600; }
.breakdown-bar { height:20px; border-radius:6px; flex:1; }
.breakdown-count { flex:0 0 40px; text-align:right; font-weight:600; color:var(--purple); }

.analytics-table { display:flex; flex-direction:column; gap:2px; max-height:300px; overflow-y:auto; }
.table-row { display:flex; align-items:center; gap:8px; padding:8px; border-radius:8px; font-size:0.85rem; }
.table-row:hover { background:#f7f4ff; }
.rank { font-weight:700; color:var(--purple); flex:0 0 25px; }
.avatar-sm { width:28px; height:28px; border-radius:50%; object-fit:cover; }
.avatar-sm.placeholder { display:flex; align-items:center; justify-content:center; background:var(--purple); color:white; font-size:0.75rem; font-weight:700; }
.creator-name { flex:1; font-weight:600; }
.creator-stats { font-size:0.75rem; color:var(--text-2); }

/* ── MODERATION STYLES ── */
.mod-subtabs { display:flex; gap:6px; margin-bottom:16px; background:#f7f4ff; border-radius:12px; padding:4px; width:fit-content; flex-wrap:wrap; }
.subtab-btn { display:inline-flex; align-items:center; gap:6px; padding:7px 14px; background:transparent; border:none; font-size:0.82rem; font-weight:600; color:var(--text-2); cursor:pointer; border-radius:9px; transition:all .15s; }
.subtab-btn svg { width:14px; height:14px; }
.subtab-btn.active { background:white; color:var(--purple); box-shadow:0 1px 4px rgba(76,16,224,.12); }
.mod-count { font-size:0.68rem; padding:1px 6px; border-radius:10px; }
.mod-panel { display:flex; flex-direction:column; gap:12px; margin-top:16px; }

.reports-list { display:flex; flex-direction:column; gap:12px; }
.report-card { border:1.5px solid #ede9fe; border-left:6px solid #fbbf24; border-radius:8px; padding:12px; background:white; }
.report-card.severity-high { border-left-color:#ef4444; }
.report-card.severity-critical { border-left-color:#7c2d12; background:#fff5f4; }
.report-header { display:flex; gap:8px; align-items:center; margin-bottom:8px; }
.report-id { font-size:0.7rem; font-weight:700; color:var(--text-2); }
.report-status { padding:2px 8px; border-radius:6px; font-size:0.7rem; font-weight:700; background:#dbeafe; color:#1d4ed8; }
.report-status.resolved { background:#dcfce7; color:#15803d; }
.report-severity { padding:2px 8px; border-radius:6px; font-size:0.7rem; font-weight:700; text-transform:uppercase; background:#fef3c7; color:#92400e; }
.report-body { font-size:0.8rem; margin-bottom:8px; }
.report-body p { margin:4px 0; }
.report-actions { display:flex; gap:6px; }
.report-actions .action-btn,
.flag-actions .action-btn { display:inline-flex; align-items:center; gap:6px; padding:4px 12px; border:1px solid #ede9fe; border-radius:6px; font-size:0.75rem; font-weight:600; cursor:pointer; background:white; width:auto; height:auto; }
.report-actions .action-btn svg,
.flag-actions .action-btn svg { width:14px; height:14px; }
.report-actions .action-btn.approve,
.flag-actions .action-btn.approve { background:#dcfce7; color:#15803d; border-color:#bbf7d0; }
.report-actions .action-btn.reject { background:#fee2e2; color:#991b1b; border-color:#fecaca; }

.users-mod-table { border:1.5px solid #ede9fe; border-radius:8px; overflow:hidden; }
.mod-table-header { display:flex; padding:12px; background:#f7f4ff; font-weight:700; font-size:0.8rem; border-bottom:1.5px solid #ede9fe; }
.mod-table-row { display:flex; padding:10px 12px; align-items:center; border-bottom:1px solid #ede9fe; font-size:0.85rem; }
.mod-table-row:last-child { border-bottom:none; }
.text-danger { color:#dc2626; font-weight:700; }

.warning-tools { gap:8px; }
.warning-input { display:flex; align-items:center; gap:8px; }
.warning-input svg { width:18px; height:18px; color:var(--purple); }
.warning-input .cg-input { flex:1; }

.flagged-list { display:flex; flex-direction:column; gap:10px; }
.flag-card { border:1.5px solid #ede9fe; border-radius:10px; padding:12px; background:white; display:flex; flex-direction:column; gap:8px; }
.flag-header { display:flex; flex-wrap:wrap; gap:8px; align-items:center; font-size:0.8rem; font-weight:700; }
.flag-type { background:#ede9fe; color:var(--purple); padding:2px 8px; border-radius:6px; font-size:0.7rem; text-transform:uppercase; }
.flag-reason { flex:1; font-size:0.8rem; color:var(--text); }
.flag-date { font-size:0.72rem; color:var(--text-2); }
.flag-meta { display:flex; gap:12px; flex-wrap:wrap; font-size:0.75rem; color:var(--text-2); }
.flag-actions { display:flex; gap:6px; }

.words-list { display:flex; flex-direction:column; gap:6px; max-height:300px; overflow-y:auto; }
.word-item { display:flex; align-items:center; gap:8px; padding:8px; background:#f7f4ff; border-radius:8px; font-size:0.8rem; }
.word-text { flex:1; font-weight:600; font-family:monospace; }
.word-severity { padding:2px 8px; border-radius:4px; font-size:0.7rem; font-weight:700; text-transform:uppercase; }
.word-severity.low { background:#e0f2fe; color:#0369a1; }
.word-severity.medium { background:#fef3c7; color:#92400e; }
.word-severity.high { background:#fecaca; color:#991b1b; }
.word-severity.critical { background:#fed7aa; color:#7c2d12; }

.micro-btn { display:inline-flex; align-items:center; gap:4px; padding:2px 6px; font-size:0.7rem; border:1px solid #e5e7eb; border-radius:4px; cursor:pointer; transition:all .12s; }
.micro-btn svg { width:12px; height:12px; }
.micro-btn.warn { background:#fef3c7; color:#92400e; border-color:#fcd34d; }
.micro-btn.ban { background:#fecaca; color:#991b1b; border-color:#fca5a5; }
.micro-btn.remove { background:#e0f2fe; color:#0369a1; border-color:#7dd3fc; }
.micro-btn:hover { opacity:0.8; }

/* ── CONTENT MANAGEMENT STYLES ── */
.content-section { background:white; border:1.5px solid #ede9fe; border-radius:12px; padding:16px; }
.content-section h3 { margin:0 0 12px 0; font-size:0.9rem; font-weight:700; }

.featured-list { display:flex; flex-direction:column; gap:8px; max-height:400px; overflow-y:auto; }
.featured-item { display:flex; align-items:center; gap:12px; padding:10px; background:#f7f4ff; border-radius:8px; border:1px solid #ede9fe; }
.featured-position { font-weight:800; color:var(--purple); font-size:1.1rem; flex:0 0 25px; }
.featured-info { flex:1; font-size:0.85rem; }
.featured-info p { margin:4px 0; font-weight:500; }
.featured-info small { color:var(--text-2); }
.post-card-stats { display:flex; gap:12px; font-size:0.65rem; font-weight:700; color:var(--text-2); margin-bottom:4px; }
.post-card-stats span { display: flex; align-items: center; }
.delete-btn { padding:4px 8px; border:1px solid #ede9fe; border-radius:6px; background:none; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; color:var(--text-2); transition:all .12s; }
.delete-btn svg { width:16px; height:16px; }
.delete-btn:hover { color:#dc2626; border-color:#fca5a5; }

.trending-list { display:flex; flex-direction:column; gap:8px; max-height:400px; overflow-y:auto; }
.trending-item { display:flex; align-items:center; gap:12px; padding:10px; background:#f7f4ff; border-radius:8px; border:1px solid #ede9fe; }
.trend-rank { font-weight:800; color:var(--purple); font-size:0.9rem; flex:0 0 30px; }
.trend-info { flex:1; font-size:0.8rem; }
.trend-info p { margin:4px 0; font-weight:500; }
.trend-info small { color:var(--text-2); }
.trend-score { font-weight:700; color:var(--purple); flex:0 0 50px; text-align:right; }
.feature-btn { padding:4px 12px; background:var(--purple); color:white; border:none; border-radius:6px; font-size:0.75rem; font-weight:600; cursor:pointer; }
.feature-btn:hover { opacity:0.9; }

.rules-table { display:flex; flex-direction:column; gap:6px; }
.rule-row { display:flex; align-items:center; gap:12px; padding:10px; background:#f7f4ff; border-radius:8px; border:1px solid #ede9fe; }
.rule-name { flex:1; font-weight:600; font-size:0.85rem; }
.rule-type { padding:2px 8px; border-radius:6px; font-size:0.7rem; font-weight:700; text-transform:uppercase; }
.rule-type.boost { background:#dcfce7; color:#15803d; }
.rule-type.hide { background:#fee2e2; color:#991b1b; }
.rule-type.recommend { background:#dbeafe; color:#1d4ed8; }

.toggle-btn { padding:4px 8px; border:1px solid #ede9fe; border-radius:6px; background:white; color:var(--text-2); font-weight:700; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; }
.toggle-btn svg { width:16px; height:16px; }
.toggle-btn.on { background:var(--purple); color:white; border-color:var(--purple); }

.empty-state { text-align:center; padding:30px; color:var(--text-2); font-size:0.85rem; }

/* Small input and button styles */
.sm-input { padding:7px 12px; border:1.5px solid #e2d9ff; border-radius:8px; font-size:0.83rem; font-family:'Instrument Sans',sans-serif; outline:none; transition:border-color .15s; background:white; }
.sm-input:focus { border-color:var(--purple); }
.sm-btn { display:inline-flex; align-items:center; gap:5px; padding:7px 14px; background:var(--purple); color:white; border:none; border-radius:8px; font-weight:600; font-size:0.8rem; cursor:pointer; transition:background .18s; }
.sm-btn svg { width:12px; height:12px; }
.sm-btn:hover { background:var(--purple-d); }
.sm-btn:disabled { opacity:0.5; cursor:not-allowed; }

/* Hide scrollbars for Admin Panel */
.admin-page {
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.admin-page::-webkit-scrollbar {
  display: none;
}
.admin-content {
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.admin-content::-webkit-scrollbar {
  display: none;
}

/* Fix Admin Tabs Scrollbar and Layout */
.admin-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 20px;
  background: white;
  border-bottom: 1px solid #ede8ff;
  overflow-x: hidden; /* Prevent the scrollbar */
}
.tab-btn {
  padding: 6px 12px;
  font-size: 0.78rem;
  background: #f8f6ff;
  border: 1px solid #ede8ff;
  border-radius: 8px;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-2);
  cursor: pointer;
  transition: all 0.15s;
}
.tab-btn.active {
  background: var(--purple);
  color: white;
  border-color: var(--purple);
  box-shadow: 0 4px 12px rgba(76,16,224,0.15);
}
.tab-btn svg {
  width: 14px;
  height: 14px;
}
</style>
