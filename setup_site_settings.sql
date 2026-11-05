-- 1. Create the site_settings table
CREATE TABLE IF NOT EXISTS public.site_settings (
  id integer PRIMARY KEY DEFAULT 1,
  is_troll_mode boolean NOT NULL DEFAULT false,
  updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  CONSTRAINT single_row CHECK (id = 1)
);

-- 2. Insert the initial row if it doesn't exist
INSERT INTO public.site_settings (id, is_troll_mode)
VALUES (1, false)
ON CONFLICT (id) DO NOTHING;

-- 3. Enable RLS but allow anyone to read (so the client can fetch the troll mode state)
ALTER TABLE public.site_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read access to site_settings"
  ON public.site_settings FOR SELECT
  USING (true);

-- 4. Allow admins to update the settings
-- Assumes you have some way to identify admins (e.g. is_admin = true in profiles table)
-- We'll allow authenticated users to update for now, but realistically you should restrict it to admins.
-- If you have a specific admin role/flag, replace "true" below with the appropriate check.
CREATE POLICY "Allow authenticated users to update settings"
  ON public.site_settings FOR UPDATE
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

-- 5. Enable real-time for this table
ALTER PUBLICATION supabase_realtime ADD TABLE site_settings;
