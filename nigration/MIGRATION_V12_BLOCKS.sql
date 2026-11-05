-- ============================================================
-- ONBSocial — Blocks
-- Run this in your Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS public.blocks (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  blocker_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  UNIQUE(blocker_id, blocked_id)
);

ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;

-- Allow users to see who they have blocked, and who blocked them
CREATE POLICY "Users can see their own blocks"
ON public.blocks FOR SELECT
USING (auth.uid() = blocker_id OR auth.uid() = blocked_id);

CREATE POLICY "Users can block others"
ON public.blocks FOR INSERT
WITH CHECK (auth.uid() = blocker_id);

CREATE POLICY "Users can unblock"
ON public.blocks FOR DELETE
USING (auth.uid() = blocker_id);

-- ============================================================
-- Prevent sending messages if blocked nigga
-- ============================================================
-- We use a trigger so it works regardless of existing RLS policies.

CREATE OR REPLACE FUNCTION check_message_block()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.blocks 
    WHERE (blocker_id = NEW.sender_id AND blocked_id = NEW.receiver_id)
       OR (blocker_id = NEW.receiver_id AND blocked_id = NEW.sender_id)
  ) THEN
    RAISE EXCEPTION 'Blocked from messaging this user';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS restrict_blocked_messages ON public.messages;
CREATE TRIGGER restrict_blocked_messages
BEFORE INSERT ON public.messages
FOR EACH ROW
EXECUTE FUNCTION check_message_block();
