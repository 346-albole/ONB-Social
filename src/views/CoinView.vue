<script setup>
import { ref, computed, onMounted } from 'vue'
import { supabase } from '../lib/supabaseClient'
import { getCurrentSession } from '../lib/authStore'
import { withTimeout, makeSafeLoader } from '../lib/withTimeout'

const currentUser  = ref(null)
const profile      = ref(null)
const transactions = ref([])
const loading      = ref(true)
const buying       = ref(null)   // 'premium' | 'official'
const buyResult    = ref(null)   // { success, error, new_balance, expires_at }
const showConfirm  = ref(null)   // subscription type being confirmed

const PRICES = { premium: 6700, official: 300 }
const COLORS = { premium: 'linear-gradient(135deg,#fbbf24,#f97316)', official: '#1d9bf0' }

const isPremium  = computed(() => profile.value?.is_premium)
const isOfficial = computed(() => profile.value?.is_official)
const isPremPerm = computed(() => profile.value?.premium_is_permanent)
const isOffPerm  = computed(() => profile.value?.official_is_permanent)
const balance    = computed(() => profile.value?.onb_coins ?? 0)

function daysLeft(expiresAt) {
  if (!expiresAt) return null
  const diff = new Date(expiresAt) - Date.now()
  return Math.max(0, Math.ceil(diff / 86400000))
}

