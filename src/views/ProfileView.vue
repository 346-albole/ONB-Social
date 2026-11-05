<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { supabase } from '../lib/supabaseClient'
import { getCurrentSession } from '../lib/authStore'
import { withTimeout } from '../lib/withTimeout'
import { areNotifsEnabled, setNotifsEnabled, getPermissionStatus } from '../lib/pushNotifications'

const emit = defineEmits(['profile-updated'])

const profile     = ref({ username: '', avatar_url: null, bio: '', is_premium: false, is_official: false, username_color: null, banner_color: null, chat_bg_url: null, custom_badge_url: null })
const authUser    = ref(null)
const userPosts   = ref([]
)
const isEditing   = ref(false)
const editUsername  = ref('')
const editBio       = ref('')
const editUsernameColor = ref('')
const editBannerColor   = ref('')
const loading     = ref(true)
const saving      = ref(false)
const saveError   = ref('')
const saveSuccess = ref(false)
const hasBioCol   = ref(false)

const followersCount = ref(0)
const followingCount = ref(0)
const followersList  = ref([])
const followingList  = ref([])
const showModal      = ref(null)
const loadingModal   = ref(false)

const BANNER_PRESETS = [
  { label: 'Default',  value: 'linear-gradient(135deg, #4C10E0 0%, #9b5cf6 100%)' },
  { label: 'Sunset',   value: 'linear-gradient(135deg, #f97316 0%, #ec4899 100%)' },
  { label: 'Ocean',    value: 'linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%)' },
  { label: 'Forest',   value: 'linear-gradient(135deg, #16a34a 0%, #0ea5e9 100%)' },
  { label: 'Rose',     value: 'linear-gradient(135deg, #f43f5e 0%, #a855f7 100%)' },
  { label: 'Gold',     value: 'linear-gradient(135deg, #ca8a04 0%, #f97316 100%)' },
  { label: 'Midnight', value: 'linear-gradient(135deg, #1e1b4b 0%, #4C10E0 100%)' },
  { label: 'Candy',    value: 'linear-gradient(135deg, #ec4899 0%, #f9a8d4 100%)' },
]

const USERNAME_COLORS = [
  { label: 'Default',  value: '' },
  { label: 'Purple',   value: '#7c3aed' },
  { label: 'Gold',     value: '#ca8a04' },
  { label: 'Red',      value: '#dc2626' },
  { label: 'Pink',     value: '#db2777' },
  { label: 'Teal',     value: '#0d9488' },
  { label: 'Orange',   value: '#ea580c' },
  { label: 'Indigo',   value: '#4338ca' },
]

async function fetchProfileData() {
  loading.value = true
  try {
    const session = getCurrentSession()
    if (!session?.user) { return }
    authUser.value = session.user

    const { data: p, error: pErr } = await supabase
      .from('profiles').select('*').eq('id', session.user.id).maybeSingle()
    if (pErr) { console.error(pErr); return }

    if (p) {
      profile.value = p
      hasBioCol.value = 'bio' in p
    } else {
      const { data: c } = await supabase.from('profiles')
        .insert({ id: session.user.id, username: '', updated_at: new Date().toISOString() })
        .select().maybeSingle()
      if (c) { profile.value = c; hasBioCol.value = 'bio' in c }
    }
    editUsername.value      = profile.value.username || ''
    editBio.value           = profile.value.bio || ''
    editUsernameColor.value = profile.value.username_color || ''
    editBannerColor.value   = profile.value.banner_color || BANNER_PRESETS[0].value

    const [postsRes, fcRes, ingRes] = await Promise.all([
      supabase.from('posts').select('*, likes(count)').eq('user_id', session.user.id).order('created_at', { ascending: false }),
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', session.user.id),
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', session.user.id),
    ])
    if (postsRes.data) userPosts.value = postsRes.data
    followersCount.value = fcRes.count || 0
    followingCount.value = ingRes.count || 0
  } catch (err) {
    console.error('fetchProfileData error:', err)
  } finally {
    loading.value = false
  }
}

async function openModal(type) {
  showModal.value = type
  loadingModal.value = true
  try {
    const uid = authUser.value.id
    if (type === 'followers') {
      const res = await withTimeout(
        supabase.from('follows').select('follower_id').eq('following_id', uid), 8000)
      const ids = res?.data?.map(r => r.follower_id) || []
      if (ids.length) {
        const pRes = await withTimeout(
          supabase.from('profiles').select('id, username, avatar_url, is_premium, username_color').in('id', ids), 8000)
        followersList.value = pRes?.data || []
      } else followersList.value = []
    } else {
      const res = await withTimeout(
        supabase.from('follows').select('following_id').eq('follower_id', uid), 8000)
      const ids = res?.data?.map(r => r.following_id) || []
      if (ids.length) {
        const pRes = await withTimeout(
          supabase.from('profiles').select('id, username, avatar_url, is_premium, username_color').in('id', ids), 8000)
        followingList.value = pRes?.data || []
      } else followingList.value = []
    }
  } catch (e) {
    console.warn('openModal error:', e)
  } finally {
    loadingModal.value = false
  }
}

