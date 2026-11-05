<script setup>
import { ref, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { supabase } from '../lib/supabaseClient'

const router = useRouter()
const route  = useRoute()

const email        = ref('')
const resending    = ref(false)
const resendCooldown = ref(0)
const resendMsg    = ref('')
const resendError  = ref('')
// Mode: 'pending' = just signed up, 'blocked' = tried to access app unverified
const mode = ref(route.query.mode || 'pending')

let cooldownTimer = null

onMounted(() => {
  // Read email from query param (passed by AuthView after signup)
  email.value = route.query.email || ''
})

async function resend() {
  if (!email.value || resending.value || resendCooldown.value > 0) return
  resending.value = true
  resendMsg.value = ''
  resendError.value = ''
  try {
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email: email.value,
    })
    if (error) throw error
    resendMsg.value = 'Email sent! Check your inbox (and spam folder).'
    // 60-second cooldown
    resendCooldown.value = 60
    cooldownTimer = setInterval(() => {
      resendCooldown.value--
      if (resendCooldown.value <= 0) {
        clearInterval(cooldownTimer)
        resendCooldown.value = 0
      }
    }, 1000)
  } catch (err) {
    resendError.value = err.message
  } finally {
    resending.value = false
  }
}

function goToSignIn() {
  router.push('/auth')
}
</script>

<template>
  <div class="verify-page">
    <div class="verify-card">
      <!-- Icon -->
      <div class="email-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6z"/>
          <path d="M22 6l-10 7L2 6"/>
        </svg>
      </div>

      <!-- Heading -->
      <h1 class="verify-title">Check your email</h1>
      <p class="verify-sub">
        <template v-if="mode === 'blocked'">
          Your account needs to be verified before you can access ONBSocial.
        </template>
        <template v-else>
          We sent a confirmation link to
        </template>
      </p>
      <p v-if="email" class="verify-email">{{ email }}</p>
      <p class="verify-hint">
        Click the link in the email to activate your account. If you don't see it, check your spam folder.
      </p>

      <!-- Resend section -->
      <div class="resend-section">
        <p class="resend-label">Didn't receive it?</p>

        <div v-if="resendMsg" class="resend-ok">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="width:16px;height:16px;flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg>
          {{ resendMsg }}
        </div>
        <div v-if="resendError" class="resend-err">{{ resendError }}</div>

        <button
          class="resend-btn"
          :disabled="resending || resendCooldown > 0 || !email"
          @click="resend"
        >
          <span v-if="resending" class="btn-spinner"></span>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="width:15px;height:15px"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          <span v-if="resendCooldown > 0">Resend in {{ resendCooldown }}s</span>
          <span v-else>Resend verification email</span>
        </button>
      </div>

      <!-- Back to sign in -->
      <button class="back-btn" @click="goToSignIn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="width:15px;height:15px"><path d="M15 18l-6-6 6-6"/></svg>
        Back to sign in
      </button>
    </div>

    <!-- Branding watermark -->
    <div class="brand-watermark">
      <span class="bw1">ONB</span><span class="bw2">Social</span>
    </div>
  </div>
</template>

<style scoped>
.verify-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--app-bg);
  padding: 24px;
  position: relative;
}

.verify-card {
  background: white;
  border-radius: 24px;
  padding: 48px 44px;
  width: 100%;
  max-width: 440px;
  box-shadow: 0 8px 48px rgba(76,16,224,0.12);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
  text-align: center;
}

.email-icon {
  width: 72px;
  height: 72px;
  background: linear-gradient(135deg, #ede9ff, #ddd6fe);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 24px;
  color: var(--purple);
}
.email-icon svg { width: 34px; height: 34px; }

.verify-title {
  font-family: 'Epilogue', sans-serif;
  font-size: 1.75rem;
  font-weight: 800;
  color: var(--text);
  margin-bottom: 10px;
}

.verify-sub {
  font-size: 0.92rem;
  color: var(--text-2);
  line-height: 1.5;
  margin-bottom: 4px;
}

.verify-email {
  font-weight: 700;
  color: var(--purple);
  font-size: 0.95rem;
  margin-bottom: 12px;
  word-break: break-all;
}

.verify-hint {
  font-size: 0.83rem;
  color: #9ca3af;
  line-height: 1.5;
  margin-bottom: 28px;
}

.resend-section {
  width: 100%;
  background: #f7f4ff;
  border-radius: 16px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 20px;
}

.resend-label {
  font-size: 0.85rem;
  color: var(--text-2);
  font-weight: 600;
  margin: 0;
}

.resend-ok {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.84rem;
  color: #16a34a;
  background: #f0fdf4;
  border: 1px solid #86efac;
  border-radius: 9px;
  padding: 9px 12px;
  text-align: left;
}

.resend-err {
  font-size: 0.84rem;
  color: #dc2626;
  background: #fff0f0;
  border: 1px solid #fca5a5;
  border-radius: 9px;
  padding: 9px 12px;
}

.resend-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 12px;
  background: var(--purple);
  color: white;
  border: none;
  border-radius: 11px;
  font-family: 'Instrument Sans', sans-serif;
  font-size: 0.88rem;
  font-weight: 700;
  cursor: pointer;
  transition: opacity .15s, background .15s;
}
.resend-btn:hover:not(:disabled) { background: var(--purple-d); }
.resend-btn:disabled { opacity: 0.45; cursor: not-allowed; }

.btn-spinner {
  width: 14px; height: 14px;
  border: 2px solid rgba(255,255,255,0.35);
  border-top-color: white;
  border-radius: 50%;
  animation: spin .7s linear infinite;
  flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }

.back-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  color: var(--text-2);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 8px;
  transition: color .15s;
}
.back-btn:hover { color: var(--purple); }

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

@media (max-width: 500px) {
  .verify-card { padding: 36px 24px; }
}
</style>
