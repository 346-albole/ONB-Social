<script setup>
import { ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { auth } from '../lib/auth'

const router = useRouter()
const route = useRoute()
const loading = ref(false)
const username = ref('')
const errorMsg = ref('')

// 'username' : fournisseur dev (nom d'utilisateur seul, compte créé à la
// première connexion) — 'redirect' : fournisseur d'identité (Microsoft Entra ID).
const loginMode = auth.loginMode

const handleAuth = async () => {
  loading.value = true
  errorMsg.value = ''
  try {
    const target = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/') ? route.query.redirect : '/'
    // MSAL : le navigateur part chez Microsoft ; le retour passe par /auth/callback
    // (page « redirect bridge ») puis revient ici, et le routeur rouvre `target`.
    await auth.login(loginMode === 'username' ? { username: username.value.trim() } : { redirectTo: target })
    if (loginMode === 'username') router.push(target)
  } catch (err) {
    errorMsg.value = err.message
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="auth-page">
    <div class="auth-left">
      <div class="brand-display">
        <span class="b1">ONB</span><span class="b2">Social</span>
      </div>
      <p class="brand-tagline">Share moments. Build community.</p>
      <div class="brand-dots">
        <div class="dot d1"></div>
        <div class="dot d2"></div>
        <div class="dot d3"></div>
      </div>
    </div>

    <div class="auth-right">
      <div class="auth-card">
        <h2 class="card-title">Welcome back</h2>
        <p class="card-sub">{{ loginMode === 'username' ? 'Sign in to continue — a new account is created on first sign-in' : 'Sign in to continue' }}</p>

        <div class="error-msg" v-if="errorMsg">{{ errorMsg }}</div>

        <form @submit.prevent="handleAuth" class="auth-form">
          <div v-if="loginMode === 'username'" class="field">
            <label>Username</label>
            <input v-model="username" type="text" placeholder="yourhandle" pattern="[A-Za-z0-9_.\-]+" maxlength="40" autocomplete="username" required />
          </div>

          <button type="submit" :disabled="loading" class="submit-btn">
            <span v-if="loading" class="btn-spinner"></span>
            {{ loading ? 'Processing…' : loginMode === 'username' ? 'Sign In' : 'Sign in with Microsoft' }}
          </button>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
.auth-page {
  min-height: 100vh;
  display: flex;
}

/* Left panel */
.auth-left {
  width: 45%;
  background: var(--purple);
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: flex-start;
  padding: 60px 56px;
  position: relative;
  overflow: hidden;
}

.brand-display {
  font-family: 'Epilogue', sans-serif;
  font-size: 3.2rem;
  color: white;
  margin-bottom: 16px;
}
.b1 { font-weight: 800; }
.b2 { font-weight: 700; opacity: 0.85; }

.brand-tagline {
  color: rgba(255,255,255,0.6);
  font-size: 1.05rem;
  font-weight: 500;
  max-width: 280px;
  line-height: 1.5;
}

.brand-dots { display: flex; gap: 14px; margin-top: 48px; }
.dot {
  border-radius: 50%;
  background: rgba(255,255,255,0.15);
}
.d1 { width: 80px; height: 80px; }
.d2 { width: 52px; height: 52px; align-self: flex-end; background: rgba(255,255,255,0.25); }
.d3 { width: 36px; height: 36px; align-self: center; }

/* Right panel */
.auth-right {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
  background: var(--app-bg);
}

.auth-card {
  width: 100%;
  max-width: 400px;
  background: white;
  border-radius: 22px;
  padding: 40px;
  box-shadow: 0 4px 32px rgba(76,16,224,0.1);
}

.card-title {
  font-family: 'Epilogue', sans-serif;
  font-size: 1.7rem;
  font-weight: 800;
  color: var(--text);
  margin-bottom: 6px;
}
.card-sub { color: var(--text-2); font-size: 0.9rem; margin-bottom: 28px; }

.error-msg {
  background: #fff0f0;
  border: 1px solid #fcc;
  border-radius: 10px;
  padding: 10px 14px;
  color: #c0392b;
  font-size: 0.85rem;
  margin-bottom: 16px;
}

.auth-form { display: flex; flex-direction: column; gap: 16px; }

.field { display: flex; flex-direction: column; gap: 6px; }
.field label { font-size: 0.82rem; font-weight: 700; color: var(--text); letter-spacing: .03em; }
.field input {
  padding: 12px 16px;
  border: 1.5px solid #e2d9ff;
  border-radius: 12px;
  font-family: 'Instrument Sans', sans-serif;
  font-size: 0.92rem;
  outline: none;
  transition: border-color .18s, box-shadow .18s;
}
.field input:focus {
  border-color: var(--purple);
  box-shadow: 0 0 0 3px rgba(76,16,224,0.1);
}

.submit-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  padding: 14px;
  background: var(--purple);
  color: white;
  border: none;
  border-radius: 12px;
  font-family: 'Instrument Sans', sans-serif;
  font-size: 0.95rem;
  font-weight: 700;
  cursor: pointer;
  margin-top: 4px;
  transition: background .18s, transform .15s;
}
.submit-btn:hover { background: var(--purple-d); transform: translateY(-1px); }
.submit-btn:disabled { opacity: 0.65; cursor: not-allowed; transform: none; }

.btn-spinner {
  width: 16px; height: 16px;
  border: 2px solid rgba(255,255,255,0.4);
  border-top-color: white;
  border-radius: 50%;
  animation: spin .7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.toggle {
  text-align: center;
  margin-top: 22px;
  font-size: 0.88rem;
  color: var(--text-2);
  cursor: pointer;
}
.toggle strong { color: var(--purple); font-weight: 700; }
.toggle:hover strong { text-decoration: underline; }

@media (max-width: 680px) {
  .auth-page { flex-direction: column; }
  .auth-left { width: 100%; min-height: 200px; padding: 40px 32px; }
  .auth-right { padding: 24px 16px; }
}
</style>
