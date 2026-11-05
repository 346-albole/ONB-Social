-- ============================================================
-- ONBSocial v9 — ONB Coin Internal Currency + Subscriptions
-- Run in Supabase SQL Editor
-- ============================================================

-- ─── 1. Add coin balance + subscription columns to profiles ──
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS onb_coins            integer NOT NULL DEFAULT 0;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS premium_expires_at   timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS premium_is_permanent boolean NOT NULL DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS official_expires_at  timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS official_is_permanent boolean NOT NULL DEFAULT false;

-- ─── 2. Table: coin_transactions (audit log of every coin change) ──
CREATE TABLE IF NOT EXISTS public.coin_transactions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  amount       integer NOT NULL,          -- positive = credit, negative = debit
  reason       text NOT NULL,             -- 'admin_grant' | 'purchase_premium' | 'purchase_official' | 'refund'
  admin_id     uuid REFERENCES public.profiles(id),  -- set when admin grants coins
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ─── 3. Table: subscription_payments (monthly payment records) ──
CREATE TABLE IF NOT EXISTS public.subscription_payments (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  subscription    text NOT NULL CHECK (subscription IN ('premium', 'official')),
  coins_paid      integer NOT NULL,
  paid_at         timestamptz NOT NULL DEFAULT now(),
  valid_until     timestamptz NOT NULL   -- paid_at + 30 days
);

-- ─── 4. RLS ───────────────────────────────────────────────────

ALTER TABLE public.coin_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_payments ENABLE ROW LEVEL SECURITY;

-- Users can read their own transactions
DROP POLICY IF EXISTS "coin_tx_select_own" ON public.coin_transactions;
CREATE POLICY "coin_tx_select_own" ON public.coin_transactions
  FOR SELECT USING (auth.uid() = user_id);

-- Admins can read all transactions
DROP POLICY IF EXISTS "coin_tx_select_admin" ON public.coin_transactions;
CREATE POLICY "coin_tx_select_admin" ON public.coin_transactions
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
  );

-- Only the system (via RLS bypass) inserts transactions — users cannot insert directly
-- We allow inserts from authenticated users only for their own user_id
-- (the real guard is at the application level via Supabase service key or RPC)
DROP POLICY IF EXISTS "coin_tx_insert" ON public.coin_transactions;
CREATE POLICY "coin_tx_insert" ON public.coin_transactions
  FOR INSERT WITH CHECK (auth.uid() = user_id OR
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
  );

-- Users read own payments
DROP POLICY IF EXISTS "sub_pay_select_own" ON public.subscription_payments;
CREATE POLICY "sub_pay_select_own" ON public.subscription_payments
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "sub_pay_select_admin" ON public.subscription_payments;
CREATE POLICY "sub_pay_select_admin" ON public.subscription_payments
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
  );

