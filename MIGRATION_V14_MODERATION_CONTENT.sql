-- MIGRATION_V14_MODERATION_CONTENT.sql
-- Adds moderation tools and content management features to the admin panel

-- ============================================================================
-- USER REPORTS TABLE (for moderation dashboard)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.user_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reported_user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  content_type VARCHAR(50) NOT NULL CHECK (content_type IN ('post', 'comment', 'message', 'profile', 'reel')),
  content_id TEXT NOT NULL,
  reason VARCHAR(255) NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'low' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewing', 'resolved', 'dismissed')),
  moderator_notes TEXT,
  resolved_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_user_reports_status ON public.user_reports(status);
CREATE INDEX IF NOT EXISTS idx_user_reports_severity ON public.user_reports(severity);
CREATE INDEX IF NOT EXISTS idx_user_reports_created_at ON public.user_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_reports_reported_user ON public.user_reports(reported_user_id);

-- Row-level security
ALTER TABLE public.user_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_access_user_reports" ON public.user_reports
  FOR ALL USING (
    auth.uid() IS NOT NULL AND (
      SELECT is_admin FROM public.profiles WHERE id = auth.uid()
    ) = TRUE
  );

-- ============================================================================
-- MODERATION FLAGS TABLE (auto-flagged and manually flagged content)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.moderation_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type VARCHAR(50) NOT NULL CHECK (content_type IN ('post', 'comment', 'message', 'reel')),
  content_id TEXT NOT NULL,
  flag_type VARCHAR(100) NOT NULL CHECK (flag_type IN ('spam', 'inappropriate', 'forbidden_word', 'auto_detected', 'manual')),
  severity VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  auto_flagged BOOLEAN NOT NULL DEFAULT FALSE,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  flagged_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_moderation_flags_resolved ON public.moderation_flags(resolved);
CREATE INDEX IF NOT EXISTS idx_moderation_flags_flag_type ON public.moderation_flags(flag_type);
CREATE INDEX IF NOT EXISTS idx_moderation_flags_created_at ON public.moderation_flags(created_at DESC);

ALTER TABLE public.moderation_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_access_moderation_flags" ON public.moderation_flags
  FOR ALL USING (
    auth.uid() IS NOT NULL AND (
      SELECT is_admin FROM public.profiles WHERE id = auth.uid()
    ) = TRUE
  );

