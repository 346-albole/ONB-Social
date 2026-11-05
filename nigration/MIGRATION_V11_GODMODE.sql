-- ==============================================================================
-- MIGRATION V11: ADMIN GOD MODE (DMs & Comments Bypass)
-- ==============================================================================
-- Allows admins to read and delete all private messages and comments.

-- 1. MESSAGES (Private DMs)
DROP POLICY IF EXISTS "Admins can view all messages" ON public.messages;
CREATE POLICY "Admins can view all messages" ON public.messages
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));

DROP POLICY IF EXISTS "Admins can delete all messages" ON public.messages;
CREATE POLICY "Admins can delete all messages" ON public.messages
  FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));

-- 2. COMMENTS
DROP POLICY IF EXISTS "Admins can view all comments" ON public.comments;
CREATE POLICY "Admins can view all comments" ON public.comments
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));

DROP POLICY IF EXISTS "Admins can delete all comments" ON public.comments;
CREATE POLICY "Admins can delete all comments" ON public.comments
  FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));

-- Note: global_messages usually already bypasses RLS for admins (or anyone can read),
-- but let's add an explicit delete policy just in case it doesn't exist.
DROP POLICY IF EXISTS "Admins can delete global messages" ON public.global_messages;
CREATE POLICY "Admins can delete global messages" ON public.global_messages
  FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));