function fmtDate(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' })
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// Returns true if subscription is due for renewal (expires within 7 days or already expired)
function needsRenewal(sub) {
  if (sub === 'premium' && isPremPerm.value) return false
  if (sub === 'official' && isOffPerm.value) return false
  const exp = sub === 'premium' ? profile.value?.premium_expires_at : profile.value?.official_expires_at
  if (!exp) return false
  const days = daysLeft(exp)
  return days !== null && days <= 7
}

const _safeLoad = makeSafeLoader(loading)
async function load() {
  await _safeLoad(async () => {
    const session = getCurrentSession()
    if (!session) return
    currentUser.value = session.user

    const [profileRes, txRes] = await Promise.all([
      withTimeout(
        supabase.from('profiles')
          .select('id, username, avatar_url, is_premium, is_official, onb_coins, premium_expires_at, official_expires_at, premium_is_permanent, official_is_permanent')
          .eq('id', session.user.id).maybeSingle(),
        8000
      ),
      withTimeout(
        supabase.from('coin_transactions')
          .select('*').eq('user_id', session.user.id)
          .order('created_at', { ascending: false }).limit(30),
        8000
      ),
    ])
    profile.value = profileRes?.data ?? null
    transactions.value = txRes?.data || []
  })
}

async function confirmBuy(sub) {
  showConfirm.value = null
  buying.value = sub
  buyResult.value = null

  const { data, error } = await supabase.rpc('buy_subscription', { sub_type: sub })
  buying.value = null

  if (error) {
    buyResult.value = { success: false, error: error.message }
    return
  }
  buyResult.value = data

  if (data?.success) {
    // Update local profile
    profile.value.onb_coins = data.new_balance
    if (sub === 'premium') {
      profile.value.is_premium = true
      profile.value.premium_expires_at = data.expires_at
    } else {
      profile.value.is_official = true
      profile.value.official_expires_at = data.expires_at
    }
    // Refresh transactions
    const { data: tx } = await supabase.from('coin_transactions')
      .select('*').eq('user_id', currentUser.value.id)
      .order('created_at', { ascending: false }).limit(30)
    transactions.value = tx || []
  }
}

function txLabel(reason) {
  const map = {
    admin_grant:       'Admin grant',
    purchase_premium:  'Premium subscription',
    purchase_official: 'Official status',
    refund:            'Refund',
    welcome_bonus:     'Welcome bonus',
  }
  return map[reason] || reason
}

onMounted(load)
</script>

<template>
  <div class="coin-page">
    <div v-if="loading" class="c-loading"><div class="spinner"></div></div>

    <div v-else class="coin-inner">

      <!-- Wallet card -->
      <div class="wallet-card">
        <div class="wallet-left">
          <div class="coin-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 7v1m0 8v1M9.5 9.5C9.5 8.4 10.6 7.5 12 7.5s2.5.9 2.5 2-.9 1.8-2.5 2-2.5.9-2.5 2 1.1 2 2.5 2 2.5-.9 2.5-2" stroke-linecap="round"/></svg>
          </div>
          <div>
            <div class="wallet-label">ONB Coin Balance</div>
            <div class="wallet-balance">{{ balance.toLocaleString() }} <span class="coin-unit">coins</span></div>
          </div>
        </div>
        <div class="wallet-note">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          Coins are granted by admins only
        </div>
      </div>

      <!-- Renewal banners -->
      <div v-if="needsRenewal('premium')" class="renewal-banner premium-banner">
        <div class="ren-left">
          <svg viewBox="0 0 24 24" fill="currentColor" style="width:18px;height:18px"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
          <div>
            <strong>Premium expires {{ daysLeft(profile.premium_expires_at) === 0 ? 'today' : `in ${daysLeft(profile.premium_expires_at)} days` }}</strong>
            <span> — Renew for 6,700 coins/month to keep your perks</span>
          </div>
        </div>
        <button class="ren-btn" @click="showConfirm = 'premium'" :disabled="balance < PRICES.premium">
          Renew Now
        </button>
      </div>

      <div v-if="needsRenewal('official')" class="renewal-banner official-banner">
        <div class="ren-left">
          <svg viewBox="0 0 24 24" fill="currentColor" style="width:18px;height:18px"><path d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"/></svg>
          <div>
            <strong>Official status expires {{ daysLeft(profile.official_expires_at) === 0 ? 'today' : `in ${daysLeft(profile.official_expires_at)} days` }}</strong>
            <span> — Renew for 300 coins/month</span>
          </div>
        </div>
        <button class="ren-btn" @click="showConfirm = 'official'" :disabled="balance < PRICES.official">
          Renew Now
        </button>
      </div>

      <!-- Buy result toast -->
      <div v-if="buyResult" class="result-toast" :class="buyResult.success ? 'ok' : 'err'">
        <template v-if="buyResult.success">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;display:inline;vertical-align:text-bottom;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>
          Activated! New balance: <strong>{{ buyResult.new_balance?.toLocaleString() }}</strong> coins.
          Valid until {{ fmtDate(buyResult.expires_at) }}.
        </template>
        <template v-else>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;display:inline;vertical-align:text-bottom;margin-right:4px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          {{ buyResult.error }}
          <span v-if="buyResult.balance !== undefined"> (Balance: {{ buyResult.balance?.toLocaleString() }}, Price: {{ buyResult.price?.toLocaleString() }})</span>
        </template>
        <button class="toast-close" @click="buyResult = null">×</button>
      </div>

      <!-- Shop -->
      <h2 class="section-title">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>
        Coin Shop
      </h2>

      <div class="shop-grid">

        <!-- Premium card -->
        <div class="shop-card" :class="{ active: isPremium, permanent: isPremPerm }">
          <div class="shop-card-header premium-header">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            Premium
            <span v-if="isPremPerm" class="perm-pill">PERMANENT</span>
          </div>
          <div class="shop-card-body">
            <div class="shop-price">
              <span class="price-num">6,700</span>
              <span class="price-unit">coins / month</span>
            </div>
            <ul class="shop-perks">
              <li>
                <svg viewBox="0 0 24 24" fill="currentColor" style="width:10px;height:10px;margin-right:4px"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                Lightning bolt badge
              </li>
              <li>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:10px;height:10px;margin-right:4px"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>
                Custom username color
              </li>
              <li>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:10px;height:10px;margin-right:4px"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                Custom profile banner
              </li>
              <li>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:10px;height:10px;margin-right:4px"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                Custom badge upload
              </li>
              <li>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:10px;height:10px;margin-right:4px"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>
                Video avatar
              </li>
              <li>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:10px;height:10px;margin-right:4px"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                Chat background
              </li>
              <li>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:10px;height:10px;margin-right:4px"><path d="M2 10.5L6 7l4 3.5L14 7l4 3.5L22 7V21H2V10.5Z"/></svg>
                Gold crown + avatar ring
              </li>
            </ul>
            <div v-if="isPremPerm" class="status-chip perm-chip">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;margin-right:4px;display:inline"><polyline points="20 6 9 17 4 12"/></svg>
              Active forever
            </div>
            <div v-else-if="isPremium" class="status-chip active-chip">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;margin-right:4px;display:inline"><polyline points="20 6 9 17 4 12"/></svg>
              Active — expires {{ fmtDate(profile.premium_expires_at) }}
              <span v-if="daysLeft(profile.premium_expires_at) !== null" class="days-left">
                ({{ daysLeft(profile.premium_expires_at) }} days)
              </span>
            </div>
            <button
              v-if="!isPremPerm"
              class="buy-btn premium-btn"
              :disabled="buying === 'premium' || balance < PRICES.premium"
              @click="showConfirm = 'premium'"
            >
              <span v-if="buying === 'premium'" class="mini-spin"></span>
              <span v-else>{{ isPremium ? 'Renew Premium' : 'Buy Premium' }}</span>
            </button>
            <p v-if="!isPremPerm && balance < PRICES.premium" class="insufficient">
              Need {{ (PRICES.premium - balance).toLocaleString() }} more coins
            </p>
          </div>
        </div>

        <!-- Official card -->
        <div class="shop-card" :class="{ active: isOfficial, permanent: isOffPerm }">
          <div class="shop-card-header official-header">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"/></svg>
            Official Status
            <span v-if="isOffPerm" class="perm-pill">PERMANENT</span>
          </div>
          <div class="shop-card-body">
            <div class="shop-price">
              <span class="price-num">300</span>
              <span class="price-unit">coins / month</span>
            </div>
            <ul class="shop-perks">
              <li>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:10px;height:10px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>
                Blue verified checkmark
              </li>
              <li>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:10px;height:10px;margin-right:4px"><path d="M11 15h2a2 2 0 1 0 0-4h-2a2 2 0 1 0 0 4Z"/><path d="m4 15 3-3-3-3"/><path d="m17 15 3-3-3-3"/></svg>
                Official account label
              </li>
              <li>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:10px;height:10px;margin-right:4px"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
                Priority in Explore
              </li>
              <li>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:10px;height:10px;margin-right:4px"><circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/></svg>
                Stands out in feeds
              </li>
            </ul>
            <div v-if="isOffPerm" class="status-chip perm-chip">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;margin-right:4px;display:inline"><polyline points="20 6 9 17 4 12"/></svg>
              Active forever
            </div>
            <div v-else-if="isOfficial" class="status-chip active-chip">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;margin-right:4px;display:inline"><polyline points="20 6 9 17 4 12"/></svg>
              Active — expires {{ fmtDate(profile.official_expires_at) }}
              <span v-if="daysLeft(profile.official_expires_at) !== null" class="days-left">
                ({{ daysLeft(profile.official_expires_at) }} days)
              </span>
            </div>
            <button
              v-if="!isOffPerm"
              class="buy-btn official-btn"
              :disabled="buying === 'official' || balance < PRICES.official"
              @click="showConfirm = 'official'"
            >
              <span v-if="buying === 'official'" class="mini-spin"></span>
              <span v-else>{{ isOfficial ? 'Renew Official' : 'Buy Official' }}</span>
            </button>
            <p v-if="!isOffPerm && balance < PRICES.official" class="insufficient">
              Need {{ (PRICES.official - balance).toLocaleString() }} more coins
            </p>
          </div>
        </div>

      </div>

      <!-- Transaction history -->
      <h2 class="section-title" style="margin-top:32px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        Transaction History
      </h2>

      <div v-if="transactions.length === 0" class="no-tx">No transactions yet. Ask an admin to grant you some coins!</div>
      <div v-else class="tx-list">
        <div v-for="tx in transactions" :key="tx.id" class="tx-row">
          <div class="tx-reason">{{ txLabel(tx.reason) }}</div>
          <div class="tx-date">{{ fmtTime(tx.created_at) }}</div>
          <div class="tx-amount" :class="tx.amount > 0 ? 'credit' : 'debit'">
            {{ tx.amount > 0 ? '+' : '' }}{{ tx.amount.toLocaleString() }}
          </div>
        </div>
      </div>

      <!-- Admin info box -->
      <div class="admin-info">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>
        <div>
          <strong>How to get coins?</strong>
          Coins are granted by admins only. Contact an admin or wait for events and giveaways. Admins use the Admin Panel → Coins tab to credit your account.
        </div>
      </div>

    </div>

    <!-- Confirm modal -->
    <div v-if="showConfirm" class="modal-backdrop" @click.self="showConfirm = null">
      <div class="confirm-modal">
        <div class="cm-header" :class="showConfirm + '-header'">
          <svg v-if="showConfirm === 'premium'" viewBox="0 0 24 24" fill="currentColor" style="width:22px;height:22px"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
          <svg v-else viewBox="0 0 24 24" fill="currentColor" style="width:22px;height:22px"><path d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"/></svg>
          Confirm Purchase
        </div>
        <div class="cm-body">
          <p>You are about to purchase <strong>{{ showConfirm === 'premium' ? 'Premium' : 'Official Status' }}</strong> for <strong>{{ PRICES[showConfirm].toLocaleString() }} ONB Coins</strong>.</p>
          <p>This grants <strong>30 days</strong> of access starting today. You can renew before it expires to extend.</p>
          <div class="cm-balance-row">
            <span>Your balance:</span>
            <span class="cm-bal">{{ balance.toLocaleString() }} coins</span>
          </div>
          <div class="cm-balance-row">
            <span>Cost:</span>
            <span class="cm-cost">−{{ PRICES[showConfirm].toLocaleString() }} coins</span>
          </div>
          <div class="cm-balance-row cm-after">
            <span>After purchase:</span>
            <span :class="(balance - PRICES[showConfirm]) >= 0 ? 'cm-bal' : 'cm-cost'">
              {{ (balance - PRICES[showConfirm]).toLocaleString() }} coins
            </span>
          </div>
        </div>
        <div class="cm-footer">
          <button class="cm-cancel" @click="showConfirm = null">Cancel</button>
          <button class="cm-confirm" :class="showConfirm + '-btn'" @click="confirmBuy(showConfirm)">
            Confirm — {{ PRICES[showConfirm].toLocaleString() }} coins
          </button>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
.coin-page { height:100%; overflow-y:auto; padding:28px 32px; box-sizing:border-box; }
.coin-inner { max-width:780px; margin:0 auto; display:flex; flex-direction:column; gap:20px; }
.c-loading { display:flex; justify-content:center; align-items:center; height:60vh; }
.spinner { width:36px;height:36px;border:3px solid #e2d9ff;border-top-color:var(--purple);border-radius:50%;animation:spin .7s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }

/* Wallet card */
.wallet-card {
  background: linear-gradient(135deg, #4C10E0, #7c3aed);
  border-radius: 20px;
  padding: 24px 28px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  color: white;
  box-shadow: 0 8px 32px rgba(76,16,224,0.35);
}
.wallet-left { display:flex; align-items:center; gap:18px; }
.coin-icon { width:52px; height:52px; background:rgba(255,255,255,0.2); border-radius:50%; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
.coin-icon svg { width:36px; height:36px; }
.wallet-label { font-size:0.8rem; opacity:0.7; font-weight:600; letter-spacing:.05em; text-transform:uppercase; margin-bottom:4px; }
.wallet-balance { font-family:'Epilogue',sans-serif; font-size:2rem; font-weight:800; line-height:1; }
.coin-unit { font-size:1rem; font-weight:500; opacity:0.7; }
.wallet-note { display:flex; align-items:center; gap:7px; font-size:0.78rem; opacity:0.65; max-width:200px; text-align:right; }
.wallet-note svg { width:14px; height:14px; flex-shrink:0; }

/* Renewal banners */
.renewal-banner {
  border-radius: 14px;
  padding: 14px 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}
.premium-banner { background:#fffbeb; border:1.5px solid #f59e0b; }
.official-banner { background:#eff6ff; border:1.5px solid #3b82f6; }
.ren-left { display:flex; align-items:center; gap:10px; flex:1; font-size:0.88rem; }
.premium-banner .ren-left svg { color:#f59e0b; }
.official-banner .ren-left svg { color:#3b82f6; }
.ren-btn { padding:8px 18px; border:none; border-radius:10px; font-weight:700; font-size:0.85rem; cursor:pointer; background:var(--purple); color:white; white-space:nowrap; }
.ren-btn:disabled { opacity:0.4; cursor:not-allowed; }

/* Toast */
.result-toast { border-radius:12px; padding:14px 18px; font-size:0.88rem; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.result-toast.ok { background:#f0fdf4; border:1px solid #22c55e; color:#15803d; }
.result-toast.err { background:#fff0f0; border:1px solid #fca5a5; color:#b91c1c; }
.toast-close { margin-left:auto; background:none; border:none; font-size:1.2rem; cursor:pointer; color:inherit; padding:0 4px; }

/* Section title */
.section-title { display:flex; align-items:center; gap:10px; font-family:'Epilogue',sans-serif; font-size:1.1rem; font-weight:800; color:var(--text); }
.section-title svg { width:20px; height:20px; color:var(--purple); }

/* Shop grid */
.shop-grid { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
@media (max-width:600px) { .shop-grid { grid-template-columns:1fr; } }

.shop-card {
  background: white;
  border-radius: 18px;
  overflow: hidden;
  box-shadow: 0 2px 16px rgba(76,16,224,0.07);
  border: 2px solid transparent;
  transition: border-color .2s;
}
.shop-card.active { border-color: var(--purple); }
.shop-card.permanent { border-color: #22c55e; }

.shop-card-header {
  padding: 16px 20px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: 'Epilogue', sans-serif;
  font-size: 1rem;
  font-weight: 800;
  color: white;
}
.shop-card-header svg { width:20px; height:20px; flex-shrink:0; }
.premium-header { background: linear-gradient(135deg, #fbbf24, #f97316); }
.official-header { background: #1d9bf0; }
.perm-pill { margin-left:auto; font-size:0.65rem; background:rgba(255,255,255,0.25); padding:2px 8px; border-radius:10px; letter-spacing:.06em; }

.shop-card-body { padding:20px; display:flex; flex-direction:column; gap:14px; }

.shop-price { display:flex; align-items:baseline; gap:6px; }
.price-num { font-family:'Epilogue',sans-serif; font-size:1.6rem; font-weight:800; color:var(--text); }
.price-unit { font-size:0.8rem; color:var(--text-2); }

.shop-perks { padding-left:18px; margin:0; display:flex; flex-direction:column; gap:4px; }
.shop-perks li { font-size:0.82rem; color:var(--text-2); }

.status-chip { padding:7px 12px; border-radius:10px; font-size:0.82rem; font-weight:600; }
.active-chip { background:#f0eeff; color:var(--purple); }
.perm-chip   { background:#f0fdf4; color:#15803d; }
.days-left   { opacity:0.7; font-weight:400; }

.buy-btn { width:100%; padding:11px; border:none; border-radius:11px; font-family:'Instrument Sans',sans-serif; font-size:0.9rem; font-weight:700; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; transition:opacity .15s; }
.buy-btn:disabled { opacity:0.4; cursor:not-allowed; }
.premium-btn { background:linear-gradient(135deg,#fbbf24,#f97316); color:white; }
.official-btn { background:#1d9bf0; color:white; }

.insufficient { font-size:0.75rem; color:#ef4444; text-align:center; margin:0; }

.mini-spin { width:14px; height:14px; border:2px solid rgba(255,255,255,0.4); border-top-color:white; border-radius:50%; animation:spin .6s linear infinite; }

/* Transactions */
.no-tx { text-align:center; padding:32px; color:var(--text-2); font-size:0.88rem; background:white; border-radius:14px; }
.tx-list { background:white; border-radius:14px; overflow:hidden; box-shadow:0 2px 12px rgba(76,16,224,0.07); }
.tx-row { display:flex; align-items:center; gap:12px; padding:12px 18px; border-bottom:1px solid #f0ecff; }
.tx-row:last-child { border-bottom:none; }
.tx-reason { flex:1; font-size:0.85rem; color:var(--text); }
.tx-date { font-size:0.75rem; color:var(--text-2); white-space:nowrap; }
.tx-amount { font-family:'Epilogue',sans-serif; font-weight:800; font-size:0.95rem; white-space:nowrap; }
.credit { color:#16a34a; }
.debit  { color:#dc2626; }

/* Admin info */
.admin-info { display:flex; align-items:flex-start; gap:12px; background:#f7f4ff; border-radius:14px; padding:16px 18px; font-size:0.84rem; color:var(--text-2); line-height:1.5; }
.admin-info svg { width:18px; height:18px; color:var(--purple); flex-shrink:0; margin-top:1px; }

/* Confirm modal */
.modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:500; display:flex; align-items:center; justify-content:center; padding:20px; backdrop-filter:blur(4px); }
.confirm-modal { background:white; border-radius:20px; width:100%; max-width:420px; overflow:hidden; box-shadow:0 20px 60px rgba(0,0,0,0.25); }
.cm-header { display:flex; align-items:center; gap:12px; padding:18px 22px; color:white; font-family:'Epilogue',sans-serif; font-weight:800; font-size:1.05rem; }
.cm-body { padding:20px 22px; display:flex; flex-direction:column; gap:10px; }
.cm-body p { font-size:0.9rem; color:var(--text-2); line-height:1.5; margin:0; }
.cm-body strong { color:var(--text); }
.cm-balance-row { display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-top:1px solid #f0ecff; font-size:0.88rem; color:var(--text-2); }
.cm-after { font-weight:700; }
.cm-bal  { color:#16a34a; font-weight:700; }
.cm-cost { color:#dc2626; font-weight:700; }
.cm-footer { display:flex; gap:10px; padding:16px 22px; border-top:1px solid #f0ecff; }
.cm-cancel { flex:1; padding:11px; border:1.5px solid #e2d9ff; border-radius:11px; background:none; cursor:pointer; font-weight:600; color:var(--text-2); }
.cm-confirm { flex:2; padding:11px; border:none; border-radius:11px; font-weight:700; cursor:pointer; color:white; font-size:0.9rem; }
.premium-btn.cm-confirm { background:linear-gradient(135deg,#fbbf24,#f97316); }
.official-btn.cm-confirm { background:#1d9bf0; }
</style>
