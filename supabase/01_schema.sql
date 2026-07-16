-- =============================================================
-- dvfoodmap v2 — Étape 2 : schéma de base
-- À coller dans Supabase : Dashboard → SQL Editor → New query → Run
--
-- Les policies RLS arrivent à l'Étape 3 (supabase/02_rls.sql).
-- Avec "automatic RLS" activé, ces tables naissent avec RLS ON et
-- zéro policy : tout accès client est refusé tant que l'étape 3
-- n'est pas passée. C'est voulu (défaut sûr).
-- =============================================================

-- -------------------------------------------------------------
-- 1) Profils utilisateurs
-- auth.users n'est pas lisible depuis le navigateur ; on copie le
-- strict nécessaire (nom d'affichage) pour pouvoir signer les avis.
-- -------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at   timestamptz not null default now()
);

-- Rempli automatiquement à chaque création de compte :
-- "prenom.nom@digitalvalue.fr" -> "Prenom Nom"
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer            -- s'exécute avec les droits du propriétaire (nécessaire : le trigger tourne hors session utilisateur)
set search_path = ''        -- durcissement recommandé pour les fonctions security definer
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    initcap(replace(split_part(new.email, '@', 1), '.', ' '))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- -------------------------------------------------------------
-- 2) Restaurants
-- Pas de colonne distance : la distance/temps de marche est
-- calculée côté client à partir de lat/lng et des coordonnées du
-- bureau (le bureau peut re-déménager sans invalider les données).
-- -------------------------------------------------------------
create table public.restaurants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 120),
  address     text not null check (length(trim(address)) between 1 and 300),
  lat         double precision not null check (lat between -90 and 90),
  lng         double precision not null check (lng between -180 and 180),
  food_type   text,
  price_range text check (price_range in ('€', '€€', '€€€', '€€€€')),
  added_by    uuid default auth.uid() references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (name, address)   -- évite les doublons de saisie
);

-- -------------------------------------------------------------
-- 3) Avis
-- Un seul avis par personne et par restaurant : on modifie son
-- avis au lieu d'en empiler plusieurs (simple et anti-spam).
-- -------------------------------------------------------------
create table public.reviews (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  rating        numeric(2,1) not null
                check (rating between 0.5 and 5 and mod(rating * 2, 1) = 0),  -- pas de 0,5 en 0,5
  comment       text check (comment is null or length(comment) <= 2000),
  created_at    timestamptz not null default now(),
  unique (restaurant_id, user_id)
);

create index reviews_restaurant_id_idx on public.reviews (restaurant_id);

-- -------------------------------------------------------------
-- 4) Vue : restaurants + note moyenne + nombre d'avis
-- Rien n'est stocké : toujours à jour automatiquement.
-- security_invoker = la vue applique le RLS de l'utilisateur qui
-- interroge (sinon une vue peut contourner le RLS des tables).
-- -------------------------------------------------------------
create view public.restaurants_with_stats
with (security_invoker = true) as
select
  r.id, r.name, r.address, r.lat, r.lng,
  r.food_type, r.price_range, r.added_by, r.created_at,
  coalesce(round(avg(v.rating), 1), 0) as avg_rating,
  count(v.id)::int                     as reviews_count
from public.restaurants r
left join public.reviews v on v.restaurant_id = r.id
group by r.id;
