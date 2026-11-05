-- =============================================================================
-- ONB-Social — données initiales minimales
-- =============================================================================
-- Aucun utilisateur n'est créé ici : les profils sont créés par l'API à la
-- première requête authentifiée. Pour promouvoir un admin, voir le README.

-- Ligne unique des réglages du site (mode troll désactivé).
INSERT INTO public.site_settings (id, is_troll_mode)
VALUES (1, false)
ON CONFLICT (id) DO NOTHING;
