-- =============================================================
-- dvfoodmap v2 — Export des données de démo publique
-- À coller dans Supabase : SQL Editor → New query → Run
--
-- Utilitaire de lecture seule : ne fait PAS partie de la séquence
-- d'installation 01→04 et ne modifie rien en base.
--
-- Produit le contenu complet de demo-data.js dans une seule cellule
-- (colonne demo_js) : copier la cellule et la coller telle quelle
-- dans demo-data.js à la racine du repo.
--
-- Aucune donnée personnelle exportée : pas d'added_by, pas d'avis
-- individuels, pas d'emails — uniquement les fiches et les stats
-- agrégées (note moyenne, nombre d'avis).
-- =============================================================
select
     '// Données de démo publiques — générées le ' || to_char(now(), 'YYYY-MM-DD')
  || ' depuis restaurants_with_stats.' || e'\n'
  || '// Aucune donnée personnelle : pas d''added_by, pas d''avis individuels, pas d''emails.' || e'\n'
  || '// Pour régénérer : exécuter supabase/export_demo_data.sql (voir CLAUDE.md § Mode démo).' || e'\n'
  || 'window.DEMO_DATA = '
  || jsonb_pretty(jsonb_build_object(
       'restaurants',
       coalesce(
         jsonb_agg(
           jsonb_build_object(
             'id',            id,
             'name',          name,
             'address',       address,
             'lat',           lat,
             'lng',           lng,
             'food_type',     food_type,
             'price_range',   price_range,
             'tags',          tags,
             'created_at',    created_at,
             'avg_rating',    avg_rating,
             'reviews_count', reviews_count
           )
           order by name
         ),
         '[]'::jsonb
       )
     ))
  || ';' as demo_js
from public.restaurants_with_stats;