async function updateProfile() {
  saving.value = true
  saveError.value = ''
  saveSuccess.value = false

  const payload = { username: editUsername.value.trim(), updated_at: new Date().toISOString() }
  if (hasBioCol.value) payload.bio = editBio.value.trim()
  if (isPremium.value && 'username_color' in profile.value) payload.username_color = editUsernameColor.value
  if (isPremium.value && 'banner_color' in profile.value)   payload.banner_color   = editBannerColor.value

  const { data: updated, error } = await supabase.from('profiles')
    .update(payload).eq('id', authUser.value.id).select().maybeSingle()

  if (error) {
    saveError.value = error.message
  } else if (updated) {
    profile.value = updated
    editUsername.value      = updated.username || ''
    editBio.value           = updated.bio || ''
    editUsernameColor.value = updated.username_color || ''
    editBannerColor.value   = updated.banner_color || BANNER_PRESETS[0].value
    isEditing.value = false
    saveSuccess.value = true
    setTimeout(() => saveSuccess.value = false, 3000)
    emit('profile-updated', { username: updated.username, avatar_url: updated.avatar_url, username_color: updated.username_color })
  } else {
    saveError.value = 'Save blocked — check Supabase RLS UPDATE policy on profiles.'
  }
  saving.value = false
}

async function uploadAvatar(e) {
  const file = e.target.files[0]
  if (!file) return
  const isVideo = file.type.startsWith('video/')
  if (isVideo && !isPremium.value) { alert('Video avatars require Premium.'); return }
  saving.value = true
  const ext = file.name.split('.').pop()
  const fileName = `avatars/${authUser.value.id}_${Date.now()}.${ext}`
  const { error: upErr } = await supabase.storage.from('media').upload(fileName, file)
  if (upErr) { saving.value = false; return }
  const { data: { publicUrl } } = supabase.storage.from('media').getPublicUrl(fileName)
  const { data: updated } = await supabase.from('profiles')
    .update({ avatar_url: publicUrl, updated_at: new Date().toISOString() })
    .eq('id', authUser.value.id).select().maybeSingle()
  if (updated) {
    profile.value.avatar_url = updated.avatar_url
    emit('profile-updated', { username: profile.value.username, avatar_url: updated.avatar_url })
  }
  saving.value = false
}

async function uploadChatBg(e) {
  const file = e.target.files[0]
  if (!file || !isPremium.value) return
  saving.value = true
  const fileName = `chatbg/${authUser.value.id}_${Date.now()}`
  const { error: upErr } = await supabase.storage.from('media').upload(fileName, file)
  if (upErr) { saving.value = false; return }
  const { data: { publicUrl } } = supabase.storage.from('media').getPublicUrl(fileName)
  const { data: updated } = await supabase.from('profiles')
    .update({ chat_bg_url: publicUrl, updated_at: new Date().toISOString() })
    .eq('id', authUser.value.id).select().maybeSingle()
  if (updated) {
    profile.value.chat_bg_url = updated.chat_bg_url
    emit('profile-updated', { username: profile.value.username, avatar_url: profile.value.avatar_url, chat_bg_url: updated.chat_bg_url })
  }
  saving.value = false
  e.target.value = ''
}

async function removeChatBg() {
  saving.value = true
  const { data: updated } = await supabase.from('profiles')
    .update({ chat_bg_url: null, updated_at: new Date().toISOString() })
    .eq('id', authUser.value.id).select().maybeSingle()
  if (updated) profile.value.chat_bg_url = null
  saving.value = false
}

async function uploadBannerImage(e) {
  const file = e.target.files[0]
  if (!file || !isPremium.value) return
  saving.value = true
  const fn = `banners/${authUser.value.id}_${Date.now()}`
  const { error: upErr } = await supabase.storage.from('media').upload(fn, file)
  if (upErr) { saving.value = false; return }
  const { data: { publicUrl } } = supabase.storage.from('media').getPublicUrl(fn)
  const { data: updated } = await supabase.from('profiles')
    .update({ banner_url: publicUrl, updated_at: new Date().toISOString() })
    .eq('id', authUser.value.id).select().maybeSingle()
  if (updated) profile.value.banner_url = updated.banner_url
  saving.value = false
  e.target.value = ''
}

async function removeBannerImage() {
  saving.value = true
  const { data: updated } = await supabase.from('profiles')
    .update({ banner_url: null, updated_at: new Date().toISOString() })
    .eq('id', authUser.value.id).select().maybeSingle()
  if (updated) profile.value.banner_url = null
  saving.value = false
}

async function uploadCustomBadge(e) {
  const file = e.target.files[0]
  if (!file || !isPremium.value) return
  saving.value = true
  const fn = `badges/${authUser.value.id}_${Date.now()}`
  const { error: upErr } = await supabase.storage.from('media').upload(fn, file)
  if (upErr) { saving.value = false; alert(upErr.message); return }
  const { data: { publicUrl } } = supabase.storage.from('media').getPublicUrl(fn)
  const { data: updated } = await supabase.from('profiles')
    .update({ custom_badge_url: publicUrl, updated_at: new Date().toISOString() })
    .eq('id', authUser.value.id).select().maybeSingle()
  if (updated) profile.value.custom_badge_url = updated.custom_badge_url
  saving.value = false
  e.target.value = ''
}

