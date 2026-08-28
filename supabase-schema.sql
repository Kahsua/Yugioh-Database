-- ============================================================
-- Yu-Gi-Oh Sammlung - Datenbankschema für Supabase
-- ============================================================
-- Anleitung: Im Supabase Dashboard -> SQL Editor -> "New query"
-- diesen kompletten Inhalt einfügen -> "Run"
-- ============================================================

-- Profile (ein Eintrag pro Nutzer, für den sichtbaren Namen)
create table if not exists profiles (
  id uuid references auth.users on delete cascade primary key,
  username text unique not null,
  created_at timestamptz default now()
);

-- Karten-Sammlung
create table if not exists cards (
  id bigint generated always as identity primary key,
  owner_id uuid references auth.users on delete cascade not null,
  ygo_id integer,
  name_de text,
  name_en text not null,
  card_type text,
  attribute text,
  race text,
  atk integer,
  def integer,
  level integer,
  image_url text,
  quantity integer not null default 1,
  notes text,
  effect_text_de text,
  effect_text_en text,
  archetype text,
  scale integer,
  created_at timestamptz default now()
);

create index if not exists cards_owner_idx on cards (owner_id);
create index if not exists cards_name_idx on cards (name_de, name_en);

-- Row Level Security aktivieren
alter table profiles enable row level security;
alter table cards enable row level security;

-- Profile: alle dürfen alle Profile SEHEN, aber nur das eigene anlegen/ändern
drop policy if exists "profiles_select_all" on profiles;
create policy "profiles_select_all" on profiles
  for select using (true);

drop policy if exists "profiles_insert_own" on profiles;
create policy "profiles_insert_own" on profiles
  for insert with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on profiles;
create policy "profiles_update_own" on profiles
  for update using (auth.uid() = id);

-- Karten: alle dürfen ALLE Karten sehen (damit man sieht "wer hat was"),
-- aber nur eigene Karten anlegen / ändern / löschen
drop policy if exists "cards_select_all" on cards;
create policy "cards_select_all" on cards
  for select using (true);

drop policy if exists "cards_insert_own" on cards;
create policy "cards_insert_own" on cards
  for insert with check (auth.uid() = owner_id);

drop policy if exists "cards_update_own" on cards;
create policy "cards_update_own" on cards
  for update using (auth.uid() = owner_id);

drop policy if exists "cards_delete_own" on cards;
create policy "cards_delete_own" on cards
  for delete using (auth.uid() = owner_id);

-- ============================================================
-- Verlauf / Änderungsprotokoll
-- ============================================================
create table if not exists history (
  id bigint generated always as identity primary key,
  owner_id uuid references auth.users on delete cascade not null,
  card_id bigint references cards(id) on delete set null,
  card_name text not null,
  action text not null check (action in ('add', 'update', 'delete', 'import')),
  quantity_before integer,
  quantity_after integer,
  created_at timestamptz default now()
);

create index if not exists history_created_idx on history (created_at desc);

alter table history enable row level security;

drop policy if exists "history_select_all" on history;
create policy "history_select_all" on history
  for select using (true);

drop policy if exists "history_insert_own" on history;
create policy "history_insert_own" on history
  for insert with check (auth.uid() = owner_id);

-- ============================================================
-- Automatisches Anlegen des Profils bei Registrierung
-- ============================================================
-- Läuft serverseitig (SECURITY DEFINER = umgeht RLS), damit das Profil
-- auch dann angelegt wird, wenn die E-Mail noch nicht bestätigt ist und
-- somit clientseitig noch keine aktive Sitzung existiert.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- Migration für bereits bestehende Projekte (gefahrlos mehrfach ausführbar)
-- ============================================================
alter table cards add column if not exists effect_text_de text;
alter table cards add column if not exists effect_text_en text;
alter table cards add column if not exists archetype text;
alter table cards add column if not exists scale integer;

-- Falls die Spalte "effect_text" (Vorversion) existiert, ihren Inhalt als
-- englischen Kartentext übernehmen (dort wurde bisher nur Englisch gespeichert):
do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'cards' and column_name = 'effect_text') then
    update cards set effect_text_en = effect_text where effect_text_en is null and effect_text is not null;
  end if;
end $$;

-- ============================================================
-- Einmalige Bereinigung: Dubletten zusammenführen (gleicher Besitzer +
-- gleiche ygo_id, entstanden z.B. wenn eine Karte per CSV-Import UND
-- später nochmal manuell über die Suche angelegt wurde). Anzahl wird
-- aufsummiert, überzählige Zeilen gelöscht. Gefahrlos mehrfach ausführbar -
-- sobald keine Dubletten mehr existieren, passiert schlicht nichts.
-- ============================================================
with dupes as (
  select owner_id, ygo_id, min(id) as keep_id, sum(quantity) as total_qty
  from cards
  where ygo_id is not null
  group by owner_id, ygo_id
  having count(*) > 1
)
update cards c
set quantity = d.total_qty
from dupes d
where c.id = d.keep_id;

with dupes as (
  select owner_id, ygo_id, min(id) as keep_id
  from cards
  where ygo_id is not null
  group by owner_id, ygo_id
  having count(*) > 1
)
delete from cards c
using dupes d
where c.owner_id = d.owner_id
  and c.ygo_id = d.ygo_id
  and c.id <> d.keep_id;
