-- ============================================================
-- ONBSocial Beta 6.9 — ONB Coin System
-- Run this entire file in your Supabase SQL Editor
-- ============================================================

-- ─── 1. Add new columns to profiles ──────────────────────────
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS onb_coins             integer     NOT NULL DEFAULT 0;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS premium_expires_at    timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS premium_is_permanent  boolean     NOT NULL DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS official_expires_at   timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS official_is_permanent boolean     NOT NULL DEFAULT false;

-- ─── 2. coin_transactions — audit log ────────────────────────
CREATE TABLE IF NOT EXISTS public.coin_transactions (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid   NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  amount     integer NOT NULL,
  reason     text    NOT NULL DEFAULT 'admin_grant',
  admin_id   uuid    REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ─── 3. subscription_payments — monthly records ───────────────
CREATE TABLE IF NOT EXISTS public.subscription_payments (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid   NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  subscription text   NOT NULL CHECK (subscription IN ('premium','official')),
  coins_paid   integer NOT NULL,
  paid_at      timestamptz NOT NULL DEFAULT now(),
  valid_until  timestamptz NOT NULL
);

-- ─── 4. Row Level Security ────────────────────────────────────
ALTER TABLE public.coin_transactions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_payments ENABLE ROW LEVEL SECURITY;

-- coin_transactions: user sees own, admin sees all
DROP POLICY IF EXISTS "coin_tx_select_own"   ON public.coin_transactions;
DROP POLICY IF EXISTS "coin_tx_select_admin" ON public.coin_transactions;
DROP POLICY IF EXISTS "coin_tx_insert"       ON public.coin_transactions;

CREATE POLICY "coin_tx_select_own" ON public.coin_transactions
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "coin_tx_select_admin" ON public.coin_transactions
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
  );

CREATE POLICY "coin_tx_insert" ON public.coin_transactions
  FOR INSERT WITH CHECK (
    auth.uid() = user_id OR
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
  );

-- subscription_payments: user sees own, admin sees all
DROP POLICY IF EXISTS "sub_pay_select_own"   ON public.subscription_payments;
DROP POLICY IF EXISTS "sub_pay_select_admin" ON public.subscription_payments;
DROP POLICY IF EXISTS "sub_pay_insert"       ON public.subscription_payments;

CREATE POLICY "sub_pay_select_own" ON public.subscription_payments
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "sub_pay_select_admin" ON public.subscription_payments
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
  );

