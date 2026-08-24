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
  ygo_id integer not null,
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
