-- =============================================================================
-- ONB-Social — schéma PostgreSQL consolidé
-- =============================================================================
-- Recrée l'état final du schéma à partir des anciennes migrations Supabase :
--   migration/MIGRATION.sql, MIGRATION_V4 … V15, MIGRATION_V9_COINS,
--   MIGRATION_NOTIFICATIONS, supabase/migrations/*, setup_site_settings.sql
-- (ROLLBACK_V7.sql et MIGRATION_V10_EMAIL_VERIFICATION.sql ignorés).
--
-- Retiré par rapport à Supabase :
--   * FK vers auth.users                → FK vers public.profiles(id)
--   * trigger handle_new_user            → upsert du profil par l'API
--   * publication supabase_realtime, REPLICA IDENTITY → temps réel géré par l'API
--   * fonction admin_run_sql             → supprimée (aucun équivalent)
--   * table group_chats (MIGRATION.sql)  → remplacée dès V4 par public.groups
--
-- Doit être exécuté par un rôle propriétaire (superuser en local, admin du
-- serveur sur Azure). Compatible PostgreSQL 16.
-- =============================================================================

SET client_min_messages = warning;

-- -----------------------------------------------------------------------------
-- 0. Rôles et shim « auth » (compatibilité avec les policies RLS existantes)
-- -----------------------------------------------------------------------------
-- L'API se connecte avec un rôle LOGIN non-superuser membre de ces deux rôles,
-- puis, pour chaque requête :
--   BEGIN;
--   SET LOCAL ROLE authenticated;
--   SELECT set_config('request.jwt.claim.sub', '<uuid utilisateur>', true);
--   ...
--   COMMIT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;

-- Identifiant de l'utilisateur courant (NULL si anonyme).
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

-- Rôle courant au sens Supabase ('authenticated' | 'anon').
CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    CASE WHEN auth.uid() IS NULL THEN 'anon' ELSE 'authenticated' END
  )
$$;

-- -----------------------------------------------------------------------------
-- 1. Profils
-- -----------------------------------------------------------------------------
-- La table de base venait du template Supabase (jamais créée par les migrations).
-- Colonnes ajoutées ensuite par V4/V5/V6/V7/V9_COINS/V15/V16/20260325_moderation.
-- profiles.id = identifiant de l'utilisateur dans le fournisseur d'identité
-- (claim `oid` d'Entra ID par défaut).
CREATE TABLE public.profiles (
  id                    uuid PRIMARY KEY,
  email                 text,
  username              text UNIQUE,
  full_name             text,
  bio                   text,
  avatar_url            text,
  banner_url            text,
  banner_color          text,
  custom_badge_url      text,
  chat_bg_url           text,
  username_color        text,
  is_admin              boolean NOT NULL DEFAULT false,
  is_premium            boolean NOT NULL DEFAULT false,
  is_official           boolean NOT NULL DEFAULT false,
  onb_coins             integer NOT NULL DEFAULT 0,
  premium_expires_at    timestamptz,
  premium_is_permanent  boolean NOT NULL DEFAULT false,
  official_expires_at   timestamptz,
  official_is_permanent boolean NOT NULL DEFAULT false,
  warnings_count        integer NOT NULL DEFAULT 0,
  is_banned             boolean NOT NULL DEFAULT false,
  is_anonymous          boolean NOT NULL DEFAULT false,
  is_invisible          boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

-- is_admin(uuid) — V13. SECURITY DEFINER : utilisable dans les policies.
CREATE OR REPLACE FUNCTION public.is_admin(user_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _is_admin boolean;
BEGIN
  SELECT profiles.is_admin INTO _is_admin FROM public.profiles WHERE id = user_id;
  RETURN COALESCE(_is_admin, false);
END;
$$;

-- Garde des colonnes sensibles (nouveau).
-- La policy historique profiles_update_own autorise un utilisateur à modifier
-- n'importe quelle colonne de son profil (y compris is_admin, onb_coins…).
-- Ce trigger ne s'applique qu'aux requêtes exécutées sous le rôle
-- `authenticated` par un non-admin ; les fonctions SECURITY DEFINER
-- (buy_subscription, admin_grant_coins…) s'exécutent sous le propriétaire et
-- ne sont pas concernées.
-- Exceptions conservées pour moderation.js (côté navigateur) :
-- warnings_count peut seulement augmenter, is_banned peut seulement passer à true.
CREATE OR REPLACE FUNCTION public.profiles_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user <> 'authenticated' OR public.is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.is_admin              := false;
    NEW.is_premium            := false;
    NEW.is_official           := false;
    NEW.onb_coins             := 0;
    NEW.premium_expires_at    := NULL;
    NEW.premium_is_permanent  := false;
    NEW.official_expires_at   := NULL;
    NEW.official_is_permanent := false;
    NEW.warnings_count        := 0;
    NEW.is_banned             := false;
    NEW.is_anonymous          := false;
    NEW.is_invisible          := false;
    NEW.created_at            := now();
    RETURN NEW;
  END IF;

  -- UPDATE
  NEW.id                    := OLD.id;
  NEW.email                 := OLD.email;
  NEW.created_at            := OLD.created_at;
  NEW.is_admin              := OLD.is_admin;
  NEW.is_premium            := OLD.is_premium;
  NEW.is_official           := OLD.is_official;
  NEW.onb_coins             := OLD.onb_coins;
  NEW.premium_expires_at    := OLD.premium_expires_at;
  NEW.premium_is_permanent  := OLD.premium_is_permanent;
  NEW.official_expires_at   := OLD.official_expires_at;
  NEW.official_is_permanent := OLD.official_is_permanent;
  NEW.is_anonymous          := OLD.is_anonymous;
  NEW.is_invisible          := OLD.is_invisible;
  NEW.warnings_count        := GREATEST(NEW.warnings_count, OLD.warnings_count);
  NEW.is_banned             := OLD.is_banned OR NEW.is_banned;
  RETURN NEW;
END;
$$;

CREATE TRIGGER profiles_guard
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_guard();

-- -----------------------------------------------------------------------------
-- 2. Feed : posts, likes, commentaires, follows (V4, V6, V16)
-- -----------------------------------------------------------------------------
CREATE TABLE public.posts (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  caption    text,
  media_url  text NOT NULL,
  views      bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.likes (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid   NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  post_id bigint NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  CONSTRAINT likes_user_post_uniq UNIQUE (user_id, post_id)
);

CREATE TABLE public.comments (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid   NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  post_id    bigint NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  content    text   NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.follows (
  follower_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  following_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  CONSTRAINT follows_pkey PRIMARY KEY (follower_id, following_id)
);

CREATE INDEX idx_posts_created     ON public.posts(created_at DESC);
CREATE INDEX idx_posts_user        ON public.posts(user_id);
CREATE INDEX idx_likes_post        ON public.likes(post_id);
CREATE INDEX idx_likes_user        ON public.likes(user_id);
CREATE INDEX idx_comments_post     ON public.comments(post_id);
CREATE INDEX idx_follows_follower  ON public.follows(follower_id);
CREATE INDEX idx_follows_following ON public.follows(following_id);

-- Compteur de vues (V16)
CREATE OR REPLACE FUNCTION public.increment_post_views(post_id bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.posts SET views = views + 1 WHERE id = post_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Messages privés (V4, MIGRATION.sql, V12)
-- -----------------------------------------------------------------------------
CREATE TABLE public.messages (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sender_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  receiver_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content     text NOT NULL,
  image_url   text,
  read        boolean NOT NULL DEFAULT false,
  edited      boolean DEFAULT false,
  deleted     boolean DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

CREATE INDEX idx_messages_sender   ON public.messages(sender_id, created_at DESC);
CREATE INDEX idx_messages_receiver ON public.messages(receiver_id, created_at DESC);
CREATE INDEX idx_messages_dm       ON public.messages(sender_id, receiver_id, created_at DESC);

CREATE TABLE public.blocks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (blocker_id, blocked_id)
);

-- Interdit l'envoi d'un DM entre deux utilisateurs dont l'un a bloqué l'autre.
-- SECURITY DEFINER : la policy de blocks ne laisse voir que ses propres lignes.
CREATE OR REPLACE FUNCTION public.check_message_block()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.blocks
    WHERE (blocker_id = NEW.sender_id   AND blocked_id = NEW.receiver_id)
       OR (blocker_id = NEW.receiver_id AND blocked_id = NEW.sender_id)
  ) THEN
    RAISE EXCEPTION 'Blocked from messaging this user';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER restrict_blocked_messages
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.check_message_block();

-- -----------------------------------------------------------------------------
-- 4. Groupes (V4 → V6)
-- -----------------------------------------------------------------------------
CREATE TABLE public.groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text,
  banner_url  text,
  created_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  is_private  boolean DEFAULT false,
  created_at  timestamptz DEFAULT now()
);

CREATE TABLE public.group_members (
  group_id  uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role      text DEFAULT 'member',   -- 'admin' | 'member'
  joined_at timestamptz DEFAULT now(),
  CONSTRAINT group_members_pkey PRIMARY KEY (group_id, user_id)
);

CREATE TABLE public.group_messages (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id   uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  sender_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content    text,
  image_url  text,
  edited     boolean DEFAULT false,
  deleted    boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Non utilisées par le front actuel, conservées (V4).
CREATE TABLE public.group_posts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id   uuid REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  media_url  text NOT NULL,
  caption    text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.group_post_likes (
  post_id uuid NOT NULL REFERENCES public.group_posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  CONSTRAINT group_post_likes_pkey PRIMARY KEY (post_id, user_id)
);

CREATE INDEX idx_group_msgs_group      ON public.group_messages(group_id, created_at ASC);
CREATE INDEX idx_group_members_user    ON public.group_members(user_id);

-- -----------------------------------------------------------------------------
-- 5. Chat global (V7/V8)
-- -----------------------------------------------------------------------------
CREATE TABLE public.global_messages (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sender_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content    text NOT NULL,
  edited     boolean NOT NULL DEFAULT false,
  deleted    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_global_msgs_created ON public.global_messages(created_at ASC);
CREATE INDEX idx_global_msgs_sender  ON public.global_messages(sender_id);

-- -----------------------------------------------------------------------------
-- 6. Annonces et broadcasts admin (V4 → V6)
-- -----------------------------------------------------------------------------
CREATE TABLE public.announcements (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  content    text NOT NULL,
  type       text DEFAULT 'info',
  active     boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- js_content est exécuté dans le navigateur de chaque utilisateur (HomeView,
-- `new Function`) : réservé aux admins par RLS, comportement conservé.
CREATE TABLE public.admin_broadcasts (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  title          text,
  html_content   text,
  js_content     text,
  broadcast_type text DEFAULT 'banner',
  active         boolean DEFAULT true,
  created_at     timestamptz DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 7. Forum (V7/V8)
-- -----------------------------------------------------------------------------
CREATE TABLE public.forum_posts (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title      text NOT NULL,
  content    text,
  image_url  text,
  category   text NOT NULL DEFAULT 'general',
  pinned     boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.forum_comments (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id    bigint NOT NULL REFERENCES public.forum_posts(id) ON DELETE CASCADE,
  user_id    uuid   NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  parent_id  bigint REFERENCES public.forum_comments(id) ON DELETE CASCADE,
  content    text   NOT NULL,
  edited     boolean NOT NULL DEFAULT false,
  deleted    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.forum_votes (
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  post_id    bigint REFERENCES public.forum_posts(id) ON DELETE CASCADE,
  comment_id bigint REFERENCES public.forum_comments(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT forum_votes_xor CHECK (
    (post_id IS NOT NULL AND comment_id IS NULL) OR
    (post_id IS NULL     AND comment_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX forum_votes_post_uniq
  ON public.forum_votes (user_id, post_id)    WHERE post_id IS NOT NULL AND comment_id IS NULL;
CREATE UNIQUE INDEX forum_votes_comment_uniq
  ON public.forum_votes (user_id, comment_id) WHERE comment_id IS NOT NULL AND post_id IS NULL;
CREATE INDEX idx_forum_posts_cat_date ON public.forum_posts(category, created_at DESC);
CREATE INDEX idx_forum_comments_post  ON public.forum_comments(post_id, created_at ASC);
CREATE INDEX idx_forum_votes_post     ON public.forum_votes(post_id)    WHERE post_id IS NOT NULL;
CREATE INDEX idx_forum_votes_comment  ON public.forum_votes(comment_id) WHERE comment_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 8. ONB Coins et abonnements (V9_COINS)
-- -----------------------------------------------------------------------------
CREATE TABLE public.coin_transactions (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid    NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  amount     integer NOT NULL,                       -- >0 crédit, <0 débit
  reason     text    NOT NULL DEFAULT 'admin_grant', -- admin_grant | purchase_premium | purchase_official | refund
  admin_id   uuid    REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.subscription_payments (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid    NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  subscription text    NOT NULL CHECK (subscription IN ('premium', 'official')),
  coins_paid   integer NOT NULL,
  paid_at      timestamptz NOT NULL DEFAULT now(),
  valid_until  timestamptz NOT NULL
);

CREATE INDEX idx_coin_tx_user ON public.coin_transactions(user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.admin_grant_coins(
  target_user_id uuid,
  coin_amount    integer,
  grant_reason   text DEFAULT 'admin_grant'
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller_is_admin boolean;
  new_balance     integer;
BEGIN
  SELECT is_admin INTO caller_is_admin FROM public.profiles WHERE id = auth.uid();
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

CREATE OR REPLACE FUNCTION public.buy_subscription(sub_type text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  price          integer;
  cur_balance    integer;
  already_perm   boolean;
  cur_expires    timestamptz;
  new_balance    integer;
  new_expires_at timestamptz;
BEGIN
  IF sub_type = 'premium' THEN
    price := 6700;
  ELSIF sub_type = 'official' THEN
    price := 300;
  ELSE
    RAISE EXCEPTION 'Invalid subscription type: %', sub_type;
  END IF;

  SELECT onb_coins,
         CASE sub_type WHEN 'premium' THEN premium_is_permanent ELSE official_is_permanent END,
         CASE sub_type WHEN 'premium' THEN premium_expires_at   ELSE official_expires_at   END
    INTO cur_balance, already_perm, cur_expires
    FROM public.profiles WHERE id = auth.uid();

  IF already_perm THEN
    RETURN jsonb_build_object('success', false, 'error', 'Already permanent — no payment needed');
  END IF;

  IF cur_balance < price THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient ONB Coins',
                              'balance', cur_balance, 'price', price);
  END IF;

  UPDATE public.profiles SET onb_coins = onb_coins - price
   WHERE id = auth.uid()
  RETURNING onb_coins INTO new_balance;

  new_expires_at := GREATEST(COALESCE(cur_expires, now()), now()) + interval '30 days';

  IF sub_type = 'premium' THEN
    UPDATE public.profiles SET is_premium = true, premium_expires_at = new_expires_at WHERE id = auth.uid();
  ELSE
    UPDATE public.profiles SET is_official = true, official_expires_at = new_expires_at WHERE id = auth.uid();
  END IF;

  INSERT INTO public.coin_transactions (user_id, amount, reason)
  VALUES (auth.uid(), -price, 'purchase_' || sub_type);

  INSERT INTO public.subscription_payments (user_id, subscription, coins_paid, valid_until)
  VALUES (auth.uid(), sub_type, price, new_expires_at);

  RETURN jsonb_build_object('success', true, 'new_balance', new_balance,
                            'expires_at', new_expires_at, 'subscription', sub_type);
END;
$$;

CREATE OR REPLACE FUNCTION public.expire_lapsed_subscriptions()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.profiles SET is_premium = false
   WHERE is_premium AND NOT premium_is_permanent
     AND premium_expires_at IS NOT NULL AND premium_expires_at < now();
  UPDATE public.profiles SET is_official = false
   WHERE is_official AND NOT official_is_permanent
     AND official_expires_at IS NOT NULL AND official_expires_at < now();
END;
$$;

-- -----------------------------------------------------------------------------
-- 9. Notifications (MIGRATION_NOTIFICATIONS)
-- -----------------------------------------------------------------------------
CREATE TABLE public.notifications (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type       text,      -- like | comment | follow | mention
  message    text,
  is_read    boolean NOT NULL DEFAULT false,
  actor_id   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  post_id    bigint REFERENCES public.posts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notifications_user_id_idx    ON public.notifications(user_id);
CREATE INDEX notifications_created_at_idx ON public.notifications(created_at DESC);

-- `messages` et `groups` ajoutées : ce sont les colonnes lues/écrites par
-- ProfileView.vue (absentes de la migration d'origine).
CREATE TABLE public.notification_preferences (
  user_id    uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  likes      boolean NOT NULL DEFAULT true,
  comments   boolean NOT NULL DEFAULT true,
  follows    boolean NOT NULL DEFAULT true,
  mentions   boolean NOT NULL DEFAULT true,
  messages   boolean NOT NULL DEFAULT true,
  groups     boolean NOT NULL DEFAULT true,
  updated_at timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.handle_new_like()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  post_owner uuid;
  liker_name text;
BEGIN
  SELECT user_id INTO post_owner FROM public.posts WHERE id = NEW.post_id;
  IF post_owner = NEW.user_id THEN RETURN NEW; END IF;
  SELECT username INTO liker_name FROM public.profiles WHERE id = NEW.user_id;
  IF EXISTS (SELECT 1 FROM public.notification_preferences
              WHERE user_id = post_owner AND likes = false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.notifications (user_id, type, message, actor_id, post_id)
  VALUES (post_owner, 'like', liker_name || ' a aimé votre publication', NEW.user_id, NEW.post_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_new_comment()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  post_owner     uuid;
  commenter_name text;
BEGIN
  SELECT user_id INTO post_owner FROM public.posts WHERE id = NEW.post_id;
  IF post_owner = NEW.user_id THEN RETURN NEW; END IF;
  SELECT username INTO commenter_name FROM public.profiles WHERE id = NEW.user_id;
  IF EXISTS (SELECT 1 FROM public.notification_preferences
              WHERE user_id = post_owner AND comments = false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.notifications (user_id, type, message, actor_id, post_id)
  VALUES (post_owner, 'comment', commenter_name || ' a commenté votre publication', NEW.user_id, NEW.post_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_new_follow()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  follower_name text;
BEGIN
  SELECT username INTO follower_name FROM public.profiles WHERE id = NEW.follower_id;
  IF EXISTS (SELECT 1 FROM public.notification_preferences
              WHERE user_id = NEW.following_id AND follows = false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.notifications (user_id, type, message, actor_id)
  VALUES (NEW.following_id, 'follow', follower_name || ' a commencé à vous suivre', NEW.follower_id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_new_like    AFTER INSERT ON public.likes    FOR EACH ROW EXECUTE FUNCTION public.handle_new_like();
CREATE TRIGGER on_new_comment AFTER INSERT ON public.comments FOR EACH ROW EXECUTE FUNCTION public.handle_new_comment();
CREATE TRIGGER on_new_follow  AFTER INSERT ON public.follows  FOR EACH ROW EXECUTE FUNCTION public.handle_new_follow();

-- -----------------------------------------------------------------------------
-- 10. Commandes admin (rechargement à distance — V13)
-- -----------------------------------------------------------------------------
CREATE TABLE public.admin_commands (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  admin_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  command        text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 11. Modération et curation (V14)
-- -----------------------------------------------------------------------------
-- Les colonnes created_by/featured_by/admin_id étaient « NOT NULL … ON DELETE
-- SET NULL » (contradictoire : la suppression d'un admin échouait) → nullables.
CREATE TABLE public.user_reports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reported_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  content_type     varchar(50)  NOT NULL CHECK (content_type IN ('post', 'comment', 'message', 'profile', 'reel')),
  content_id       text         NOT NULL,
  reason           varchar(255) NOT NULL,
  severity         varchar(20)  NOT NULL DEFAULT 'low'     CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status           varchar(50)  NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewing', 'resolved', 'dismissed')),
  moderator_notes  text,
  resolved_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  resolved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.moderation_flags (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type varchar(50)  NOT NULL CHECK (content_type IN ('post', 'comment', 'message', 'reel')),
  content_id   text         NOT NULL,
  flag_type    varchar(100) NOT NULL CHECK (flag_type IN ('spam', 'inappropriate', 'forbidden_word', 'auto_detected', 'manual')),
  severity     varchar(20)  NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  auto_flagged boolean NOT NULL DEFAULT false,
  resolved     boolean NOT NULL DEFAULT false,
  flagged_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.forbidden_words (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  word       varchar(255) NOT NULL UNIQUE,
  severity   varchar(20)  NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  enabled    boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.featured_content (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type   varchar(50) NOT NULL CHECK (content_type IN ('post', 'reel', 'forum_post')),
  content_id     text        NOT NULL,
  featured_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  featured_at    timestamptz NOT NULL DEFAULT now(),
  featured_until timestamptz,
  "position"     integer NOT NULL DEFAULT 0,
  views_count    integer NOT NULL DEFAULT 0,
  clicks_count   integer NOT NULL DEFAULT 0,
  section        varchar(50) NOT NULL DEFAULT 'homepage' CHECK (section IN ('homepage', 'explore', 'trending')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.content_curation_rules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_name  varchar(255) NOT NULL,
  rule_type  varchar(50)  NOT NULL CHECK (rule_type IN ('boost', 'hide', 'recommend', 'flag')),
  criteria   jsonb        NOT NULL DEFAULT '{}',
  "action"   varchar(100) NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.trending_content (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type     varchar(50) NOT NULL CHECK (content_type IN ('post', 'reel', 'forum_post')),
  content_id       text        NOT NULL,
  trend_score      double precision NOT NULL DEFAULT 0.0,
  engagement_count integer NOT NULL DEFAULT 0,
  time_window      varchar(20) NOT NULL DEFAULT '24h' CHECK (time_window IN ('24h', '7d', 'all')),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.moderation_action_logs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  action_type         varchar(50) NOT NULL CHECK (action_type IN (
                        'warn_user', 'ban_user', 'unban_user', 'delete_content', 'flag_content',
                        'resolve_report', 'dismiss_report', 'feature_content', 'unfeature_content')),
  target_user_id      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  target_content_type varchar(50),
  target_content_id   text,
  reason              text,
  metadata            jsonb DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_reports_status          ON public.user_reports(status);
CREATE INDEX idx_user_reports_severity        ON public.user_reports(severity);
CREATE INDEX idx_user_reports_reported_user   ON public.user_reports(reported_user_id);
CREATE INDEX idx_user_reports_created_at      ON public.user_reports(created_at DESC);
CREATE INDEX idx_moderation_flags_resolved    ON public.moderation_flags(resolved);
CREATE INDEX idx_moderation_flags_flag_type   ON public.moderation_flags(flag_type);
CREATE INDEX idx_moderation_flags_created_at  ON public.moderation_flags(created_at DESC);
CREATE INDEX idx_forbidden_words_enabled      ON public.forbidden_words(enabled);
CREATE INDEX idx_featured_content_section     ON public.featured_content(section);
CREATE INDEX idx_featured_content_position    ON public.featured_content("position");
CREATE INDEX idx_featured_content_until       ON public.featured_content(featured_until);
CREATE INDEX idx_curation_rules_rule_type     ON public.content_curation_rules(rule_type);
CREATE INDEX idx_curation_rules_enabled       ON public.content_curation_rules(enabled);
CREATE UNIQUE INDEX idx_trending_content_unique ON public.trending_content(content_type, content_id, time_window);
CREATE INDEX idx_trending_content_score       ON public.trending_content(trend_score DESC);
CREATE INDEX idx_trending_content_updated_at  ON public.trending_content(updated_at DESC);
CREATE INDEX idx_mod_logs_target_user         ON public.moderation_action_logs(target_user_id);
CREATE INDEX idx_mod_logs_created_at          ON public.moderation_action_logs(created_at DESC);
CREATE INDEX idx_mod_logs_admin_id            ON public.moderation_action_logs(admin_id);
CREATE INDEX idx_mod_logs_action_type         ON public.moderation_action_logs(action_type);

-- -----------------------------------------------------------------------------
-- 12. Réglages du site (setup_site_settings.sql) — ligne unique id = 1
-- -----------------------------------------------------------------------------
CREATE TABLE public.site_settings (
  id            integer PRIMARY KEY DEFAULT 1,
  is_troll_mode boolean NOT NULL DEFAULT false,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT single_row CHECK (id = 1)
);

-- =============================================================================
-- 13. Row Level Security
-- =============================================================================
-- Policies reprises des migrations (dernière définition retenue). Corrections
-- signalées par « [corrigé] ».
-- Les suppressions en cascade (post → likes/commentaires, utilisateur → son
-- contenu) passent par les FK ON DELETE CASCADE, qui ne sont pas soumises au RLS.

ALTER TABLE public.profiles                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.likes                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comments                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follows                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blocks                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.groups                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_members            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_messages           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_posts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_post_likes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.global_messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcements            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_broadcasts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forum_posts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forum_comments           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forum_votes              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coin_transactions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_payments    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_commands           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_reports             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moderation_flags         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forbidden_words          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.featured_content         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_curation_rules   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trending_content         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moderation_action_logs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_settings            ENABLE ROW LEVEL SECURITY;

-- ── profiles ─────────────────────────────────────────────────────────────────
CREATE POLICY "profiles_select_all"   ON public.profiles FOR SELECT USING (true);
CREATE POLICY "profiles_insert_own"   ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_update_own"   ON public.profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "profiles_update_admin" ON public.profiles FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));
CREATE POLICY "profiles_delete_admin" ON public.profiles FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));

-- ── posts / likes / comments / follows ───────────────────────────────────────
CREATE POLICY "posts_select"       ON public.posts FOR SELECT USING (true);
CREATE POLICY "posts_insert"       ON public.posts FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "posts_delete_own"   ON public.posts FOR DELETE USING (auth.uid() = user_id);
CREATE POLICY "posts_delete_admin" ON public.posts FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));

CREATE POLICY "likes_select" ON public.likes FOR SELECT USING (true);
CREATE POLICY "likes_insert" ON public.likes FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "likes_delete" ON public.likes FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "comments_select"      ON public.comments FOR SELECT USING (true);
CREATE POLICY "comments_insert"      ON public.comments FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "comments_delete_own"  ON public.comments FOR DELETE USING (auth.uid() = user_id);
CREATE POLICY "comments_delete_admin" ON public.comments FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));

CREATE POLICY "follows_select" ON public.follows FOR SELECT USING (true);
CREATE POLICY "follows_insert" ON public.follows FOR INSERT WITH CHECK (auth.uid() = follower_id);
CREATE POLICY "follows_delete" ON public.follows FOR DELETE USING (auth.uid() = follower_id);

-- ── messages privés (V6 + V11 « god mode ») ──────────────────────────────────
CREATE POLICY "messages_select" ON public.messages FOR SELECT
  USING (auth.uid() = sender_id OR auth.uid() = receiver_id);
CREATE POLICY "messages_insert" ON public.messages FOR INSERT WITH CHECK (auth.uid() = sender_id);
CREATE POLICY "messages_update" ON public.messages FOR UPDATE
  USING (auth.uid() = sender_id OR auth.uid() = receiver_id);
CREATE POLICY "messages_delete" ON public.messages FOR DELETE USING (auth.uid() = sender_id);
CREATE POLICY "Admins can view all messages" ON public.messages FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));
CREATE POLICY "Admins can delete all messages" ON public.messages FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));

-- ── blocks (V12) ─────────────────────────────────────────────────────────────
CREATE POLICY "Users can see their own blocks" ON public.blocks FOR SELECT
  USING (auth.uid() = blocker_id OR auth.uid() = blocked_id);
CREATE POLICY "Users can block others" ON public.blocks FOR INSERT WITH CHECK (auth.uid() = blocker_id);
CREATE POLICY "Users can unblock"      ON public.blocks FOR DELETE USING (auth.uid() = blocker_id);

-- ── groupes ──────────────────────────────────────────────────────────────────
CREATE POLICY "groups_select" ON public.groups FOR SELECT USING (
  is_private = false OR auth.uid() = created_by
  OR EXISTS (SELECT 1 FROM public.group_members gm WHERE gm.group_id = groups.id AND gm.user_id = auth.uid())
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true)
);
CREATE POLICY "groups_insert" ON public.groups FOR INSERT WITH CHECK (auth.uid() = created_by);
CREATE POLICY "groups_update" ON public.groups FOR UPDATE
  USING (auth.uid() = created_by OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));
CREATE POLICY "groups_delete" ON public.groups FOR DELETE
  USING (auth.uid() = created_by OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));

CREATE POLICY "group_members_select" ON public.group_members FOR SELECT USING (true);
CREATE POLICY "group_members_insert" ON public.group_members FOR INSERT WITH CHECK (
  (auth.uid() = user_id AND EXISTS (SELECT 1 FROM public.groups g WHERE g.id = group_members.group_id AND g.is_private = false))
  OR EXISTS (SELECT 1 FROM public.groups g WHERE g.id = group_members.group_id AND g.created_by = auth.uid())
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true)
);
CREATE POLICY "group_members_delete" ON public.group_members FOR DELETE USING (
  auth.uid() = user_id
  OR EXISTS (SELECT 1 FROM public.groups g WHERE g.id = group_members.group_id AND g.created_by = auth.uid())
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true)
);

-- [corrigé] « gm.group_id = group_id » se comparait à lui-même (tout membre
-- d'un groupe quelconque voyait tous les messages) → qualifié.
CREATE POLICY "group_messages_select" ON public.group_messages FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.group_members gm
           WHERE gm.group_id = group_messages.group_id AND gm.user_id = auth.uid())
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true)
);
CREATE POLICY "group_messages_insert" ON public.group_messages FOR INSERT WITH CHECK (
  auth.uid() = sender_id
  AND EXISTS (SELECT 1 FROM public.group_members gm
               WHERE gm.group_id = group_messages.group_id AND gm.user_id = auth.uid())
);
CREATE POLICY "group_messages_update" ON public.group_messages FOR UPDATE
  USING (auth.uid() = sender_id OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));

-- group_posts / group_post_likes : non utilisées → aucune policy (accès refusé).

-- ── chat global (V8 + V11) ───────────────────────────────────────────────────
CREATE POLICY "global_messages_select" ON public.global_messages FOR SELECT
  USING (auth.uid() IS NOT NULL AND deleted = false);
CREATE POLICY "global_messages_insert" ON public.global_messages FOR INSERT
  WITH CHECK (auth.uid() = sender_id);
CREATE POLICY "global_messages_update" ON public.global_messages FOR UPDATE
  USING (auth.uid() = sender_id OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));
CREATE POLICY "Admins can delete global messages" ON public.global_messages FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));

-- ── annonces / broadcasts ────────────────────────────────────────────────────
CREATE POLICY "announcements_select" ON public.announcements FOR SELECT USING (true);
CREATE POLICY "announcements_write"  ON public.announcements FOR ALL
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));
CREATE POLICY "admin_broadcasts_select" ON public.admin_broadcasts FOR SELECT USING (true);
CREATE POLICY "admin_broadcasts_write"  ON public.admin_broadcasts FOR ALL
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));

-- ── forum ────────────────────────────────────────────────────────────────────
CREATE POLICY "forum_posts_select" ON public.forum_posts FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "forum_posts_insert" ON public.forum_posts FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "forum_posts_update" ON public.forum_posts FOR UPDATE
  USING (auth.uid() = user_id OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));
CREATE POLICY "forum_posts_delete" ON public.forum_posts FOR DELETE
  USING (auth.uid() = user_id OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));

CREATE POLICY "forum_comments_select" ON public.forum_comments FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "forum_comments_insert" ON public.forum_comments FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "forum_comments_update" ON public.forum_comments FOR UPDATE
  USING (auth.uid() = user_id OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));
CREATE POLICY "forum_comments_delete" ON public.forum_comments FOR DELETE
  USING (auth.uid() = user_id OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));

CREATE POLICY "forum_votes_select" ON public.forum_votes FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "forum_votes_insert" ON public.forum_votes FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "forum_votes_delete" ON public.forum_votes FOR DELETE USING (auth.uid() = user_id);

-- ── coins ────────────────────────────────────────────────────────────────────
CREATE POLICY "coin_tx_select_own"   ON public.coin_transactions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "coin_tx_select_admin" ON public.coin_transactions FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true));
CREATE POLICY "coin_tx_insert" ON public.coin_transactions FOR INSERT WITH CHECK (
  auth.uid() = user_id
  OR EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
);

CREATE POLICY "sub_pay_select_own"   ON public.subscription_payments FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "sub_pay_select_admin" ON public.subscription_payments FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true));
CREATE POLICY "sub_pay_insert" ON public.subscription_payments FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ── notifications ────────────────────────────────────────────────────────────
CREATE POLICY "Users can view own notifications"   ON public.notifications FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can update own notifications" ON public.notifications FOR UPDATE USING (auth.uid() = user_id);
-- Les inserts passent par les triggers SECURITY DEFINER ; policy d'origine conservée.
CREATE POLICY "Service role can insert notifications" ON public.notifications FOR INSERT WITH CHECK (true);

CREATE POLICY "Users can view own notification prefs"   ON public.notification_preferences FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own notification prefs" ON public.notification_preferences FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own notification prefs" ON public.notification_preferences FOR UPDATE USING (auth.uid() = user_id);

-- ── commandes admin ──────────────────────────────────────────────────────────
CREATE POLICY "Users can view commands targeted to them" ON public.admin_commands FOR SELECT
  USING (auth.uid() = target_user_id);
CREATE POLICY "Admins can issue commands" ON public.admin_commands FOR INSERT
  WITH CHECK (public.is_admin(auth.uid()) AND auth.uid() = admin_id);

-- ── modération (V14) ─────────────────────────────────────────────────────────
CREATE POLICY "admin_access_user_reports" ON public.user_reports FOR ALL
  USING (auth.uid() IS NOT NULL AND (SELECT is_admin FROM public.profiles WHERE id = auth.uid()) = true);
CREATE POLICY "admin_access_moderation_flags" ON public.moderation_flags FOR ALL
  USING (auth.uid() IS NOT NULL AND (SELECT is_admin FROM public.profiles WHERE id = auth.uid()) = true);
CREATE POLICY "admin_access_forbidden_words" ON public.forbidden_words FOR ALL
  USING (auth.uid() IS NOT NULL AND (SELECT is_admin FROM public.profiles WHERE id = auth.uid()) = true);
-- [corrigé] moderation.js lit les mots actifs pour tout utilisateur connecté ;
-- sans cette policy la liste était vide pour les non-admins.
CREATE POLICY "forbidden_words_select_enabled" ON public.forbidden_words FOR SELECT
  USING (auth.uid() IS NOT NULL AND enabled = true);
CREATE POLICY "admin_access_featured_content" ON public.featured_content FOR ALL
  USING (auth.uid() IS NOT NULL AND (SELECT is_admin FROM public.profiles WHERE id = auth.uid()) = true);
CREATE POLICY "admin_access_content_curation_rules" ON public.content_curation_rules FOR ALL
  USING (auth.uid() IS NOT NULL AND (SELECT is_admin FROM public.profiles WHERE id = auth.uid()) = true);
CREATE POLICY "admin_access_trending_content" ON public.trending_content FOR SELECT
  USING (auth.uid() IS NOT NULL AND (SELECT is_admin FROM public.profiles WHERE id = auth.uid()) = true);
CREATE POLICY "admin_access_moderation_logs" ON public.moderation_action_logs FOR SELECT
  USING (auth.uid() IS NOT NULL AND (SELECT is_admin FROM public.profiles WHERE id = auth.uid()) = true);
-- [corrigé] AdminView journalise ses actions : il manquait la policy d'insertion.
CREATE POLICY "admin_insert_moderation_logs" ON public.moderation_action_logs FOR INSERT
  WITH CHECK (public.is_admin(auth.uid()) AND auth.uid() = admin_id);

-- ── réglages du site ─────────────────────────────────────────────────────────
CREATE POLICY "Allow public read access to site_settings" ON public.site_settings FOR SELECT USING (true);
-- [corrigé] tout utilisateur connecté pouvait activer le mode troll → admins seulement.
CREATE POLICY "Admins can update settings" ON public.site_settings FOR UPDATE
  USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

-- =============================================================================
-- 14. Privilèges (équivalent des GRANT par défaut de Supabase)
-- =============================================================================
-- Le RLS ci-dessus reste le filtre effectif.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.is_admin(uuid),
  public.increment_post_views(bigint),
  public.buy_subscription(text),
  public.admin_grant_coins(uuid, integer, text),
  public.expire_lapsed_subscriptions()
TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin(uuid) TO anon;