CREATE POLICY "sub_pay_insert" ON public.subscription_payments
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ─── 5. Function: admin_grant_coins ──────────────────────────
-- Admins call this to give/take coins. Enforces admin check inside.
CREATE OR REPLACE FUNCTION public.admin_grant_coins(
  target_user_id uuid,
  coin_amount    integer,
  grant_reason   text DEFAULT 'admin_grant'
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  caller_is_admin boolean;
  new_balance     integer;
BEGIN
  SELECT is_admin INTO caller_is_admin
  FROM public.profiles WHERE id = auth.uid();

  IF NOT COALESCE(caller_is_admin, false) THEN
    RAISE EXCEPTION 'Not authorized — admin only';
  END IF;

  UPDATE public.profiles
  SET onb_coins = onb_coins + coin_amount
  WHERE id = target_user_id
  RETURNING onb_coins INTO new_balance;

  INSERT INTO public.coin_transactions (user_id, amount, reason, admin_id)
  VALUES (target_user_id, coin_amount, grant_reason, auth.uid());

  RETURN jsonb_build_object('success', true, 'new_balance', new_balance);
END;
$$;

-- ─── 6. Function: buy_subscription ───────────────────────────
-- Users call this to spend coins and activate premium/official for 30 days.
CREATE OR REPLACE FUNCTION public.buy_subscription(sub_type text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  price          integer;
  cur_balance    integer;
  already_perm   boolean;
  cur_expires    timestamptz;
  new_balance    integer;
  new_expires_at timestamptz;
BEGIN
  -- Price table
  IF sub_type = 'premium' THEN
    price := 6700;
  ELSIF sub_type = 'official' THEN
    price := 300;
  ELSE
    RAISE EXCEPTION 'Invalid subscription type: %', sub_type;
  END IF;

  -- Get current profile state
  SELECT
    onb_coins,
    CASE sub_type
      WHEN 'premium'  THEN premium_is_permanent
      ELSE official_is_permanent
    END,
    CASE sub_type
      WHEN 'premium'  THEN premium_expires_at
      ELSE official_expires_at
    END
  INTO cur_balance, already_perm, cur_expires
  FROM public.profiles WHERE id = auth.uid();

  IF already_perm THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Already permanent — no payment needed'
    );
  END IF;

  IF cur_balance < price THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Insufficient ONB Coins',
      'balance', cur_balance,
      'price', price
    );
  END IF;

  -- Deduct coins
  UPDATE public.profiles
  SET onb_coins = onb_coins - price
  WHERE id = auth.uid()
  RETURNING onb_coins INTO new_balance;

  -- Extend from current expiry or from now, whichever is later
  new_expires_at := GREATEST(COALESCE(cur_expires, now()), now()) + interval '30 days';

  -- Activate subscription
  IF sub_type = 'premium' THEN
    UPDATE public.profiles
    SET is_premium = true, premium_expires_at = new_expires_at
    WHERE id = auth.uid();
  ELSE
    UPDATE public.profiles
    SET is_official = true, official_expires_at = new_expires_at
    WHERE id = auth.uid();
  END IF;

  -- Log coin spend
  INSERT INTO public.coin_transactions (user_id, amount, reason)
  VALUES (auth.uid(), -price, 'purchase_' || sub_type);

  -- Log payment record
  INSERT INTO public.subscription_payments (user_id, subscription, coins_paid, valid_until)
  VALUES (auth.uid(), sub_type, price, new_expires_at);

  RETURN jsonb_build_object(
    'success',    true,
    'new_balance', new_balance,
    'expires_at', new_expires_at,
    'subscription', sub_type
  );
END;
$$;

-- ─── 7. Function: expire_lapsed_subscriptions ────────────────
-- Run this periodically (e.g. via Supabase Edge Function cron)
-- or call it on demand to clean up expired subscriptions.
CREATE OR REPLACE FUNCTION public.expire_lapsed_subscriptions()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  -- Expire premium for non-permanent users whose time is up
  UPDATE public.profiles
  SET is_premium = false
  WHERE is_premium = true
    AND premium_is_permanent = false
    AND premium_expires_at IS NOT NULL
    AND premium_expires_at < now();

  -- Expire official for non-permanent users whose time is up
  UPDATE public.profiles
  SET is_official = false
  WHERE is_official = true
    AND official_is_permanent = false
    AND official_expires_at IS NOT NULL
    AND official_expires_at < now();
END;
$$;

-- ─── 8. Grant execute permissions ────────────────────────────
GRANT EXECUTE ON FUNCTION public.buy_subscription(text)                    TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_grant_coins(uuid, integer, text)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.expire_lapsed_subscriptions()             TO authenticated;

-- ─── 9. Admin shortcuts ──────────────────────────────────────
-- Grant coins to a user (replace values as needed):
-- UPDATE public.profiles SET onb_coins = onb_coins + 10000 WHERE username = 'YOUR_USERNAME';

-- Make premium permanent:
-- UPDATE public.profiles
--   SET is_premium = true, premium_is_permanent = true
--   WHERE username = 'YOUR_USERNAME';

-- Make official permanent:
-- UPDATE public.profiles
--   SET is_official = true, official_is_permanent = true
--   WHERE username = 'YOUR_USERNAME';

-- Check all user balances:
-- SELECT username, onb_coins, is_premium, premium_is_permanent,
--        premium_expires_at, is_official, official_is_permanent, official_expires_at
-- FROM public.profiles ORDER BY onb_coins DESC;

-- Run expiry cleanup manually:
-- SELECT expire_lapsed_subscriptions();
