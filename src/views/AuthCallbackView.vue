<script setup>
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { supabase } from '../lib/supabaseClient'
import { updateSession } from '../lib/authStore'

const router = useRouter()
const status = ref('verifying') // 'verifying' | 'success' | 'error'
const errorMsg = ref('')

onMounted(async () => {
  try {
    // Supabase appends tokens as URL hash fragments after email confirmation
    // exchangeCodeForSession handles both PKCE code and hash tokens
    const hashParams = new URLSearchParams(window.location.hash.slice(1))
    const queryParams = new URLSearchParams(window.location.search)

    const accessToken  = hashParams.get('access_token')
    const refreshToken = hashParams.get('refresh_token')
    const type         = hashParams.get('type') || queryParams.get('type')
    const code         = queryParams.get('code')

    if (code) {
      // PKCE flow — exchange code for session
      const { data, error } = await supabase.auth.exchangeCodeForSession(code)
      if (error) throw error
      updateSession('SIGNED_IN', data.session)
      status.value = 'success'
      setTimeout(() => router.replace('/'), 2000)
    } else if (accessToken) {
      // Implicit flow — set session directly from hash tokens
      const { data, error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken || '',
      })
      if (error) throw error
      updateSession('SIGNED_IN', data.session)
      status.value = 'success'
      setTimeout(() => router.replace('/'), 2000)
    } else {
      throw new Error('No verification token found in URL. The link may have expired.')
    }
  } catch (err) {
    status.value = 'error'
    errorMsg.value = err.message || 'Verification failed. The link may have expired.'
  }
})
</script>

<template>
  <div class="callback-page">
    <div class="callback-card">

      <!-- Verifying -->
      <template v-if="status === 'verifying'">
        <div class="cb-spinner"></div>
        <h2 class="cb-title">Verifying your email…</h2>
        <p class="cb-sub">Just a moment while we confirm your account.</p>
      </template>

      <!-- Success -->
      <template v-else-if="status === 'success'">
        <div class="cb-icon success">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <h2 class="cb-title">Email verified!</h2>
        <p class="cb-sub">Your account is now active. Taking you to ONBSocial…</p>
        <div class="cb-progress">
          <div class="cb-progress-bar"></div>
        </div>
      </template>

      <!-- Error -->
      <template v-else>
        <div class="cb-icon error">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </div>
        <h2 class="cb-title">Verification failed</h2>
        <p class="cb-sub">{{ errorMsg }}</p>
        <button class="cb-btn" @click="$router.push('/auth')">
          Back to Sign In
        </button>
        <button class="cb-btn-secondary" @click="$router.push('/verify-email')">
          Resend verification email
        </button>
      </template>

    </div>

    <div class="brand-watermark">
      <span class="bw1">ONB</span><span class="bw2">Social</span>
    </div>
  </div>
</template>

<style scoped>
.callback-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--app-bg);
  padding: 24px;
  position: relative;
}

.callback-card {
  background: white;
  border-radius: 24px;
  padding: 52px 44px;
  width: 100%;
  max-width: 400px;
  box-shadow: 0 8px 48px rgba(76,16,224,0.12);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  text-align: center;
}

.cb-spinner {
  width: 52px; height: 52px;
  border: 4px solid #ede9ff;
  border-top-color: var(--purple);
  border-radius: 50%;
  animation: spin .8s linear infinite;
  margin-bottom: 8px;
}
@keyframes spin { to { transform: rotate(360deg); } }

.cb-icon {
  width: 68px; height: 68px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 8px;
}
.cb-icon svg { width: 30px; height: 30px; }
.cb-icon.success { background: #f0fdf4; color: #16a34a; border: 2px solid #86efac; }
.cb-icon.error   { background: #fff0f0; color: #dc2626; border: 2px solid #fca5a5; }

.cb-title {
  font-family: 'Epilogue', sans-serif;
  font-size: 1.6rem;
  font-weight: 800;
  color: var(--text);
  margin: 0;
}

.cb-sub {
  font-size: 0.9rem;
  color: var(--text-2);
  line-height: 1.5;
  margin: 0;
  max-width: 300px;
}

.cb-progress {
  width: 100%;
  height: 4px;
  background: #ede9ff;
  border-radius: 4px;
  overflow: hidden;
  margin-top: 8px;
}
.cb-progress-bar {
  height: 100%;
  background: var(--purple);
  border-radius: 4px;
  animation: progress 2s linear forwards;
}
@keyframes progress { from { width: 0 } to { width: 100% } }

.cb-btn {
  width: 100%;
  padding: 12px;
  background: var(--purple);
  color: white;
  border: none;
  border-radius: 11px;
  font-family: 'Instrument Sans', sans-serif;
  font-size: 0.9rem;
  font-weight: 700;
  cursor: pointer;
  transition: background .15s;
  margin-top: 4px;
}
.cb-btn:hover { background: var(--purple-d); }

.cb-btn-secondary {
  background: none;
  border: none;
  color: var(--text-2);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  padding: 4px;
}
.cb-btn-secondary:hover { color: var(--purple); }

.brand-watermark {
  position: fixed;
  bottom: 22px;
  left: 50%;
  transform: translateX(-50%);
  font-family: 'Epilogue', sans-serif;
  font-size: 1rem;
  opacity: 0.35;
  pointer-events: none;
  white-space: nowrap;
}
.bw1 { font-weight: 800; color: var(--purple); }
.bw2 { font-weight: 700; color: var(--text); }
</style>
