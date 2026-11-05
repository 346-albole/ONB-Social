-- ============================================================
-- ONBSocial v7 — Migration corrective
-- Corrige tous les bugs DB qui empêchaient le Global Chat
-- et le Forum de fonctionner.
-- Sûr à exécuter même si V6 a déjà été partiellement appliqué.
-- ============================================================

-- ─── 1. Colonnes manquantes sur profiles ──────────────────────
-- La table profiles du schéma de base n'a pas ces colonnes.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS username          text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS updated_at        timestamptz DEFAULT now();
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS username_color    text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_premium        boolean DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_official       boolean DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS banner_url        text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS custom_badge_url  text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS chat_bg_url       text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS banner_color      text;

-- Copier full_name → username pour les profils existants
-- qui n'ont pas encore de username
UPDATE public.profiles
SET username = COALESCE(full_name, split_part(email, '@', 1))
WHERE username IS NULL;

-- ─── 2. Global Chat — table global_messages ───────────────────
-- Le code utilise global_messages (et non l'ancienne table global_chat)
-- IMPORTANT : sender_id doit référencer public.profiles(id) et NON
-- auth.users(id) pour que PostgREST puisse faire le join profiles(...)
CREATE TABLE IF NOT EXISTS public.global_messages (
  id         bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  sender_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content    text NOT NULL,
  edited     boolean NOT NULL DEFAULT false,
  deleted    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT global_messages_pkey PRIMARY KEY (id)
);

-- Ajouter les colonnes si la table existait déjà sans elles (V6 partiel)
ALTER TABLE public.global_messages ADD COLUMN IF NOT EXISTS edited  boolean NOT NULL DEFAULT false;
ALTER TABLE public.global_messages ADD COLUMN IF NOT EXISTS deleted boolean NOT NULL DEFAULT false;
DO $$
BEGIN
  -- Supprimer l'ancienne FK vers auth.users si elle existe
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints tc
    JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name
    JOIN information_schema.table_constraints tc2 ON rc.unique_constraint_name = tc2.constraint_name
    WHERE tc.table_schema = 'public' AND tc.table_name = 'global_messages'
      AND tc2.table_name = 'users' AND tc2.table_schema = 'auth'
  ) THEN
    ALTER TABLE public.global_messages DROP CONSTRAINT IF EXISTS global_messages_sender_id_fkey;
    ALTER TABLE public.global_messages
      ADD CONSTRAINT global_messages_sender_id_fkey
      FOREIGN KEY (sender_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ─── 3. Forum — forum_posts ───────────────────────────────────
-- user_id doit référencer public.profiles(id) pour les joins PostgREST
CREATE TABLE IF NOT EXISTS public.forum_posts (
  id            bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title         text NOT NULL,
  content       text,
  image_url     text,
  category      text NOT NULL DEFAULT 'general',
  pinned        boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT forum_posts_pkey PRIMARY KEY (id)
);

DO $$
BEGIN
  -- Recréer FK vers profiles si elle pointe vers auth.users
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints tc
    JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name
    JOIN information_schema.table_constraints tc2 ON rc.unique_constraint_name = tc2.constraint_name
    WHERE tc.table_schema = 'public' AND tc.table_name = 'forum_posts'
      AND tc2.table_name = 'users' AND tc2.table_schema = 'auth'
  ) THEN
    ALTER TABLE public.forum_posts DROP CONSTRAINT IF EXISTS forum_posts_user_id_fkey;
    ALTER TABLE public.forum_posts
      ADD CONSTRAINT forum_posts_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;

  -- Renommer body → content si V6 avait créé avec body
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'forum_posts' AND column_name = 'body'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'forum_posts' AND column_name = 'content'
  ) THEN
    ALTER TABLE public.forum_posts RENAME COLUMN body TO content;
  END IF;
END $$;