DROP POLICY IF EXISTS "sub_pay_insert" ON public.subscription_payments;
CREATE POLICY "sub_pay_insert" ON public.subscription_payments
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ─── 5. Stored procedure: admin_grant_coins ───────────────────
-- Admins call this to give coins to a user
CREATE OR REPLACE FUNCTION public.admin_grant_coins(
  target_user_id uuid,
  coin_amount    integer,
  grant_reason   text DEFAULT 'admin_grant'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  caller_is_admin boolean;
  new_balance     integer;
BEGIN
  -- Verify caller is admin
  SELECT is_admin INTO caller_is_admin FROM public.profiles WHERE id = auth.uid();
  IF NOT caller_is_admin THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Update balance
  UPDATE public.profiles
  SET onb_coins = onb_coins + coin_amount
  WHERE id = target_user_id
  RETURNING onb_coins INTO new_balance;

  -- Log transaction
  INSERT INTO public.coin_transactions (user_id, amount, reason, admin_id)
  VALUES (target_user_id, coin_amount, grant_reason, auth.uid());

  RETURN jsonb_build_object('success', true, 'new_balance', new_balance);
END;
$$;

-- ─── 6. Stored procedure: buy_subscription ────────────────────
-- Users call this to spend coins and activate premium/official
CREATE OR REPLACE FUNCTION public.buy_subscription(
  sub_type text  -- 'premium' or 'official'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  price           integer;
  cur_balance     integer;
  already_perm    boolean;
  new_balance     integer;
  new_expires_at  timestamptz;
BEGIN
  -- Price table
  IF sub_type = 'premium' THEN
    price := 6700;
  ELSIF sub_type = 'official' THEN
    price := 300;
  ELSE
    RAISE EXCEPTION 'Invalid subscription type';
  END IF;

  -- Get current user profile
  SELECT onb_coins,
    CASE sub_type WHEN 'premium' THEN premium_is_permanent ELSE official_is_permanent END
  INTO cur_balance, already_perm
  FROM public.profiles WHERE id = auth.uid();

  -- Don't charge if already permanent
  IF already_perm THEN
    RETURN jsonb_build_object('success', false, 'error', 'Already permanent, no payment needed');
  END IF;

  -- Check balance
  IF cur_balance < price THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient ONB Coins', 'balance', cur_balance, 'price', price);
  END IF;

  -- Deduct coins
  UPDATE public.profiles
  SET onb_coins = onb_coins - price
  WHERE id = auth.uid()
  RETURNING onb_coins INTO new_balance;

  -- Extend or create subscription (renew from today if expired, else extend)
  new_expires_at := GREATEST(
    CASE sub_type
      WHEN 'premium' THEN (SELECT premium_expires_at FROM public.profiles WHERE id = auth.uid())
      ELSE (SELECT official_expires_at FROM public.profiles WHERE id = auth.uid())
    END,
    now()
  ) + interval '30 days';

  -- Update profile subscription
  IF sub_type = 'premium' THEN
    UPDATE public.profiles
    SET is_premium = true, premium_expires_at = new_expires_at
    WHERE id = auth.uid();
  ELSE
    UPDATE public.profiles
    SET is_official = true, official_expires_at = new_expires_at
    WHERE id = auth.uid();
  END IF;

  -- Log coin deduction
  INSERT INTO public.coin_transactions (user_id, amount, reason)
  VALUES (auth.uid(), -price, 'purchase_' || sub_type);

  -- Log payment
  INSERT INTO public.subscription_payments (user_id, subscription, coins_paid, valid_until)
  VALUES (auth.uid(), sub_type, price, new_expires_at);

  RETURN jsonb_build_object(
    'success', true,
    'new_balance', new_balance,
    'expires_at', new_expires_at,
    'subscription', sub_type
  );
END;
$$;

-- ─── 7. Stored procedure: check_expired_subscriptions ─────────
-- Call periodically (or on login) to expire lapsed subscriptions
-- NOTE: In production, run this via a Supabase Edge Function cron
CREATE OR REPLACE FUNCTION public.expire_lapsed_subscriptions()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Expire premium
  UPDATE public.profiles
  SET is_premium = false
  WHERE is_premium = true
    AND premium_is_permanent = false
    AND premium_expires_at IS NOT NULL
    AND premium_expires_at < now();

  -- Expire official
  UPDATE public.profiles
  SET is_official = false
  WHERE is_official = true
    AND official_is_permanent = false
    AND official_expires_at IS NOT NULL
    AND official_expires_at < now();
END;
$$;

-- Grant execute to authenticated users (for buy_subscription)
GRANT EXECUTE ON FUNCTION public.buy_subscription(text) TO authenticated;
-- admin_grant_coins: only admins (enforced inside function)
GRANT EXECUTE ON FUNCTION public.admin_grant_coins(uuid, integer, text) TO authenticated;

-- ─── 8. Admin: grant coins manually (SQL shortcut) ────────────
-- Example: UPDATE public.profiles SET onb_coins = onb_coins + 10000 WHERE username = 'yourusername';
-- Or call: SELECT admin_grant_coins('USER-UUID-HERE', 10000, 'welcome_bonus');

-- ─── 9. Make premium/official permanent (SQL shortcut) ────────
-- UPDATE public.profiles SET premium_is_permanent = true, is_premium = true WHERE username = 'yourusername';
-- UPDATE public.profiles SET official_is_permanent = true, is_official = true WHERE username = 'yourusername';

COMMENT ON COLUMN public.profiles.onb_coins IS 'ONB Coin balance — only admins should credit via SQL or admin_grant_coins()';
COMMENT ON COLUMN public.profiles.premium_is_permanent IS 'If true, premium never expires and no monthly payment needed';
COMMENT ON COLUMN public.profiles.official_is_permanent IS 'If true, official status never expires and no monthly payment needed';
