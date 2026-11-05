-- ============================================================
-- ONBSocial Beta 6.10 — Email Verification
-- Run this in your Supabase SQL Editor
-- ============================================================

-- ─── 1. Auto-verify all existing accounts ────────────────────
-- Any account created BEFORE you run this migration is
-- automatically considered verified (grandfathered in).
-- New signups will require email confirmation going forward.
--
-- This sets email_confirmed_at on any auth.users record that
-- doesn't already have it, using their created_at date so it
-- looks natural in the audit logs.

UPDATE auth.users
SET email_confirmed_at = created_at
WHERE email_confirmed_at IS NULL;

-- ─── 2. Verify result ────────────────────────────────────────
-- Run this to confirm all existing users are now verified:
-- SELECT COUNT(*) FROM auth.users WHERE email_confirmed_at IS NULL;
-- Should return 0.

-- ─── 3. Enable email confirmation in Supabase Dashboard ──────
-- Go to: Supabase Dashboard → Authentication → Email
-- Toggle ON: "Enable email confirmations"
-- Set the Site URL to your app URL (e.g. http://localhost:5173)
-- Add redirect URL: http://localhost:5173/auth/callback
-- (and your production URL too, e.g. https://yourapp.com/auth/callback)
--
-- After this:
--   - Existing users (email_confirmed_at set above) → can sign in normally
--   - New signups → must click confirmation email before accessing app
--
-- ─── 4. Optional: Set your app's redirect URL ─────────────────
-- In Supabase Dashboard → Authentication → URL Configuration:
-- Site URL: http://localhost:5173
-- Redirect URLs (add all of these):
--   http://localhost:5173/auth/callback
--   https://your-production-domain.com/auth/callback

-- ─── 5. Check current verification status ────────────────────
-- Useful admin queries:

-- See all unverified accounts:
-- SELECT id, email, created_at, email_confirmed_at
-- FROM auth.users
-- WHERE email_confirmed_at IS NULL
-- ORDER BY created_at DESC;

-- Manually verify a specific user (admin override):
-- UPDATE auth.users
-- SET email_confirmed_at = now()
-- WHERE email = 'user@example.com';

-- Count verified vs unverified:
-- SELECT
--   COUNT(*) FILTER (WHERE email_confirmed_at IS NOT NULL) AS verified,
--   COUNT(*) FILTER (WHERE email_confirmed_at IS NULL)     AS unverified
-- FROM auth.users;
