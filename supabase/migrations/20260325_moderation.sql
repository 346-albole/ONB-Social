-- Migration to add moderation columns to profiles table
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS warnings_count INT DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT false;
