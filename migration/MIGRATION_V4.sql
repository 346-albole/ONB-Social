-- ============================================================
-- ONBSocial v4 - Migration complète
-- Coller et exécuter dans Supabase SQL Editor
-- ============================================================

-- ─── 1. Profils ───────────────────────────────────────────────
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_admin boolean DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS banner_url text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS custom_badge_url text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS chat_bg_url text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS username_color text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS banner_color text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_premium boolean NOT NULL DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_official boolean NOT NULL DEFAULT false;

-- ─── 2. Announcements (bannières texte admhghin) ─────────────────
CREATE TABLE IF NOT EXISTS public.announcements (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  admin_id uuid REFERENCES auth.users(id),
  content text NOT NULL,
  type text DEFAULT 'info',
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT announcements_pkey PRIMARY KEY (id)
);

-- ─── 3. Admin broadhgfcasts (injection fefer HTML/JS/CharlieKirk) ──────────────────
CREATE TABLE IF NOT EXISTS public.admin_broadcasts (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  admin_id uuid REFERENCES auth.users(id),
  title text,
  html_content text,
  js_content text,
  broadcast_type text DEFAULT 'banner',
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT admin_broadcasts_pkey PRIMARY KEY (id)
);

-- ─── 4. Groups (UUID-based) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.groups (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  banner_url text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  is_private boolean DEFAULT false,
  CONSTRAINT groups_pkey PRIMARY KEY (id)
);

-- ─── 5. Group members ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.group_members (
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text DEFAULT 'member',
  joined_at timestamptz DEFAULT now(),
  CONSTRAINT group_members_pkey PRIMARY KEY (group_id, user_id)
);

-- ─── 6. Group messages ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.group_messages (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES auth.users(id),
  content text,
  image_url text,
  edited boolean DEFAULT false,
  deleted boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT group_messages_pkey PRIMARY KEY (id)
);

-- ─── 7. Group posts & likes ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.group_posts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  group_id uuid REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  media_url text NOT NULL,
  caption text,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT group_posts_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.group_post_likes (
  post_id uuid NOT NULL REFERENCES public.group_posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT group_post_likes_pkey PRIMARY KEY (post_id, user_id)
);

-- ─── 8. Posts (feed principal) ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.posts (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  caption text,
  media_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT posts_pkey PRIMARY KEY (id)
);

