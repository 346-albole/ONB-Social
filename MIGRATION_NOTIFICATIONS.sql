-- ============================================================
-- MIGRATION: Notifications + Notification Preferences
-- Run this in your Supabase SQL editor
-- ============================================================

-- 1. Notifications table
CREATE TABLE IF NOT EXISTS public.notifications (
  id          bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  user_id     uuid NOT NULL,
  type        text,                        -- 'like' | 'comment' | 'follow' | 'mention'
  message     text,                        -- human-readable text
  is_read     boolean NOT NULL DEFAULT false,
  actor_id    uuid,                        -- who triggered the notification
  post_id     bigint,                      -- related post (optional)
  created_at  timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT notifications_pkey PRIMARY KEY (id),
  CONSTRAINT notifications_user_id_fkey  FOREIGN KEY (user_id)  REFERENCES public.profiles(id) ON DELETE CASCADE,
  CONSTRAINT notifications_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT notifications_post_id_fkey  FOREIGN KEY (post_id)  REFERENCES public.posts(id)    ON DELETE CASCADE
);

-- Index for fast per-user queries
CREATE INDEX IF NOT EXISTS notifications_user_id_idx ON public.notifications(user_id);
CREATE INDEX IF NOT EXISTS notifications_created_at_idx ON public.notifications(created_at DESC);

-- 2. Notification preferences table (one row per user)
CREATE TABLE IF NOT EXISTS public.notification_preferences (
  user_id   uuid NOT NULL,
  likes     boolean NOT NULL DEFAULT true,
  comments  boolean NOT NULL DEFAULT true,
  follows   boolean NOT NULL DEFAULT true,
  mentions  boolean NOT NULL DEFAULT true,
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT notification_preferences_pkey PRIMARY KEY (user_id),
  CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE
);

-- 3. RLS Policies

-- Enable RLS
ALTER TABLE public.notifications              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_preferences   ENABLE ROW LEVEL SECURITY;

-- notifications: users can only see their own
CREATE POLICY "Users can view own notifications"
  ON public.notifications FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own notifications"
  ON public.notifications FOR UPDATE
  USING (auth.uid() = user_id);

-- Allow backend/triggers to insert notifications for any user
CREATE POLICY "Service role can insert notifications"
  ON public.notifications FOR INSERT
  WITH CHECK (true);

-- notification_preferences: users manage their own row
CREATE POLICY "Users can view own notification prefs"
  ON public.notification_preferences FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own notification prefs"
  ON public.notification_preferences FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own notification prefs"
  ON public.notification_preferences FOR UPDATE
  USING (auth.uid() = user_id);

-- 4. Enable Realtime for live notification delivery
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;

-- ============================================================
-- OPTIONAL: Trigger to auto-create a notification on new like
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_like()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  post_owner uuid;
  liker_name text;
BEGIN
  -- Get post owner
  SELECT user_id INTO post_owner FROM public.posts WHERE id = NEW.post_id;

  -- Don't notify yourself
  IF post_owner = NEW.user_id THEN RETURN NEW; END IF;

  -- Get liker username
  SELECT username INTO liker_name FROM public.profiles WHERE id = NEW.user_id;

  -- Check preference
  IF EXISTS (
    SELECT 1 FROM public.notification_preferences
    WHERE user_id = post_owner AND likes = false
  ) THEN RETURN NEW; END IF;

  INSERT INTO public.notifications (user_id, type, message, actor_id, post_id)
  VALUES (post_owner, 'like', liker_name || ' a aimé votre publication', NEW.user_id, NEW.post_id);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_new_like ON public.likes;
CREATE TRIGGER on_new_like
  AFTER INSERT ON public.likes
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_like();

-- ============================================================
-- OPTIONAL: Trigger to auto-create a notification on new comment
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_comment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  post_owner uuid;
  commenter_name text;
BEGIN
  SELECT user_id INTO post_owner FROM public.posts WHERE id = NEW.post_id;

  IF post_owner = NEW.user_id THEN RETURN NEW; END IF;

  SELECT username INTO commenter_name FROM public.profiles WHERE id = NEW.user_id;

  IF EXISTS (
    SELECT 1 FROM public.notification_preferences
    WHERE user_id = post_owner AND comments = false
  ) THEN RETURN NEW; END IF;

  INSERT INTO public.notifications (user_id, type, message, actor_id, post_id)
  VALUES (post_owner, 'comment', commenter_name || ' a commenté votre publication', NEW.user_id, NEW.post_id);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_new_comment ON public.comments;
CREATE TRIGGER on_new_comment
  AFTER INSERT ON public.comments
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_comment();

-- ============================================================
-- OPTIONAL: Trigger to auto-create a notification on new follow
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_follow()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  follower_name text;
BEGIN
  SELECT username INTO follower_name FROM public.profiles WHERE id = NEW.follower_id;

  IF EXISTS (
    SELECT 1 FROM public.notification_preferences
    WHERE user_id = NEW.following_id AND follows = false
  ) THEN RETURN NEW; END IF;

  INSERT INTO public.notifications (user_id, type, message, actor_id)
  VALUES (NEW.following_id, 'follow', follower_name || ' a commencé à vous suivre', NEW.follower_id);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_new_follow ON public.follows;
CREATE TRIGGER on_new_follow
  AFTER INSERT ON public.follows
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_follow();