async function removeCustomBadge() {
  saving.value = true
  await supabase.from('profiles')
    .update({ custom_badge_url: null, updated_at: new Date().toISOString() })
    .eq('id', authUser.value.id)
  profile.value.custom_badge_url = null
  saving.value = false
}

const isPremium    = computed(() => profile.value.is_premium === true)
const avatarIsVideo = computed(() => profile.value.avatar_url && /\.(mp4|webm|mov)(\?|$)/i.test(profile.value.avatar_url))
const displayName  = () => profile.value.username || authUser.value?.email?.split('@')[0] || 'unnamed'
const modalList    = () => showModal.value === 'followers' ? followersList.value : followingList.value
const totalLikes   = () => userPosts.value.reduce((s, p) => s + (p.likes?.[0]?.count || 0), 0)
const bannerStyle  = computed(() => {
  if (profile.value.banner_url) return { backgroundImage: `url(${profile.value.banner_url})`, backgroundSize: 'cover', backgroundPosition: 'center' }
  return { background: profile.value.banner_color || BANNER_PRESETS[0].value }
})
const usernameStyle = computed(() => profile.value.username_color ? { color: profile.value.username_color } : {})

// ── Notification preferences ──────────────────────────────────────────────
// Prefs DB (messages / groupes)
const notifPrefs     = ref({ messages: true, groups: true })
const notifPrefsSaving = ref(false)
const notifPrefsSaved  = ref(false)

// Browser notifications (localStorage)
const browserNotifsOn  = ref(areNotifsEnabled())
const permStatus       = ref(getPermissionStatus())

async function fetchNotifPrefs() {
  const session = getCurrentSession()
  if (!session?.user) return
  const { data } = await supabase
    .from('notification_preferences')
    .select('messages, groups')
    .eq('user_id', session.user.id)
    .maybeSingle()
  if (data) {
    notifPrefs.value = {
      messages: data.messages ?? true,
      groups:   data.groups   ?? true,
    }
  }
}

async function toggleBrowserNotifs() {
  const result = await setNotifsEnabled(!browserNotifsOn.value)
  browserNotifsOn.value = result
  permStatus.value = getPermissionStatus()
}

async function saveNotifPrefs() {
  const session = getCurrentSession()
  if (!session?.user) return
  notifPrefsSaving.value = true
  notifPrefsSaved.value = false
  const { error } = await supabase.from('notification_preferences').upsert({
    user_id:  session.user.id,
    messages: notifPrefs.value.messages,
    groups:   notifPrefs.value.groups,
  }, { onConflict: 'user_id' })
  notifPrefsSaving.value = false
  if (!error) {
    notifPrefsSaved.value = true
    setTimeout(() => { notifPrefsSaved.value = false }, 2500)
  }
}

let _profileVisHandler = null
onMounted(() => {
  fetchProfileData()
  fetchNotifPrefs()
  _profileVisHandler = () => { if (document.visibilityState === 'visible') fetchProfileData() }
  document.addEventListener('visibilitychange', _profileVisHandler)
})
onUnmounted(() => {
  if (_profileVisHandler) document.removeEventListener('visibilitychange', _profileVisHandler)
})
</script>

