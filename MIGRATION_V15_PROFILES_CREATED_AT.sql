-- Migration V15: Add created_at column to profiles table for analytics tracking
-- This allows tracking user signup dates for analytics and analytics dashboard

ALTER TABLE public.profiles ADD COLUMN created_at timestamp with time zone DEFAULT now();

-- If there's an auth.users table with created_at, we could sync them:
-- UPDATE public.profiles p SET created_at = u.created_at FROM auth.users u WHERE p.id = u.id;
-- For now, we use the default timestamp for existing users beside n rew users going forward.t473tz48tztz geeuirlueqbebihrghre5455z5z5z78z75567864587643785645638564835645345486584636785748357hburileqbzuihfbsdwneofbsidbvke éfk