ALTER TABLE public.forum_posts ADD COLUMN IF NOT EXISTS content   text;
ALTER TABLE public.forum_posts ADD COLUMN IF NOT EXISTS image_url text;
ALTER TABLE public.forum_posts ADD COLUMN IF NOT EXISTS pinned    boolean NOT NULL DEFAULT false;

-- ─── 4. Forum — forum_comments ────────────────────────────────
-- user_id doit référencer public.profiles(id) pour les joins PostgREST
CREATE TABLE IF NOT EXISTS public.forum_comments (
  id         bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  post_id    bigint NOT NULL REFERENCES public.forum_posts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  parent_id  bigint REFERENCES public.forum_comments(id) ON DELETE CASCADE,
  content    text NOT NULL,
  edited     boolean NOT NULL DEFAULT false,
  deleted    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT forum_comments_pkey PRIMARY KEY (id)
);

DO $$
BEGIN
  -- Recréer FK vers profiles si elle pointe vers auth.users
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints tc
    JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name
    JOIN information_schema.table_constraints tc2 ON rc.unique_constraint_name = tc2.constraint_name
    WHERE tc.table_schema = 'public' AND tc.table_name = 'forum_comments'
      AND tc2.table_name = 'users' AND tc2.table_schema = 'auth'
      AND tc.constraint_name LIKE '%user_id%'
  ) THEN
    ALTER TABLE public.forum_comments DROP CONSTRAINT IF EXISTS forum_comments_user_id_fkey;
    ALTER TABLE public.forum_comments
      ADD CONSTRAINT forum_comments_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;

  -- Renommer body → content si V6 avait créé avec body
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'forum_comments' AND column_name = 'body'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'forum_comments' AND column_name = 'content'
  ) THEN
    ALTER TABLE public.forum_comments RENAME COLUMN body TO content;
  END IF;
END $$;

ALTER TABLE public.forum_comments ADD COLUMN IF NOT EXISTS content text;
ALTER TABLE public.forum_comments ADD COLUMN IF NOT EXISTS edited  boolean NOT NULL DEFAULT false;
ALTER TABLE public.forum_comments ADD COLUMN IF NOT EXISTS deleted boolean NOT NULL DEFAULT false;

