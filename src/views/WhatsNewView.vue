<script setup>
const changelog = [
  {
    version: 'Beta 6.10',
    date: 'March 2026',
    badge: 'latest',
    entries: [
      { type: 'new',  text: 'Email verification for new accounts — clean verify page with resend button and 60s cooldown' },
      { type: 'new',  text: 'Email callback handler — smooth redirect after clicking the confirmation link' },
      { type: 'new',  text: 'Old accounts auto-verified — existing users are never blocked, only new signups require confirmation' },
      { type: 'fix',  text: 'Signup no longer uses browser alert() — replaced with a proper verification flow page' },
    ]
  },
  {
    version: 'Beta 6.9',
    date: 'March 2026',
    badge: null,
    entries: [
      { type: 'new', text: 'ONB Coins — internal currency system with wallet, balance display in sidebar' },
      { type: 'new', text: 'Coin Shop — buy Premium (6,700 coins/month) or Official status (300 coins/month)' },
      { type: 'new', text: 'Subscription management — 30-day renewable subscriptions with expiry tracking' },
      { type: 'new', text: 'Permanent subscriptions — admins can mark premium/official as permanent (no monthly cost)' },
      { type: 'new', text: 'Renewal modal — automatically shown when subscription expires in 7 days or less' },
      { type: 'new', text: 'Admin Coins tab — grant coins to users, set permanent status, view all balances' },
      { type: 'new', text: 'Transaction history — full audit log of every coin credit and debit' },
    ]
  },
  {
    version: 'Beta 6.7',
    date: 'March 2026',
    badge: 'latest',
    entries: [
      { type: 'new',  text: 'Groups — create community groups with banner images, join/leave, post media inside groups, like group posts' },
      { type: 'new',  text: 'Video-only Reels — Instagram-style vertical snap scroll, autoplay per reel, upload your own videos' },
      { type: 'new',  text: 'What\'s New page — full changelog accessible from the sidebar nav' },
      { type: 'fix',  text: 'Admin user management now shows all users; fixed blank table caused by missing RLS SELECT policies' },
      { type: 'fix',  text: 'Admin SQL Setup tab — one-click copy of all required migration SQL' },
      { type: 'new',  text: 'Custom profile banner — Premium users can upload a photo as banner (overrides gradient)' },
      { type: 'fix',  text: 'Messages — removed old group-chat system, keeping clean DM-only chat' },
    ]
  },
  {
    version: 'Beta 6.6',
    date: 'February 2026',
    badge: null,
    entries: [
      { type: 'new',  text: 'Official account badge (blue checkmark) — granted via SQL by admins' },
      { type: 'new',  text: 'Full-image lightbox — click any feed image to see it fullscreen' },
      { type: 'new',  text: 'Spam prevention — 30s post cooldown, 10s comment cooldown, duplicate comment detection' },
      { type: 'fix',  text: 'Delete post now properly cascades likes and comments' },
      { type: 'fix',  text: 'Post owner can delete any comment on their post' },
    ]
  },
  {
    version: 'Beta 6.5',
    date: 'January 2026',
    badge: null,
    entries: [
      { type: 'new',  text: 'Premium customisation — username colour picker (8 swatches)' },
      { type: 'new',  text: 'Banner gradient presets — Default / Sunset / Ocean / Forest / Rose / Gold / Midnight / Candy' },
      { type: 'new',  text: 'Chat background image — premium users can upload a custom chat wallpaper' },
      { type: 'new',  text: 'Video avatar support — premium users can upload mp4/webm/mov as avatar' },
      { type: 'new',  text: 'Premium gold crown badge and avatar ring' },
      { type: 'fix',  text: 'Delete own messages in chat (trash icon on hover)' },
    ]
  },
  {
    version: 'Beta 6.0',
    date: 'December 2025',
    badge: null,
    entries: [
      { type: 'new',  text: 'Real-time chat with image attachments and message editing' },
      { type: 'new',  text: 'Reels grid view — scroll, like and comment on posts' },
      { type: 'new',  text: 'Explore page — discover and follow other users' },
      { type: 'new',  text: 'Admin panel — user management, post moderation, broadcast announcements' },
      { type: 'new',  text: 'Mutual follows "Friends" sidebar section with quick chat shortcut' },
      { type: 'fix',  text: 'Session caching — no network call on every page navigation' },
    ]
  },
  {
    version: 'Beta 5.0',
    date: 'November 2025',
    badge: null,
    entries: [
      { type: 'new',  text: 'Initial launch — feed, posts with images, likes, comments' },
      { type: 'new',  text: 'Auth system — sign up / sign in with Supabase Auth' },
      { type: 'new',  text: 'User profiles with avatar upload and bio' },
      { type: 'new',  text: 'Follow system — follow/unfollow users, followers/following counts' },
    ]
  },
]

