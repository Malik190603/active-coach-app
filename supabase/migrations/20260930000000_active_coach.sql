-- Active Coach · skema database Supabase
-- Setiap akun = satu "workspace" (pengganti Google Spreadsheet). Isi tiap sheet disimpan
-- per potongan (chunk) 150 baris supaya sinkronisasi hanya mengirim bagian yang berubah.

create table if not exists public.ac_chunks (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  sheet      text        not null,
  chunk      integer     not null,
  hash       text        not null,
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, sheet, chunk)
);

create table if not exists public.ac_meta (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  key        text        not null,
  value      jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

create table if not exists public.ac_files (
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id          text        not null,
  kind        text        not null default 'file',
  name        text        not null default '',
  mime        text        not null default 'application/octet-stream',
  parent      text,
  trashed     boolean     not null default false,
  description text        not null default '',
  created     bigint      not null default 0,
  data        text        not null default '',
  updated_at  timestamptz not null default now(),
  primary key (user_id, id)
);

create or replace function public.ac_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists ac_chunks_touch on public.ac_chunks;
create trigger ac_chunks_touch before update on public.ac_chunks for each row execute function public.ac_touch();
drop trigger if exists ac_meta_touch on public.ac_meta;
create trigger ac_meta_touch before update on public.ac_meta for each row execute function public.ac_touch();
drop trigger if exists ac_files_touch on public.ac_files;
create trigger ac_files_touch before update on public.ac_files for each row execute function public.ac_touch();

-- Keamanan: setiap pengguna hanya bisa membaca & menulis datanya sendiri.
alter table public.ac_chunks enable row level security;
alter table public.ac_meta   enable row level security;
alter table public.ac_files  enable row level security;

drop policy if exists "ac_chunks milik sendiri" on public.ac_chunks;
create policy "ac_chunks milik sendiri" on public.ac_chunks for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "ac_meta milik sendiri" on public.ac_meta;
create policy "ac_meta milik sendiri" on public.ac_meta for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "ac_files milik sendiri" on public.ac_files;
create policy "ac_files milik sendiri" on public.ac_files for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.ac_chunks, public.ac_meta, public.ac_files to authenticated;
revoke all on public.ac_chunks, public.ac_meta, public.ac_files from anon;
