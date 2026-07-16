-- =============================================================
-- dvfoodmap v2 — Étape 3 : Row Level Security
-- À coller dans Supabase : SQL Editor → New query → Run
-- Prérequis : 01_schema.sql déjà exécuté.
--
-- Rappel du modèle de sécurité :
--   la clé anon est publique (visible dans le HTML) → TOUTE la
--   protection vit ici, dans ces policies. Rien d'autre.
-- =============================================================

-- -------------------------------------------------------------
-- 0) RLS explicitement activé (idempotent ; l'automatic RLS l'a
--    normalement déjà fait, mais on ne dépend pas d'un réglage).
-- -------------------------------------------------------------
alter table public.profiles    enable row level security;
alter table public.restaurants enable row level security;
alter table public.reviews     enable row level security;

-- -------------------------------------------------------------
-- 1) Fonction utilitaire : "l'utilisateur courant est-il un
--    membre confirmé de digitalvalue.fr ?"
--    security definer : nécessaire pour lire auth.users (les
--    clients n'y ont pas accès). Elle ne renvoie qu'un booléen
--    sur l'utilisateur COURANT, donc rien à divulguer.
-- -------------------------------------------------------------
create or replace function public.is_company_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select au.email ilike '%@digitalvalue.fr'
        and au.email_confirmed_at is not null   -- email confirmé obligatoire
     from auth.users au
     where au.id = (select auth.uid())),
    false                                       -- non connecté -> false
  );
$$;

-- -------------------------------------------------------------
-- 2) PROFILES
-- -------------------------------------------------------------
-- Lecture : tout membre confirmé (pour afficher les auteurs des avis).
create policy "profiles_select_company"
  on public.profiles for select
  to authenticated
  using (public.is_company_user());

-- Chacun peut corriger son propre nom d'affichage.
create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()) and public.is_company_user());

-- Pas de policy insert/delete : la création passe par le trigger
-- on_auth_user_created (qui s'exécute en propriétaire, hors RLS).

-- -------------------------------------------------------------
-- 3) RESTAURANTS
-- -------------------------------------------------------------
-- Lecture : tout membre confirmé.
create policy "restaurants_select_company"
  on public.restaurants for select
  to authenticated
  using (public.is_company_user());

-- Ajout : tout membre confirmé, et added_by = soi-même
-- (impossible d'attribuer un ajout à quelqu'un d'autre).
create policy "restaurants_insert_company"
  on public.restaurants for insert
  to authenticated
  with check (
    public.is_company_user()
    and added_by = (select auth.uid())
  );

-- Modification : uniquement celui qui a ajouté le restaurant
-- (corriger une adresse, un type de cuisine…).
create policy "restaurants_update_own"
  on public.restaurants for update
  to authenticated
  using (added_by = (select auth.uid()))
  with check (
    added_by = (select auth.uid())
    and public.is_company_user()
  );

-- PAS de policy delete : supprimer un restaurant effacerait les
-- avis des autres (cascade). La suppression reste possible pour
-- toi via le dashboard Supabase (Table Editor), qui bypasse le RLS.

-- -------------------------------------------------------------
-- 4) REVIEWS
-- -------------------------------------------------------------
-- Lecture : tout membre confirmé.
create policy "reviews_select_company"
  on public.reviews for select
  to authenticated
  using (public.is_company_user());

-- Ajout : membre confirmé, et user_id = soi-même
-- (aucun avis anonyme ou au nom d'un autre possible).
create policy "reviews_insert_own"
  on public.reviews for insert
  to authenticated
  with check (
    public.is_company_user()
    and user_id = (select auth.uid())
  );

-- Modification : uniquement ses propres avis.
create policy "reviews_update_own"
  on public.reviews for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Suppression : uniquement ses propres avis.
create policy "reviews_delete_own"
  on public.reviews for delete
  to authenticated
  using (user_id = (select auth.uid()));

-- -------------------------------------------------------------
-- 5) Ceinture et bretelles : verrou du domaine AU NIVEAU BASE.
--    Même si la restriction d'inscription côté Auth était mal
--    configurée ou contournée, aucun compte hors digitalvalue.fr
--    ne peut être créé.
-- -------------------------------------------------------------
create or replace function public.enforce_company_domain()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is null or new.email not ilike '%@digitalvalue.fr' then
    raise exception 'Inscription réservée aux adresses @digitalvalue.fr';
  end if;
  return new;
end;
$$;

create trigger ensure_company_domain
  before insert on auth.users
  for each row execute function public.enforce_company_domain();

-- Note : côté client, une inscription refusée par ce trigger remonte
-- comme une erreur générique "Database error saving new user" ;
-- le frontend affichera de toute façon un message propre car il
-- vérifiera aussi le domaine avant d'appeler signUp.
