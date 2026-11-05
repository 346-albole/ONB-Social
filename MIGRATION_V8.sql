-- ============================================================
-- ONBSocial MIGRATION_V8 — Basée sur le vrai schéma DB
-- Corrige : Global Chat, Forum (posts/comments/votes), Groups
-- ============================================================

-- ══════════════════════════════════════════════════════════════
-- 1. GLOBAL CHAT — Ajouter FK profiles pour que PostgREST
--    puisse faire .select('*, profiles(...)') 
--    (pattern identique à group_messages dans votre vraie DB)
-- ══════════════════════════════════════════════════════════════
ALTER TABLE public.global_messages
  ADD CONSTRAINT IF NOT EXISTS global_messages_sender_profile_fkey
  FOREIGN KEY (sender_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- ══════════════════════════════════════════════════════════════
-- 2. FORUM POSTS
--    a) Renommer body → content  (le frontend attend "content")
--    b) Ajouter image_url
--    c) Ajouter FK vers profiles (pour le join PostgREST)
-- ══════════════════════════════════════════════════════════════
DO $$
BEGIN
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

ALTER TABLE public.forum_posts ADD COLUMN IF NOT EXISTS image_url text;

ALTER TABLE public.forum_posts
  ADD CONSTRAINT IF NOT EXISTS forum_posts_user_profile_fkey
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- ══════════════════════════════════════════════════════════════
-- 3. FORUM COMMENTS
--    a) Renommer body → content
--    b) Ajouter FK vers profiles
-- ══════════════════════════════════════════════════════════════
DO $$
BEGIN
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

ALTER TABLE public.forum_comments
  ADD CONSTRAINT IF NOT EXISTS forum_comments_user_profile_fkey
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- ══════════════════════════════════════════════════════════════
-- 4. FORUM VOTES — Refonte complète
--    Problème : PK (user_id, post_id, comment_id) avec les 3
--    colonnes NOT NULL = impossible d'insérer un vote de post
--    sans fournir un comment_id.
--
--    Solution : supprimer l'ancienne table, recréer avec
--    deux index partiels uniques (un pour posts, un pour comments)
--    + FK vers profiles pour cohérence
-- ══════════════════════════════════════════════════════════════
DROP TABLE IF EXISTS public.forum_votes CASCADE;

CREATE TABLE public.forum_votes (
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  post_id    bigint REFERENCES public.forum_posts(id) ON DELETE CASCADE,
  comment_id bigint REFERENCES public.forum_comments(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  -- Exactement l'un des deux doit être non-null
  CONSTRAINT forum_votes_xor CHECK (
    (post_id IS NOT NULL AND comment_id IS NULL) OR
    (post_id IS NULL    AND comment_id IS NOT NULL)
  )
);

-- 1 vote par utilisateur par post
CREATE UNIQUE INDEX forum_votes_post_uniq
  ON public.forum_votes (user_id, post_id)
  WHERE post_id IS NOT NULL AND comment_id IS NULL;

-- 1 vote par utilisateur par commentaire
CREATE UNIQUE INDEX forum_votes_comment_uniq
  ON public.forum_votes (user_id, comment_id)
  WHERE comment_id IS NOT NULL AND post_id IS NULL;

-- ══════════════════════════════════════════════════════════════
-- 5. RLS
-- ══════════════════════════════════════════════════════════════

-- global_messages
ALTER TABLE public.global_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "global_messages_select" ON public.global_messages;
CREATE POLICY "global_messages_select" ON public.global_messages
  FOR SELECT USING (auth.uid() IS NOT NULL AND deleted = false);

DROP POLICY IF EXISTS "global_messages_insert" ON public.global_messages;
CREATE POLICY "global_messages_insert" ON public.global_messages
  FOR INSERT WITH CHECK (auth.uid() = sender_id);

DROP POLICY IF EXISTS "global_messages_update" ON public.global_messages;
CREATE POLICY "global_messages_update" ON public.global_messages
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

-- ══════════════════════════════════════════════════════════════
-- 6. Replica Identity (requis pour Realtime)
-- ══════════════════════════════════════════════════════════════
ALTER TABLE public.global_messages  REPLICA IDENTITY FULL;
ALTER TABLE public.forum_posts      REPLICA IDENTITY FULL;
ALTER TABLE public.forum_comments   REPLICA IDENTITY FULL;
ALTER TABLE public.forum_votes      REPLICA IDENTITY FULL;

-- ══════════════════════════════════════════════════════════════
-- 7. Publication Realtime
-- ══════════════════════════════════════════════════════════════
DO $$
DECLARE
  tables text[] := ARRAY['global_messages','forum_posts','forum_comments','forum_votes'];
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

-- ══════════════════════════════════════════════════════════════
-- 8. Index de performance
-- ══════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_global_msgs_created
  ON public.global_messages(created_at ASC);
CREATE INDEX IF NOT EXISTS idx_forum_posts_cat_date
  ON public.forum_posts(category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_forum_comments_post
  ON public.forum_comments(post_id, created_at ASC);