-- ─── 5. Forum — forum_votes (REFONTE) ─────────────────────────
-- user_id → public.profiles(id) pour cohérence et joins PostgREST
-- PRIMARY KEY composite avec comment_id nullable = cassé → index partiels
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'public' AND r.relname = 'forum_votes'
      AND c.contype = 'p'
      AND array_length(c.conkey, 1) >= 3
  ) THEN
    DROP TABLE public.forum_votes CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.forum_votes (
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  post_id    bigint REFERENCES public.forum_posts(id) ON DELETE CASCADE,
  comment_id bigint REFERENCES public.forum_comments(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT forum_votes_xor CHECK (
    (post_id IS NOT NULL AND comment_id IS NULL) OR
    (post_id IS NULL AND comment_id IS NOT NULL)
  )
);

-- Index uniques partiels : 1 vote par user par post, 1 vote par user par comment
CREATE UNIQUE INDEX IF NOT EXISTS forum_votes_post_uniq
  ON public.forum_votes(user_id, post_id)
  WHERE post_id IS NOT NULL AND comment_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS forum_votes_comment_uniq
  ON public.forum_votes(user_id, comment_id)
  WHERE comment_id IS NOT NULL AND post_id IS NULL;

-- ─── 6. Indexes de performance ────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_global_msgs_created
  ON public.global_messages(created_at ASC);
CREATE INDEX IF NOT EXISTS idx_global_msgs_sender
  ON public.global_messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_forum_posts_cat_date
  ON public.forum_posts(category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_forum_comments_post
  ON public.forum_comments(post_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_forum_votes_post
  ON public.forum_votes(post_id) WHERE post_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_forum_votes_comment
  ON public.forum_votes(comment_id) WHERE comment_id IS NOT NULL;

-- ─── 7. Replica Identity (requis pour Realtime) ───────────────
ALTER TABLE public.global_messages  REPLICA IDENTITY FULL;
ALTER TABLE public.forum_posts      REPLICA IDENTITY FULL;
ALTER TABLE public.forum_comments   REPLICA IDENTITY FULL;
ALTER TABLE public.forum_votes      REPLICA IDENTITY FULL;

-- ─── 8. RLS ───────────────────────────────────────────────────

-- global_messages
ALTER TABLE public.global_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "global_messages_select" ON public.global_messages;
CREATE POLICY "global_messages_select" ON public.global_messages
  FOR SELECT USING (auth.uid() IS NOT NULL AND deleted = false);

DROP POLICY IF EXISTS "global_messages_insert" ON public.global_messages;
CREATE POLICY "global_messages_insert" ON public.global_messages
  FOR INSERT WITH CHECK (auth.uid() = sender_id);

DROP POLICY IF EXISTS "global_messages_update_own" ON public.global_messages;
CREATE POLICY "global_messages_update_own" ON public.global_messages
  FOR UPDATE USING (
    auth.uid() = sender_id
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true)
  );

-- forum_posts
ALTER TABLE public.forum_posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "forum_posts_select" ON public.forum_posts;
CREATE POLICY "forum_posts_select" ON public.forum_posts
  FOR SELECT USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "forum_posts_insert" ON public.forum_posts;
CREATE POLICY "forum_posts_insert" ON public.forum_posts
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "forum_posts_update" ON public.forum_posts;
CREATE POLICY "forum_posts_update" ON public.forum_posts
  FOR UPDATE USING (
    auth.uid() = user_id
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true)
  );

DROP POLICY IF EXISTS "forum_posts_delete" ON public.forum_posts;
CREATE POLICY "forum_posts_delete" ON public.forum_posts
  FOR DELETE USING (
    auth.uid() = user_id
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true)
  );

-- forum_comments
ALTER TABLE public.forum_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "forum_comments_select" ON public.forum_comments;
CREATE POLICY "forum_comments_select" ON public.forum_comments
  FOR SELECT USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "forum_comments_insert" ON public.forum_comments;
CREATE POLICY "forum_comments_insert" ON public.forum_comments
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "forum_comments_update" ON public.forum_comments;
CREATE POLICY "forum_comments_update" ON public.forum_comments
  FOR UPDATE USING (
    auth.uid() = user_id
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true)
  );

DROP POLICY IF EXISTS "forum_comments_delete" ON public.forum_comments;
CREATE POLICY "forum_comments_delete" ON public.forum_comments
  FOR DELETE USING (
    auth.uid() = user_id
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true)
  );

-- forum_votes
ALTER TABLE public.forum_votes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "forum_votes_select" ON public.forum_votes;
CREATE POLICY "forum_votes_select" ON public.forum_votes
  FOR SELECT USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "forum_votes_insert" ON public.forum_votes;
CREATE POLICY "forum_votes_insert" ON public.forum_votes
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "forum_votes_delete" ON public.forum_votes;
CREATE POLICY "forum_votes_delete" ON public.forum_votes
  FOR DELETE USING (auth.uid() = user_id);

-- ─── 9. Publication Realtime ──────────────────────────────────
DO $$
DECLARE
  tables text[] := ARRAY[
    'global_messages',
    'forum_posts',
    'forum_comments',
    'forum_votes'
  ];
  t text;
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- ─── 10. Trigger auto-create profile ─────────────────────────
-- Re-crée le trigger pour inclure la colonne username
-- (qui n'existait pas dans le schéma de base)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, username, updated_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'username', split_part(NEW.email, '@', 1)),
    now()
  )
  ON CONFLICT (id) DO UPDATE SET
    email      = EXCLUDED.email,
    username   = COALESCE(profiles.username, EXCLUDED.username),
    updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