-- ─── 9. Likes & comments ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.likes (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  post_id bigint NOT NULL REFERENCES public.posts(id),
  CONSTRAINT likes_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.comments (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  post_id bigint NOT NULL REFERENCES public.posts(id),
  content text NOT NULL,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT comments_pkey PRIMARY KEY (id)
);

-- ─── 10. Follows ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.follows (
  follower_id uuid NOT NULL REFERENCES auth.users(id),
  following_id uuid NOT NULL REFERENCES auth.users(id),
  CONSTRAINT follows_pkey PRIMARY KEY (follower_id, following_id)
);

-- ─── 11. DM Messages ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.messages (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  sender_id uuid NOT NULL REFERENCES auth.users(id),
  receiver_id uuid NOT NULL REFERENCES auth.users(id),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  image_url text,
  read boolean NOT NULL DEFAULT false,
  edited boolean DEFAULT false,
  deleted boolean DEFAULT false,
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT messages_pkey PRIMARY KEY (id)
);

-- ─── 12. NOUVEAU : Chat Global ────────────────────────────────
-- Table pour le chat commun à tous les utilisateurs
CREATE TABLE IF NOT EXISTS public.global_messages (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  sender_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted boolean DEFAULT false,
  CONSTRAINT global_messages_pkey PRIMARY KEY (id)
);

-- ─── 13. Index de performance ─────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON public.posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_group_messages_group_id ON public.group_messages(group_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_group_members_user_id ON public.group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_dm ON public.messages(sender_id, receiver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_global_messages_created_at ON public.global_messages(created_at ASC);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON public.follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON public.follows(following_id);

-- ─── 14. RLS (Row Level Security) ────────────────────────────
-- Activer RLS sur toutes les tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.global_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_broadcasts ENABLE ROW LEVEL SECURITY;

-- Profiles: tout le monde peut lire, chacun modifie le sien
DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
CREATE POLICY "profiles_select" ON public.profiles FOR SELECT USING (true);
DROP POLICY IF EXISTS "profiles_update" ON public.profiles;
CREATE POLICY "profiles_update" ON public.profiles FOR UPDATE USING (auth.uid() = id);
DROP POLICY IF EXISTS "profiles_insert" ON public.profiles;
CREATE POLICY "profiles_insert" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- Posts
DROP POLICY IF EXISTS "posts_select" ON public.posts;
CREATE POLICY "posts_select" ON public.posts FOR SELECT USING (true);
DROP POLICY IF EXISTS "posts_insert" ON public.posts;
CREATE POLICY "posts_insert" ON public.posts FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "posts_delete" ON public.posts;
CREATE POLICY "posts_delete" ON public.posts FOR DELETE USING (auth.uid() = user_id);

-- Likes
DROP POLICY IF EXISTS "likes_select" ON public.likes;
CREATE POLICY "likes_select" ON public.likes FOR SELECT USING (true);
DROP POLICY IF EXISTS "likes_insert" ON public.likes;
CREATE POLICY "likes_insert" ON public.likes FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "likes_delete" ON public.likes;
CREATE POLICY "likes_delete" ON public.likes FOR DELETE USING (auth.uid() = user_id);

-- Comments
DROP POLICY IF EXISTS "comments_select" ON public.comments;
CREATE POLICY "comments_select" ON public.comments FOR SELECT USING (true);
DROP POLICY IF EXISTS "comments_insert" ON public.comments;
CREATE POLICY "comments_insert" ON public.comments FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "comments_delete" ON public.comments;
CREATE POLICY "comments_delete" ON public.comments FOR DELETE USING (auth.uid() = user_id);

-- Follows
DROP POLICY IF EXISTS "follows_select" ON public.follows;
CREATE POLICY "follows_select" ON public.follows FOR SELECT USING (true);
DROP POLICY IF EXISTS "follows_insert" ON public.follows;
CREATE POLICY "follows_insert" ON public.follows FOR INSERT WITH CHECK (auth.uid() = follower_id);
DROP POLICY IF EXISTS "follows_delete" ON public.follows;
CREATE POLICY "follows_delete" ON public.follows FOR DELETE USING (auth.uid() = follower_id);

-- DM Messages
DROP POLICY IF EXISTS "messages_select" ON public.messages;
CREATE POLICY "messages_select" ON public.messages FOR SELECT
  USING (auth.uid() = sender_id OR auth.uid() = receiver_id);
DROP POLICY IF EXISTS "messages_insert" ON public.messages;
CREATE POLICY "messages_insert" ON public.messages FOR INSERT WITH CHECK (auth.uid() = sender_id);
DROP POLICY IF EXISTS "messages_update" ON public.messages;
CREATE POLICY "messages_update" ON public.messages FOR UPDATE
  USING (auth.uid() = sender_id OR auth.uid() = receiver_id);
DROP POLICY IF EXISTS "messages_delete" ON public.messages;
CREATE POLICY "messages_delete" ON public.messages FOR DELETE USING (auth.uid() = sender_id);

-- Groups: tout le monde voit les groupes publics, les membres voient les privés
DROP POLICY IF EXISTS "groups_select" ON public.groups;
CREATE POLICY "groups_select" ON public.groups FOR SELECT USING (
  is_private = false OR
  auth.uid() = created_by OR
  EXISTS (SELECT 1 FROM public.group_members gm WHERE gm.group_id = id AND gm.user_id = auth.uid())
);
DROP POLICY IF EXISTS "groups_insert" ON public.groups;
CREATE POLICY "groups_insert" ON public.groups FOR INSERT WITH CHECK (auth.uid() = created_by);
DROP POLICY IF EXISTS "groups_update" ON public.groups;
CREATE POLICY "groups_update" ON public.groups FOR UPDATE USING (auth.uid() = created_by);
DROP POLICY IF EXISTS "groups_delete" ON public.groups;
CREATE POLICY "groups_delete" ON public.groups FOR DELETE USING (auth.uid() = created_by);

-- Group members
DROP POLICY IF EXISTS "group_members_select" ON public.group_members;
CREATE POLICY "group_members_select" ON public.group_members FOR SELECT USING (true);

-- Insert: only if group is public, OR if owner is inviting, OR if adding yourself to public group
DROP POLICY IF EXISTS "group_members_insert" ON public.group_members;
CREATE POLICY "group_members_insert" ON public.group_members FOR INSERT WITH CHECK (
  auth.uid() = user_id AND (
    EXISTS (
      SELECT 1 FROM public.groups g
      WHERE g.id = group_id AND g.is_private = false
    )
  )
  OR
  -- Owner can add anyone (for invite)
  EXISTS (
    SELECT 1 FROM public.groups g
    WHERE g.id = group_id AND g.created_by = auth.uid()
  )
);

-- Delete: member can leave (own row), or group owner can kick anyone
DROP POLICY IF EXISTS "group_members_delete" ON public.group_members;
CREATE POLICY "group_members_delete" ON public.group_members FOR DELETE USING (
  auth.uid() = user_id
  OR EXISTS (
    SELECT 1 FROM public.groups g
    WHERE g.id = group_id AND g.created_by = auth.uid()
  )
);

-- Group messages: only members can read/write
DROP POLICY IF EXISTS "group_messages_select" ON public.group_messages;
CREATE POLICY "group_messages_select" ON public.group_messages FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.group_members gm WHERE gm.group_id = group_id AND gm.user_id = auth.uid())
);
DROP POLICY IF EXISTS "group_messages_insert" ON public.group_messages;
CREATE POLICY "group_messages_insert" ON public.group_messages FOR INSERT WITH CHECK (
  auth.uid() = sender_id AND
  EXISTS (SELECT 1 FROM public.group_members gm WHERE gm.group_id = group_id AND gm.user_id = auth.uid())
);

-- Global messages: tous les connectés peuvent lire et écrire
DROP POLICY IF EXISTS "global_messages_select" ON public.global_messages;
CREATE POLICY "global_messages_select" ON public.global_messages FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS "global_messages_insert" ON public.global_messages;
CREATE POLICY "global_messages_insert" ON public.global_messages FOR INSERT WITH CHECK (auth.uid() = sender_id);

-- Announcements & broadcasts: lecture publique, écriture admin
DROP POLICY IF EXISTS "announcements_select" ON public.announcements;
CREATE POLICY "announcements_select" ON public.announcements FOR SELECT USING (true);
DROP POLICY IF EXISTS "admin_broadcasts_select" ON public.admin_broadcasts;
CREATE POLICY "admin_broadcasts_select" ON public.admin_broadcasts FOR SELECT USING (true);

-- ─── 15. Realtime : activer les publications pour les tables clés ─
-- Exécuter dans Supabase > Database > Replication OU via SQL :
BEGIN;
  -- S'assurer que les tables sont bien en REPLICA IDENTITY FULL pour les DELETE
  ALTER TABLE public.group_members REPLICA IDENTITY FULL;
  ALTER TABLE public.group_messages REPLICA IDENTITY FULL;
  ALTER TABLE public.global_messages REPLICA IDENTITY FULL;
  ALTER TABLE public.messages REPLICA IDENTITY FULL;
  ALTER TABLE public.posts REPLICA IDENTITY FULL;
  ALTER TABLE public.likes REPLICA IDENTITY FULL;
  ALTER TABLE public.comments REPLICA IDENTITY FULL;
COMMIT;

-- Ajouter les tables à la publication realtime (si pas déjà fait)
-- Note: Supabase crée automatiquement "supabase_realtime" publication
DO $$
BEGIN
  -- global_messages
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'global_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.global_messages;
  END IF;
  -- group_messages
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'group_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.group_messages;
  END IF;
  -- group_members
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'group_members'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.group_members;
  END IF;
  -- posts
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'posts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.posts;
  END IF;
  -- likes
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'likes'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.likes;
  END IF;
  -- comments
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'comments'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.comments;
  END IF;
END $$;