-- ============================================================================
-- FORBIDDEN WORDS TABLE (admin-configurable moderation keywords)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.forbidden_words (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  word VARCHAR(255) NOT NULL UNIQUE,
  severity VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_forbidden_words_enabled ON public.forbidden_words(enabled);

ALTER TABLE public.forbidden_words ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_access_forbidden_words" ON public.forbidden_words
  FOR ALL USING (
    auth.uid() IS NOT NULL AND (
      SELECT is_admin FROM public.profiles WHERE id = auth.uid()
    ) = TRUE
  );

-- ============================================================================
-- FEATURED CONTENT TABLE (for content curation)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.featured_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type VARCHAR(50) NOT NULL CHECK (content_type IN ('post', 'reel', 'forum_post')),
  content_id TEXT NOT NULL,
  featured_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  featured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  featured_until TIMESTAMPTZ,
  "position" INTEGER NOT NULL DEFAULT 0,
  views_count INTEGER NOT NULL DEFAULT 0,
  clicks_count INTEGER NOT NULL DEFAULT 0,
  section VARCHAR(50) NOT NULL DEFAULT 'homepage' CHECK (section IN ('homepage', 'explore', 'trending')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_featured_content_section ON public.featured_content(section);
CREATE INDEX IF NOT EXISTS idx_featured_content_position ON public.featured_content("position");
CREATE INDEX IF NOT EXISTS idx_featured_content_featured_until ON public.featured_content(featured_until);

ALTER TABLE public.featured_content ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_access_featured_content" ON public.featured_content
  FOR ALL USING (
    auth.uid() IS NOT NULL AND (
      SELECT is_admin FROM public.profiles WHERE id = auth.uid()
    ) = TRUE
  );

-- ============================================================================
-- CONTENT CURATION RULES TABLE (for automatic content management)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_curation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_name VARCHAR(255) NOT NULL,
  rule_type VARCHAR(50) NOT NULL CHECK (rule_type IN ('boost', 'hide', 'recommend', 'flag')),
  criteria JSONB NOT NULL DEFAULT '{}',
  "action" VARCHAR(100) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_curation_rules_enabled ON public.content_curation_rules(enabled);
CREATE INDEX IF NOT EXISTS idx_content_curation_rules_rule_type ON public.content_curation_rules(rule_type);

ALTER TABLE public.content_curation_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_access_content_curation_rules" ON public.content_curation_rules
  FOR ALL USING (
    auth.uid() IS NOT NULL AND (
      SELECT is_admin FROM public.profiles WHERE id = auth.uid()
    ) = TRUE
  );

-- ============================================================================
-- TRENDING CONTENT TABLE (cached trending data, refreshed periodically)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.trending_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type VARCHAR(50) NOT NULL CHECK (content_type IN ('post', 'reel', 'forum_post')),
  content_id TEXT NOT NULL,
  trend_score FLOAT NOT NULL DEFAULT 0.0,
  engagement_count INTEGER NOT NULL DEFAULT 0,
  time_window VARCHAR(20) NOT NULL DEFAULT '24h' CHECK (time_window IN ('24h', '7d', 'all')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trending_content_unique ON public.trending_content(content_type, content_id, time_window);
CREATE INDEX IF NOT EXISTS idx_trending_content_trend_score ON public.trending_content(trend_score DESC);
CREATE INDEX IF NOT EXISTS idx_trending_content_updated_at ON public.trending_content(updated_at DESC);

ALTER TABLE public.trending_content ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_access_trending_content" ON public.trending_content
  FOR SELECT USING (
    auth.uid() IS NOT NULL AND (
      SELECT is_admin FROM public.profiles WHERE id = auth.uid()
    ) = TRUE
  );

-- ============================================================================
-- MODERATION ACTION LOG TABLE (audit trail for all moderation actions)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.moderation_action_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  action_type VARCHAR(50) NOT NULL CHECK (
    action_type IN ('warn_user', 'ban_user', 'unban_user', 'delete_content',
                    'flag_content', 'resolve_report', 'dismiss_report', 'feature_content', 'unfeature_content')
  ),
  target_user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  target_content_type VARCHAR(50),
  target_content_id TEXT,
  reason TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_moderation_action_logs_admin_id ON public.moderation_action_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_moderation_action_logs_action_type ON public.moderation_action_logs(action_type);
CREATE INDEX IF NOT EXISTS idx_moderation_action_logs_target_user ON public.moderation_action_logs(target_user_id);
CREATE INDEX IF NOT EXISTS idx_moderation_action_logs_created_at ON public.moderation_action_logs(created_at DESC);

ALTER TABLE public.moderation_action_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_access_moderation_logs" ON public.moderation_action_logs
  FOR SELECT USING (
    auth.uid() IS NOT NULL AND (
      SELECT is_admin FROM public.profiles WHERE id = auth.uid()
    ) = TRUE
  );

-- ============================================================================
-- Grant necessary permissions
-- ============================================================================
GRANT ALL ON TABLE public.user_reports TO authenticated;
GRANT ALL ON TABLE public.moderation_flags TO authenticated;
GRANT ALL ON TABLE public.forbidden_words TO authenticated;
GRANT ALL ON TABLE public.featured_content TO authenticated;
GRANT ALL ON TABLE public.content_curation_rules TO authenticated;
GRANT ALL ON TABLE public.trending_content TO authenticated;
GRANT SELECT ON TABLE public.moderation_action_logs TO authenticated;