<template>
  <div class="profile-page">
    <div v-if="loading" class="loading"><div class="spinner"></div></div>

    <div v-else>
      <div class="hero">
        <!-- Banner — uses custom color for premium -->
        <div class="hero-banner" :style="bannerStyle"></div>

        <div class="hero-body">
          <!-- Avatar -->
          <div class="av-wrap">
            <div class="big-av" :class="{ 'av-premium': isPremium }">
              <video v-if="avatarIsVideo" :src="profile.avatar_url" autoplay loop muted playsinline class="av-media" />
              <img   v-else-if="profile.avatar_url" :src="profile.avatar_url" alt="avatar" class="av-media" />
              <span  v-else>{{ displayName().charAt(0).toUpperCase() }}</span>
            </div>
            <!-- Premium crown -->
            <div v-if="isPremium" class="crown-badge" title="Premium">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M2 19l2-9 5 4 3-8 3 8 5-4 2 9H2z"/></svg>
            </div>
            <label v-if="isEditing" class="av-btn" :class="{ dim: saving }">
              <input type="file" @change="uploadAvatar" :accept="isPremium ? 'image/*,video/*' : 'image/*'" hidden :disabled="saving" />
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
            </label>
          </div>

          <!-- Info -->
          <div class="hero-right">
            <div class="hero-top">
              <div>
                <div class="dname-row">
                  <h2 class="dname" :style="usernameStyle">{{ displayName() }}</h2>
                  <!-- Official badge — always shown if official -->
                  <span v-if="profile.is_official" class="official-icon" title="Official Account">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"/></svg>
                  </span>
                  <!-- Premium icon — always shown if premium (even if also official) -->
                  <span v-if="isPremium" class="premium-icon" title="Premium member">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                  </span>
                  <!-- Custom badge — shown if premium and uploaded -->
                  <span v-if="isPremium && profile.custom_badge_url" class="custom-badge-icon" title="Custom badge">
                    <img :src="profile.custom_badge_url" alt="badge" />
                  </span>
                </div>
                <p class="demail">{{ authUser?.email }}</p>
              </div>
              <div class="hero-actions">
                <button v-if="!isEditing" class="btn-edit" @click="isEditing = true; saveError = ''">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  Edit Profile
                </button>
                <template v-else>
                  <button class="btn-cancel" @click="isEditing = false; saveError = ''; editUsername = profile.username || ''">Cancel</button>
                  <button class="btn-save" @click="updateProfile" :disabled="saving">
                    <span v-if="saving" class="btn-spin"></span>
                    {{ saving ? 'Saving…' : 'Save Changes' }}
                  </button>
                </template>
              </div>
            </div>

            <p v-if="!isEditing && profile.bio" class="bio-text">{{ profile.bio }}</p>
            <p v-else-if="!isEditing" class="bio-empty">No bio yet</p>

            <div class="stats">
              <div class="stat"><span class="sv">{{ userPosts.length }}</span><span class="sl">Posts</span></div>
              <div class="stat-div"></div>
              <div class="stat"><span class="sv">{{ totalLikes() }}</span><span class="sl">Likes</span></div>
              <div class="stat-div"></div>
              <button class="stat stat-btn" @click="openModal('followers')"><span class="sv">{{ followersCount }}</span><span class="sl">Followers</span></button>
              <div class="stat-div"></div>
              <button class="stat stat-btn" @click="openModal('following')"><span class="sv">{{ followingCount }}</span><span class="sl">Following</span></button>
            </div>
          </div>
        </div>

        <!-- Edit form -->
        <div v-if="isEditing" class="edit-panel">
          <div class="edit-grid">
            <div class="efield">
              <label>Username</label>
              <input v-model="editUsername" type="text" placeholder="yourhandle" />
            </div>
            <div v-if="hasBioCol" class="efield efield-wide">
              <label>Bio</label>
              <textarea v-model="editBio" placeholder="Tell people about yourself…" rows="2"></textarea>
            </div>
          </div>

          <!-- Premium customisation block -->
          <div v-if="isPremium" class="premium-section">
            <div class="premium-section-title">
              <svg viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px;color:#ca8a04"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
              Premium Customisation
            </div>

            <!-- Username colour -->
            <div class="pref-row">
              <span class="pref-label">Username colour</span>
              <div class="color-swatches">
                <button
                  v-for="c in USERNAME_COLORS" :key="c.value"
                  class="swatch"
                  :class="{ active: editUsernameColor === c.value }"
                  :style="c.value ? { background: c.value } : {}"
                  :title="c.label"
                  @click="editUsernameColor = c.value"
                >
                  <span v-if="!c.value" class="swatch-default">A</span>
                </button>
              </div>
              <span class="pref-preview" :style="editUsernameColor ? { color: editUsernameColor } : {}">
                {{ editUsername || 'Preview' }}
              </span>
            </div>

            <!-- Banner image upload (premium) -->
            <div class="pref-row">
              <span class="pref-label">Banner image</span>
              <div class="chatbg-controls">
                <div v-if="profile.banner_url" class="chatbg-preview">
                  <img :src="profile.banner_url" alt="Banner" />
                  <button class="chatbg-remove" @click="removeBannerImage" title="Remove">×</button>
                </div>
                <label class="chatbg-upload-btn">
                  <input type="file" accept="image/*" @change="uploadBannerImage" hidden :disabled="saving" />
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                  {{ profile.banner_url ? 'Change' : 'Upload image' }}
                </label>
                <span class="pref-note">Overrides gradient</span>
              </div>
            </div>

            <!-- Custom badge upload (premium) -->
            <div class="pref-row">
              <span class="pref-label">Custom badge</span>
              <div class="chatbg-controls">
                <div v-if="profile.custom_badge_url" class="badge-preview-wrap">
                  <img :src="profile.custom_badge_url" class="badge-preview-img" alt="Your badge" />
                  <button class="chatbg-remove" @click="removeCustomBadge" title="Remove">×</button>
                </div>
                <label class="chatbg-upload-btn">
                  <input type="file" accept="image/png,image/webp,image/gif,image/svg+xml,image/jpeg" @change="uploadCustomBadge" hidden :disabled="saving" />
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                  {{ profile.custom_badge_url ? 'Change badge' : 'Upload badge' }}
                </label>
                <span class="pref-note">PNG/WebP/GIF — shown next to your name</span>
              </div>
            </div>

            <!-- Banner colour -->
            <div class="pref-row">
              <span class="pref-label">Banner style</span>
              <div class="banner-presets">
                <button
                  v-for="b in BANNER_PRESETS" :key="b.value"
                  class="banner-swatch"
                  :class="{ active: editBannerColor === b.value }"
                  :style="{ background: b.value }"
                  :title="b.label"
                  @click="editBannerColor = b.value"
                ></button>
              </div>
            </div>

            <!-- Chat background upload -->
            <div class="pref-row">
              <span class="pref-label">Chat background</span>
              <div class="chatbg-controls">
                <div v-if="profile.chat_bg_url" class="chatbg-preview">
                  <img :src="profile.chat_bg_url" alt="Chat BG" />
                  <button class="chatbg-remove" @click="removeChatBg" title="Remove">×</button>
                </div>
                <label class="chatbg-upload-btn">
                  <input type="file" accept="image/*" @change="uploadChatBg" hidden :disabled="saving" />
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                  {{ profile.chat_bg_url ? 'Change' : 'Upload image' }}
                </label>
              </div>
            </div>
          </div>

          <div v-if="saveError" class="err-msg">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px;flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            {{ saveError }}
          </div>
        </div>

        <transition name="toast">
          <div v-if="saveSuccess" class="success-toast">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:14px;height:14px"><polyline points="20 6 9 17 4 12"/></svg>
            Profile updated!
          </div>
        </transition>
      </div>

      <!-- Notification preferences — compact -->
      <div class="notif-prefs-section">
        <div class="notif-prefs-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
          <span>Notifications</span>
          <span v-if="notifPrefsSaved" class="notif-saved-badge">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="width:10px;height:10px;margin-right:2px"><polyline points="20 6 9 17 4 12"/></svg>
            Enregistré
          </span>
        </div>

        <!-- Row 1: browser activation (master toggle) -->
        <div class="notif-pref-row notif-browser-row">
          <div class="notif-pref-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
            <div>
              <p>Browser notifications</p>
              <small v-if="permStatus === 'denied'" class="perm-denied">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;display:inline;vertical-align:text-bottom;margin-right:2px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                Blocked in browser — allow in site settings
              </small>
              <small v-else-if="permStatus === 'granted' && browserNotifsOn">Active — you will receive alerts even when the tab is closed</small>
              <small v-else>Enable to receive alerts outside the tab</small>
            </div>
          </div>
          <button
            class="toggle-btn"
            :class="{ active: browserNotifsOn, disabled: permStatus === 'denied' }"
            :disabled="permStatus === 'denied'"
            @click="toggleBrowserNotifs"
          ><span class="toggle-knob"></span></button>
        </div>

        <!-- Rows 2-3: which types (only if browser active) -->
        <template v-if="browserNotifsOn && permStatus === 'granted'">
          <div class="notif-pref-row">
            <div class="notif-pref-label">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              <div><p>Private messages</p></div>
            </div>
            <button class="toggle-btn" :class="{ active: notifPrefs.messages }" @click="notifPrefs.messages = !notifPrefs.messages"><span class="toggle-knob"></span></button>
          </div>
          <div class="notif-pref-row">
            <div class="notif-pref-label">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              <div><p>Group messages</p></div>
            </div>
            <button class="toggle-btn" :class="{ active: notifPrefs.groups }" @click="notifPrefs.groups = !notifPrefs.groups"><span class="toggle-knob"></span></button>
          </div>
          <button class="save-notif-btn" @click="saveNotifPrefs" :disabled="notifPrefsSaving">
            <span v-if="notifPrefsSaving">…</span>
            <span v-else>Save</span>
          </button>
        </template>
      </div>

      <!-- Posts -->
      <div class="posts-area">
        <div class="posts-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
          Posts
        </div>
        <div v-if="userPosts.length === 0" class="no-posts">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:48px;height:48px;margin-bottom:12px;opacity:0.3"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          <p>No posts yet</p>
        </div>
        <div v-else class="pgrid">
          <div v-for="post in userPosts" :key="post.id" class="pitem">
            <img :src="post.media_url" :alt="post.caption || ''" loading="lazy" />
            <div class="poverlay">
              <svg viewBox="0 0 24 24" fill="white" style="width:17px;height:17px"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
              {{ post.likes?.[0]?.count || 0 }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Followers / Following Modal -->
    <div v-if="showModal" class="modal-backdrop" @click.self="showModal = null">
      <div class="modal">
        <div class="modal-header">
          <h3>{{ showModal === 'followers' ? 'Followers' : 'Following' }}</h3>
          <button class="modal-close" @click="showModal = null">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div v-if="loadingModal" class="modal-loading"><div class="spinner"></div></div>
        <div v-else-if="modalList().length === 0" class="modal-empty">No {{ showModal }} yet</div>
        <div v-else class="modal-list">
          <div v-for="u in modalList()" :key="u.id" class="modal-user">
            <div class="mu-av">
              <img v-if="u.avatar_url" :src="u.avatar_url" />
              <span v-else>{{ u.username?.charAt(0)?.toUpperCase() }}</span>
            </div>
            <span class="mu-name" :style="u.username_color ? { color: u.username_color } : {}">@{{ u.username || 'unnamed' }}</span>
            <span v-if="u.is_premium" class="mu-premium">
              <svg viewBox="0 0 24 24" fill="currentColor" style="width:12px;height:12px"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.profile-page { min-height: 100vh; background: var(--app-bg); }
.loading { display: flex; justify-content: center; align-items: center; height: 60vh; }
.spinner { width: 40px; height: 40px; border: 3px solid #e2d9ff; border-top-color: var(--purple); border-radius: 50%; animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.hero { background: white; border-bottom: 1px solid #ede8ff; position: relative; padding-bottom: 28px; }
.hero-banner { height: 120px; transition: background .4s; }
.hero-body { display: flex; align-items: flex-end; gap: 24px; padding: 0 40px; margin-top: -50px; }

/* Avatar */
.av-wrap { position: relative; flex-shrink: 0; }
.big-av { width: 100px; height: 100px; border-radius: 50%; border: 4px solid white; background: var(--purple); display: flex; align-items: center; justify-content: center; font-family: 'Epilogue', sans-serif; font-size: 2.2rem; font-weight: 800; color: white; overflow: hidden; box-shadow: 0 4px 20px rgba(76,16,224,0.3); }
.big-av.av-premium { border-color: #fbbf24; box-shadow: 0 4px 24px rgba(251,191,36,0.35); }
.av-media { width: 100%; height: 100%; object-fit: cover; }
.crown-badge { position: absolute; bottom: 0; right: 0; width: 24px; height: 24px; background: #fbbf24; border-radius: 50%; border: 2px solid white; display: flex; align-items: center; justify-content: center; color: white; }
.crown-badge svg { width: 13px; height: 13px; }
.av-btn { position: absolute; bottom: 2px; left: 2px; width: 28px; height: 28px; background: var(--purple); border-radius: 50%; border: 2px solid white; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.av-btn svg { width: 13px; height: 13px; stroke: white; }
.av-btn.dim { opacity: 0.5; cursor: not-allowed; }

/* Name row */
.hero-right { flex: 1; padding-bottom: 4px; padding-top: 56px; }
.hero-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; flex-wrap: wrap; gap: 10px; }
.dname-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dname { font-family: 'Epilogue', sans-serif; font-size: 1.4rem; font-weight: 800; line-height: 1.2; transition: color .3s; }
.official-icon { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; background: #1d9bf0; border-radius: 50%; color: white; flex-shrink: 0; }
.official-icon svg { width: 13px; height: 13px; }
.premium-icon { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; background: linear-gradient(135deg, #fbbf24, #f97316); border-radius: 50%; color: white; flex-shrink: 0; }
.premium-icon svg { width: 12px; height: 12px; }
.custom-badge-icon { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; flex-shrink: 0; }
.custom-badge-icon img { width: 22px; height: 22px; object-fit: contain; border-radius: 4px; }
.badge-preview-wrap { display: flex; align-items: center; gap: 6px; }
.badge-preview-img { width: 36px; height: 36px; object-fit: contain; border-radius: 6px; border: 1.5px solid #e2d9ff; background: white; }
.demail { font-size: 0.8rem; color: var(--text-2); margin-top: 2px; }
.bio-text { font-size: 0.88rem; color: var(--text-2); line-height: 1.5; margin-bottom: 14px; max-width: 440px; }
.bio-empty { font-size: 0.82rem; color: #ccc; font-style: italic; margin-bottom: 14px; }

.stats { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.stat { display: flex; flex-direction: column; }
.stat-btn { background: none; border: none; cursor: pointer; padding: 4px 6px; border-radius: 8px; transition: background .15s; }
.stat-btn:hover { background: #f0eeff; }
.sv { font-family: 'Epilogue', sans-serif; font-weight: 800; font-size: 1.15rem; color: var(--text); }
.sl { font-size: 0.75rem; color: var(--text-2); font-weight: 500; }
.stat-div { width: 1px; height: 28px; background: #e8e0ff; }

.hero-actions { display: flex; gap: 8px; align-items: center; }
.btn-edit { display: flex; align-items: center; gap: 7px; padding: 9px 18px; border: 1.5px solid #d0c4ff; border-radius: 10px; background: none; cursor: pointer; font-family: 'Instrument Sans', sans-serif; font-weight: 600; font-size: 0.85rem; color: var(--text); transition: all .18s; }
.btn-edit svg { width: 15px; height: 15px; }
.btn-edit:hover { border-color: var(--purple); color: var(--purple); }
.btn-cancel { padding: 9px 16px; border: 1px solid #ddd; border-radius: 10px; background: none; font-size: 0.85rem; cursor: pointer; font-family: 'Instrument Sans', sans-serif; }
.btn-save { display: flex; align-items: center; gap: 8px; padding: 9px 20px; background: var(--purple); color: white; border: none; border-radius: 10px; font-weight: 700; font-size: 0.85rem; font-family: 'Instrument Sans', sans-serif; cursor: pointer; transition: background .18s; }
.btn-save:hover { background: var(--purple-d); }
.btn-save:disabled { opacity: 0.6; cursor: not-allowed; }
.btn-spin { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.4); border-top-color: white; border-radius: 50%; animation: spin .6s linear infinite; }

/* Edit panel */
.edit-panel { padding: 20px 40px 0; }
.edit-grid { display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 20px; }
.efield { display: flex; flex-direction: column; gap: 5px; min-width: 200px; }
.efield-wide { flex: 1; min-width: 280px; }
.efield label { font-size: 0.72rem; font-weight: 700; color: var(--text-2); letter-spacing: .06em; text-transform: uppercase; }
.efield input, .efield textarea { padding: 10px 14px; border: 1.5px solid #e2d9ff; border-radius: 10px; font-family: 'Instrument Sans', sans-serif; font-size: 0.88rem; outline: none; resize: none; transition: border-color .18s; }
.efield input:focus, .efield textarea:focus { border-color: var(--purple); }

/* Premium section */
.premium-section { background: linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%); border: 1.5px solid #fde68a; border-radius: 14px; padding: 16px 20px; margin-bottom: 16px; display: flex; flex-direction: column; gap: 16px; }
.premium-section-title { display: flex; align-items: center; gap: 6px; font-size: 0.8rem; font-weight: 800; color: #92400e; letter-spacing: .05em; text-transform: uppercase; }

.pref-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.pref-label { font-size: 0.8rem; font-weight: 600; color: #78350f; min-width: 120px; }
.pref-preview { font-family: 'Epilogue', sans-serif; font-weight: 800; font-size: 0.9rem; transition: color .2s; }

/* Color swatches */
.color-swatches { display: flex; gap: 6px; flex-wrap: wrap; }
.swatch { width: 26px; height: 26px; border-radius: 50%; border: 2.5px solid transparent; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: transform .15s, border-color .15s; background: #e5e7eb; }
.swatch:hover { transform: scale(1.15); }
.swatch.active { border-color: #1e1b4b; transform: scale(1.1); }
.swatch-default { font-size: 0.75rem; font-weight: 800; color: #374151; }

/* Banner swatches */
.banner-presets { display: flex; gap: 6px; flex-wrap: wrap; }
.banner-swatch { width: 36px; height: 22px; border-radius: 6px; border: 2.5px solid transparent; cursor: pointer; transition: transform .15s, border-color .15s; }
.banner-swatch:hover { transform: scale(1.1); }
.banner-swatch.active { border-color: #1e1b4b; transform: scale(1.05); }

/* Chat BG */
.chatbg-controls { display: flex; align-items: center; gap: 10px; }
.chatbg-preview { position: relative; width: 52px; height: 38px; border-radius: 8px; overflow: hidden; border: 1.5px solid #fde68a; }
.chatbg-preview img { width: 100%; height: 100%; object-fit: cover; }
.chatbg-remove { position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; border-radius: 50%; background: rgba(0,0,0,0.55); color: white; border: none; font-size: 0.75rem; cursor: pointer; display: flex; align-items: center; justify-content: center; line-height: 1; }
.chatbg-upload-btn { display: flex; align-items: center; gap: 6px; padding: 7px 14px; background: white; border: 1.5px solid #fde68a; border-radius: 8px; font-size: 0.8rem; font-weight: 600; color: #92400e; cursor: pointer; transition: background .15s; }
.chatbg-upload-btn svg { width: 14px; height: 14px; }
.chatbg-upload-btn:hover { background: #fffbeb; }
.pref-note { font-size: 0.72rem; color: #b45309; opacity: 0.8; }

.err-msg { display: flex; align-items: flex-start; gap: 8px; margin-top: 12px; padding: 10px 14px; background: #fff5f5; border: 1px solid #fdd; border-radius: 10px; color: #c0392b; font-size: 0.82rem; }
.success-toast { display: inline-flex; align-items: center; gap: 7px; position: absolute; bottom: -18px; left: 40px; background: #1a7a4a; color: white; padding: 8px 16px; border-radius: 20px; font-size: 0.82rem; font-weight: 600; box-shadow: 0 4px 16px rgba(26,122,74,0.3); z-index: 10; }
.toast-enter-active, .toast-leave-active { transition: all .3s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(6px); }

/* Posts */
.posts-area { padding: 32px 40px; max-width: 960px; }
.posts-header { display: flex; align-items: center; gap: 8px; font-size: 0.8rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--text-2); margin-bottom: 20px; padding-bottom: 14px; border-bottom: 1.5px solid #ede8ff; }
.posts-header svg { width: 15px; height: 15px; }
.no-posts { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 60px; color: var(--text-2); }
.no-posts span { font-size: 2.5rem; }
.pgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
.pitem { aspect-ratio: 1; border-radius: 12px; overflow: hidden; position: relative; background: #f0eeff; cursor: pointer; }
.pitem img { width: 100%; height: 100%; object-fit: cover; transition: transform .3s; }
.pitem:hover img { transform: scale(1.05); }
.poverlay { position: absolute; inset: 0; background: rgba(76,16,224,0.55); display: flex; align-items: center; justify-content: center; gap: 6px; color: white; font-weight: 700; font-size: 0.95rem; opacity: 0; transition: opacity .2s; }
.pitem:hover .poverlay { opacity: 1; }

/* Modal */
.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 500; display: flex; align-items: center; justify-content: center; padding: 20px; backdrop-filter: blur(4px); }
.modal { background: white; border-radius: 20px; width: 100%; max-width: 400px; max-height: 70vh; overflow: hidden; display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0,0,0,0.2); }
.modal-header { display: flex; justify-content: space-between; align-items: center; padding: 18px 20px 14px; border-bottom: 1px solid #ede8ff; flex-shrink: 0; }
.modal-header h3 { font-family: 'Epilogue', sans-serif; font-weight: 800; font-size: 1.1rem; color: var(--text); }
.modal-close { width: 30px; height: 30px; border-radius: 50%; background: #f0eeff; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.modal-close svg { width: 14px; height: 14px; }
.modal-loading { display: flex; justify-content: center; padding: 30px; }
.modal-empty { text-align: center; padding: 30px; color: var(--text-2); font-size: 0.88rem; }
.modal-list { overflow-y: auto; padding: 8px 0; }
.modal-user { display: flex; align-items: center; gap: 12px; padding: 10px 20px; transition: background .15s; }
.modal-user:hover { background: #f7f4ff; }
.mu-av { width: 40px; height: 40px; border-radius: 50%; background: var(--purple); color: white; font-weight: 700; display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0; }
.mu-av img { width: 100%; height: 100%; object-fit: cover; }
.mu-name { font-weight: 600; font-size: 0.88rem; flex: 1; transition: color .2s; }
.mu-premium { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; background: linear-gradient(135deg, #fbbf24, #f97316); border-radius: 50%; color: white; flex-shrink: 0; }

@media (max-width: 640px) {
  .hero-body { flex-direction: column; align-items: center; padding: 0 20px; margin-top: -44px; }
  .hero-right { padding-top: 12px; text-align: center; width: 100%; }
  .hero-top { justify-content: center; flex-direction: column; align-items: center; }
  .stats { justify-content: center; }
  .edit-panel { padding: 20px 20px 0; }
  .posts-area { padding: 24px 16px; }
  .pgrid { grid-template-columns: repeat(2, 1fr); }
  .pref-row { flex-direction: column; align-items: flex-start; }
}

/* ── Notification Preferences — compact ──────────────────────────────────── */
.notif-prefs-section {
  margin: 0 40px 8px;
  background: white;
  border: 1.5px solid #ede8ff;
  border-radius: 14px;
  padding: 14px 20px;
}
.notif-prefs-header {
  display: flex; align-items: center; gap: 7px;
  font-size: 0.72rem; font-weight: 800; letter-spacing: .07em;
  text-transform: uppercase; color: var(--text-2);
  margin-bottom: 10px;
}
.notif-prefs-header svg { width: 14px; height: 14px; flex-shrink: 0; }
.notif-saved-badge {
  margin-left: auto; font-size: 0.7rem; font-weight: 700;
  color: #16a34a; background: #dcfce7; border-radius: 6px; padding: 2px 8px;
  text-transform: none; letter-spacing: 0;
}
.notif-pref-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 0; border-bottom: 1px solid #f5f3ff;
}
.notif-pref-row:last-of-type { border-bottom: none; }
.notif-browser-row { padding: 10px 0; }
.notif-pref-label {
  display: flex; align-items: center; gap: 10px; flex: 1;
}
.notif-pref-label svg { width: 16px; height: 16px; color: var(--purple); flex-shrink: 0; }
.notif-pref-label p { font-size: 0.84rem; font-weight: 600; color: var(--text); margin: 0 0 1px; }
.notif-pref-label small { font-size: 0.72rem; color: var(--text-2); line-height: 1.3; }
.perm-denied { color: #dc2626 !important; }

/* Toggle switch */
.toggle-btn {
  width: 42px; height: 24px; border-radius: 12px; border: none;
  background: #e2d9ff; position: relative; cursor: pointer;
  transition: background .22s; flex-shrink: 0;
}
.toggle-btn.active { background: var(--purple, #7c3aed); }
.toggle-btn.disabled { background: #e5e7eb; cursor: not-allowed; opacity: 0.6; }
.toggle-knob {
  position: absolute; top: 3px; left: 3px;
  width: 18px; height: 18px; border-radius: 50%;
  background: white; transition: transform .22s;
  box-shadow: 0 1px 3px rgba(0,0,0,0.2);
}
.toggle-btn.active .toggle-knob { transform: translateX(18px); }

.save-notif-btn {
  margin-top: 10px; padding: 7px 18px;
  background: var(--purple, #7c3aed); color: white;
  border: none; border-radius: 8px; font-weight: 700; font-size: 0.8rem;
  font-family: 'Instrument Sans', sans-serif; cursor: pointer;
  transition: background .18s, opacity .18s;
}
.save-notif-btn:hover { background: var(--purple-d, #6d28d9); }
.save-notif-btn:disabled { opacity: 0.6; cursor: not-allowed; }

@media (max-width: 640px) {
  .notif-prefs-section { margin: 0 16px 8px; padding: 12px 16px; }
}
</style>
