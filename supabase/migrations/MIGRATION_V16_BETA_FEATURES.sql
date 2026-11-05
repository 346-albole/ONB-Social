-- Phase 1: Database Migration for Beta Features
-- Adds anonymous/invisible flags for admins and view counts for posts.

-- 1. Add admin features to profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_anonymous boolean DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_invisible boolean DEFAULT false;

-- 2. Add view count to posts
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS views bigint DEFAULT 0;

-- 3. Create a function to increment post views safely
DROP FUNCTION IF EXISTS public.increment_post_views(uuid);
DROP FUNCTION IF EXISTS public.increment_post_views(bigint);
CREATE OR REPLACE FUNCTION public.increment_post_views(post_id bigint)
RETURNS void AS $$
BEGIN
  UPDATE public.posts
  SET views = views + 1
  WHERE id = post_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Admin SQL runner (USE WITH CAUTION)
CREATE OR REPLACE FUNCTION public.admin_run_sql(query text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result json;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  EXECUTE 'SELECT json_agg(t) FROM (' || query || ') t' INTO result;
  RETURN result;
END;
$$;
-- 5. Enable RLS for the function if needed (accessible by authenticated users)
-- No special RLS needed for functions by default, but we can restrict if necessary.
