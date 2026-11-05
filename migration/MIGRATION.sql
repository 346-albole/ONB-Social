-- ============================================================
-- ONBSocial - Migration complète
-- Coller et exécuter dans Supabase SQL Editor
-- ============================================================

-- 1. Ajouter is_admin à profiles (si pas déjà fait)
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_admin boolean DEFAULT false;

-- 2. Table announcements (bannières texte admin)
CREATE TABLE IF NOT EXISTS public.announcements (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  admin_id uuid REFERENCES auth.users(id),
  content text NOT NULL,
  type text DEFAULT 'info',  -- info | success | warning | danger
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT announcements_pkey PRIMARY KEY (id)
);

-- 3. Table admin_broadcasts (injection HTML/JS)
CREATE TABLE IF NOT EXISTS public.admin_broadcasts (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  admin_id uuid REFERENCES auth.users(id),
  title text,
  html_content text,
  js_content text,
  broadcast_type text DEFAULT 'banner', -- banner | modal | inline
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT admin_broadcasts_pkey PRIMARY KEY (id)
);

-- 4. Table group_chats (groupes de discussion)
CREATE TABLE IF NOT EXISTS public.group_chats (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  description text,
  avatar_url text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  CONSTRAINT group_chats_pkey PRIMARY KEY (id)
);

-- 5. Table group_members (membres des groupes)
CREATE TABLE IF NOT EXISTS public.group_members (
  group_id bigint NOT NULL REFERENCES public.group_chats(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text DEFAULT 'member', -- admin | member
  joined_at timestamptz DEFAULT now(),
  CONSTRAINT group_members_pkey PRIMARY KEY (group_id, user_id)
);

-- 6. Table group_messages (messages de groupe)
CREATE TABLE IF NOT EXISTS public.group_messages (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  group_id bigint NOT NULL REFERENCES public.group_chats(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES auth.users(id),
  content text,
  image_url text,
  edited boolean DEFAULT false,
  deleted boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT group_messages_pkey PRIMARY KEY (id)
);

-- 7. Ajouter colonnes edit/delete aux messages directs
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS edited boolean DEFAULT false;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS deleted boolean DEFAULT false;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- 8. RLS Policies
ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "Announcements visible to all authenticated" ON public.announcements
  FOR SELECT TO authenticated USING (true);
CREATE POLICY IF NOT EXISTS "Only admins can insert announcements" ON public.announcements
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
  );
CREATE POLICY IF NOT EXISTS "Only admins can update announcements" ON public.announcements
  FOR UPDATE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
  );
CREATE POLICY IF NOT EXISTS "Only admins can delete announcements" ON public.announcements
  FOR DELETE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
  );

ALTER TABLE public.admin_broadcasts ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "Broadcasts visible to all authenticated" ON public.admin_broadcasts
  FOR SELECT TO authenticated USING (true);
CREATE POLICY IF NOT EXISTS "Only admins can manage broadcasts" ON public.admin_broadcasts
  FOR ALL TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
  );

ALTER TABLE public.group_chats ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "Group members can view their groups" ON public.group_chats
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.group_members WHERE group_id = id AND user_id = auth.uid())
  );
CREATE POLICY IF NOT EXISTS "Authenticated users can create groups" ON public.group_chats
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = created_by);
CREATE POLICY IF NOT EXISTS "Group admin can update group" ON public.group_chats
  FOR UPDATE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.group_members WHERE group_id = id AND user_id = auth.uid() AND role = 'admin')
  );
CREATE POLICY IF NOT EXISTS "Group admin can delete group" ON public.group_chats
  FOR DELETE TO authenticated USING (created_by = auth.uid());

ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "Members can view group members" ON public.group_members
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.group_members gm WHERE gm.group_id = group_id AND gm.user_id = auth.uid())
  );
CREATE POLICY IF NOT EXISTS "Group admin can manage members" ON public.group_members
  FOR ALL TO authenticated USING (
    user_id = auth.uid() OR
    EXISTS (SELECT 1 FROM public.group_members WHERE group_id = group_members.group_id AND user_id = auth.uid() AND role = 'admin')
  );

ALTER TABLE public.group_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "Group members can view messages" ON public.group_messages
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.group_members WHERE group_id = group_messages.group_id AND user_id = auth.uid())
  );
CREATE POLICY IF NOT EXISTS "Group members can send messages" ON public.group_messages
  FOR INSERT TO authenticated WITH CHECK (
    sender_id = auth.uid() AND
    EXISTS (SELECT 1 FROM public.group_members WHERE group_id = group_messages.group_id AND user_id = auth.uid())
  );
CREATE POLICY IF NOT EXISTS "Sender can edit/delete own messages" ON public.group_messages
  FOR UPDATE TO authenticated USING (sender_id = auth.uid());
CREATE POLICY IF NOT EXISTS "Sender can delete own messages" ON public.group_messages
  FOR DELETE TO authenticated USING (sender_id = auth.uid());

-- 9. Réactiver realtime pour les nouvelles tables
ALTER PUBLICATION supabase_realtime ADD TABLE public.group_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.announcements;

-- 10. Rendre vous-même admin (remplacer par votre user ID)
-- UPDATE public.profiles SET is_admin = true WHERE id = 'VOTRE-USER-ID-ICI';
-- Pour trouver votre ID: SELECT id FROM auth.users WHERE email = 'votre@email.com';

-- Beta 6.7: New profile columns
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS custom_badge_url text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS banner_url text;
