-- ============================================================
-- ROLLBACK V7 — Annule toutes les modifications de MIGRATION_V7.sql
-- À exécuter sur la base qui a reçu V7 par erreur
-- ============================================================

-- ─── 1. forum_posts : remettre content → body ─────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'forum_posts' AND column_name = 'content'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'forum_posts' AND column_name = 'body'
  ) THEN
    ALTER TABLE public.forum_posts RENAME COLUMN content TO body;
  END IF;
END $$;

-- Supprimer image_url si V7 l'a ajoutée
ALTER TABLE public.forum_posts DROP COLUMN IF EXISTS image_url;

-- Restaurer FK forum_posts.user_id → auth.users
ALTER TABLE public.forum_posts DROP CONSTRAINT IF EXISTS forum_posts_user_id_fkey;
ALTER TABLE public.forum_posts
  ADD CONSTRAINT forum_posts_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- ─── 2. forum_comments : remettre content → body ──────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'forum_comments' AND column_name = 'content'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'forum_comments' AND column_name = 'body'
  ) THEN
    ALTER TABLE public.forum_comments RENAME COLUMN content TO body;
  END IF;
END $$;

-- Restaurer FK forum_comments.user_id → auth.users
ALTER TABLE public.forum_comments DROP CONSTRAINT IF EXISTS forum_comments_user_id_fkey;
ALTER TABLE public.forum_comments
  ADD CONSTRAINT forum_comments_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- ─── 3. Restaurer forum_votes ─────────────────────────────────
DROP TABLE IF EXISTS public.forum_votes CASCADE;

CREATE TABLE public.forum_votes (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  post_id    bigint NOT NULL REFERENCES public.forum_posts(id) ON DELETE CASCADE,
  comment_id bigint NOT NULL REFERENCES public.forum_comments(id) ON DELETE CASCADE,
  vote       smallint NOT NULL CHECK (vote IN (-1, 1)),
  CONSTRAINT forum_votes_pkey PRIMARY KEY (user_id, post_id, comment_id)
);

-- ─── 4. global_messages : restaurer FK → auth.users ──────────
ALTER TABLE public.global_messages DROP CONSTRAINT IF EXISTS global_messages_sender_id_fkey;
ALTER TABLE public.global_messages
  ADD CONSTRAINT global_messages_sender_id_fkey
  FOREIGN KEY (sender_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- ─── 5. Supprimer colonnes ajoutées sur profiles (si voulues) ─
-- NB : Ces colonnes étaient peut-être déjà présentes — on les laisse
-- car les supprimer pourrait casser d'autres choses.
-- Si vous voulez les supprimer manuellement :
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS username;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS updated_at;

-- ─── 6. Désactiver les publications realtime ajoutées ─────────
-- (Optionnel — laisser actif ne pose pas de problème)
-- ALTER PUBLICATION supabase_realtime DROP TABLE public.forum_posts;
-- ALTER PUBLICATION supabase_realtime DROP TABLE public.forum_comments;
-- ALTER PUBLICATION supabase_realtime DROP TABLE public.forum_votes;
