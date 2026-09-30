-- Active Coach · login dengan Strava
-- Tabel serah-terima sesi sekali pakai (hanya bisa diakses Edge Function dengan service role).
create table if not exists public.ac_handoff (
  code       text        primary key,
  payload    jsonb       not null,
  created_at timestamptz not null default now()
);
alter table public.ac_handoff enable row level security;
revoke all on public.ac_handoff from anon, authenticated;
create index if not exists ac_handoff_created_idx on public.ac_handoff (created_at);