const typeLabel = { new: 'NEW', fix: 'FIX', improve: 'IMPROVED' }
const typeColor = { new: '#4C10E0', fix: '#22c55e', improve: '#f59e0b' }
const typeBg    = { new: '#f0eeff', fix: '#f0fdf4', improve: '#fffbeb' }
</script>

<template>
  <div class="wn-page">
    <div class="wn-inner">

      <div class="wn-hero">
        <div class="wn-hero-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        </div>
        <div>
          <h1>What's New</h1>
          <p>Every update to ONBSocial, documented.</p>
        </div>
        <span class="current-badge">Beta 6.7</span>
      </div>

      <div class="wn-feed">
        <div v-for="release in changelog" :key="release.version" class="release-card">

          <div class="release-header">
            <div class="release-ver">
              <span class="ver-text">{{ release.version }}</span>
              <span v-if="release.badge === 'latest'" class="latest-pill">Latest</span>
            </div>
            <span class="release-date">{{ release.date }}</span>
          </div>

          <div class="release-entries">
            <div v-for="e in release.entries" :key="e.text" class="entry">
              <span
                class="entry-type"
                :style="{ background: typeBg[e.type], color: typeColor[e.type] }"
              >{{ typeLabel[e.type] }}</span>
              <span class="entry-text">{{ e.text }}</span>
            </div>
          </div>

        </div>

        <div class="wn-footer">
          <p>ONBSocial is in active beta. More features coming soon.</p>
        </div>
      </div>

    </div>
  </div>
</template>

<style scoped>
.wn-page {
  padding: 32px;
  overflow-y: auto;
  height: 100%;
  box-sizing: border-box;
}
.wn-inner {
  max-width: 680px;
  margin: 0 auto;
}

/* Hero */
.wn-hero {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-bottom: 36px;
  padding-bottom: 28px;
  border-bottom: 1px solid #ede8ff;
}
.wn-hero-icon {
  width: 52px;
  height: 52px;
  background: var(--purple);
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.wn-hero-icon svg {
  width: 24px;
  height: 24px;
  color: white;
}
.wn-hero h1 {
  font-family: 'Epilogue', sans-serif;
  font-size: 1.6rem;
  font-weight: 800;
  color: var(--text);
}
.wn-hero p {
  font-size: 0.88rem;
  color: var(--text-2);
  margin-top: 3px;
}
.current-badge {
  margin-left: auto;
  padding: 8px 18px;
  background: var(--purple);
  color: white;
  border-radius: 20px;
  font-size: 0.82rem;
  font-weight: 700;
  flex-shrink: 0;
}

/* Feed */
.wn-feed {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.release-card {
  background: white;
  border-radius: 18px;
  overflow: hidden;
  box-shadow: 0 2px 14px rgba(76,16,224,0.07);
}

.release-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 22px 14px;
  border-bottom: 1px solid #f0ecff;
  gap: 12px;
}
.release-ver {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ver-text {
  font-family: 'Epilogue', sans-serif;
  font-size: 1.05rem;
  font-weight: 800;
  color: var(--text);
}
.latest-pill {
  padding: 3px 10px;
  background: #4C10E0;
  color: white;
  border-radius: 20px;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: .04em;
}
.release-date {
  font-size: 0.8rem;
  color: var(--text-2);
  font-weight: 500;
}

/* Entries */
.release-entries {
  padding: 14px 22px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.entry {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  line-height: 1.5;
}
.entry-type {
  display: inline-block;
  font-size: 0.65rem;
  font-weight: 800;
  letter-spacing: .07em;
  padding: 2px 7px;
  border-radius: 6px;
  flex-shrink: 0;
  margin-top: 2px;
}
.entry-text {
  font-size: 0.88rem;
  color: var(--text-2);
}

/* Footer */
.wn-footer {
  text-align: center;
  padding: 28px 0 8px;
  color: var(--text-2);
  font-size: 0.82rem;
  opacity: 0.7;
}

@media (max-width: 600px) {
  .wn-page { padding: 16px; }
  .wn-hero { gap: 12px; }
  .wn-hero h1 { font-size: 1.3rem; }
  .current-badge { display: none; }
}
</style>
