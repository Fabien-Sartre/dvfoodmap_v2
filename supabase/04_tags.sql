-- =============================================================
-- dvfoodmap v2 — Étape 7 : tags pratiques
-- À coller dans Supabase : SQL Editor → New query → Run
--
-- Les libellés proposés vivent côté frontend (config.js → TAGS) ;
-- la base stocke un simple tableau de textes.
-- =============================================================

alter table public.restaurants
  add column tags text[] not null default '{}';

-- La vue liste ses colonnes explicitement : on la recrée pour
-- exposer la nouvelle colonne (ajout en fin, exigé par "or replace").
create or replace view public.restaurants_with_stats
with (security_invoker = true) as
select
  r.id, r.name, r.address, r.lat, r.lng,
  r.food_type, r.price_range, r.added_by, r.created_at,
  coalesce(round(avg(v.rating), 1), 0) as avg_rating,
  count(v.id)::int                     as reviews_count,
  r.tags
from public.restaurants r
left join public.reviews v on v.restaurant_id = r.id
group by r.id;
