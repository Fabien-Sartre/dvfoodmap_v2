-- =============================================================
-- dvfoodmap v2 — Étape 8 : périmètre géographique
-- À coller dans Supabase : SQL Editor → New query → Run
--
-- Refuse tout restaurant hors de la région parisienne (Paris +
-- proche banlieue), même via un appel API direct. Le frontend
-- affiche un message sympa avant d'en arriver là (config.js →
-- GEOFENCE, à garder synchronisé avec ces bornes).
--
-- Si le bureau déménage hors de cette zone un jour :
--   alter table public.restaurants drop constraint restaurants_zone_paris;
--   puis recréer la contrainte avec les nouvelles bornes.
-- =============================================================

alter table public.restaurants
  add constraint restaurants_zone_paris
  check (lat between 48.70 and 49.05 and lng between 2.10 and 2.60);
