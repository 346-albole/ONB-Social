-- ============================================================
-- ONBSocial — Admin Commands (Remote Reload)
-- Run this in your Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS public.admin_commands (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  target_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  admin_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  command text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.admin_commands ENABLE ROW LEVEL SECURITY;

-- Allow users to see commands targeted to them
CREATE POLICY "Users can view commands targeted to them"
ON public.admin_commands FOR SELECT
USING (auth.uid() = target_user_id);

-- Wait, creating a function to check if the sender is an admin
CREATE OR REPLACE FUNCTION public.is_admin(user_id uuid)
RETURNS boolean AS $$
DECLARE
  _is_admin boolean;
BEGIN
  SELECT profiles.is_admin INTO _is_admin FROM public.profiles WHERE id = user_id;
  RETURN COALESCE(_is_admin, false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Only admins can insert commands
CREATE POLICY "Admins can issue commands"
ON public.admin_commands FOR INSERT
WITH CHECK (public.is_admin(auth.uid()) AND auth.uid() = admin_id);

-- Enable realtime for this table so the client can listen to it
ALTER PUBLICATION supabase_realtime ADD TABLE public.admin_commands;
