-- =============================================================
-- dvfoodmap v2 — Étape 6bis : rôle admin
-- À coller dans Supabase : SQL Editor → New query → Run
--
-- Les admins peuvent modifier et supprimer N'IMPORTE QUEL
-- restaurant (la suppression efface aussi ses avis, en cascade).
-- La table admins n'a AUCUNE policy : impossible à toucher depuis
-- le site — on n'y ajoute des membres que via le dashboard.
-- =============================================================

create table public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
-- (aucune policy : lecture/écriture refusées à tous les clients)

-- "L'utilisateur courant est-il admin ?" — seule porte de lecture,
-- et elle ne répond que pour soi-même.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admins
    where user_id = (select auth.uid())
  );
$$;

-- Les policies s'additionnent (OU logique) : celles-ci s'ajoutent
-- aux droits "propriétaire" existants sans les remplacer.
create policy "restaurants_update_admin"
  on public.restaurants for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "restaurants_delete_admin"
  on public.restaurants for delete
  to authenticated
  using (public.is_admin());

-- Premier admin : Fabien.
insert into public.admins (user_id)
select id from auth.users where email = 'fabien.sartre@digitalvalue.fr';

-- Pour promouvoir quelqu'un plus tard (SQL Editor) :
--   insert into public.admins (user_id)
--   select id from auth.users where email = 'prenom.nom@digitalvalue.fr';
-- Pour retirer le rôle :
--   delete from public.admins where user_id =
--     (select id from auth.users where email = 'prenom.nom@digitalvalue.fr');
