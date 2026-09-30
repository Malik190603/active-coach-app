-- Active Coach · panel admin: pengumuman, kalender event, statistik pemakaian anonim
-- Aman dijalankan berulang kali. Butuh 20261001120000_feedback.sql (tabel ac_admins & ac_is_admin).

-- ---------------------------------------------------------------- pengumuman
create table if not exists public.ac_announcements (
  id         bigint generated always as identity primary key,
  title      text        not null check (length(title) between 1 and 120),
  body       text        not null default '' check (length(body) <= 2000),
  level      text        not null default 'info' check (level in ('info', 'penting', 'update', 'event')),
  link       text        not null default '' check (length(link) <= 500),
  active     boolean     not null default true,
  starts_at  timestamptz not null default now(),
  ends_at    timestamptz,
  created_by uuid        default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists ac_announcements_live_idx on public.ac_announcements (active, starts_at desc);
alter table public.ac_announcements enable row level security;
drop policy if exists "pengumuman lihat" on public.ac_announcements;
create policy "pengumuman lihat" on public.ac_announcements for select to authenticated
  using ((active and starts_at <= now() and (ends_at is null or ends_at > now())) or public.ac_is_admin());
drop policy if exists "pengumuman kelola" on public.ac_announcements;
create policy "pengumuman kelola" on public.ac_announcements for all to authenticated
  using (public.ac_is_admin()) with check (public.ac_is_admin());
grant select, insert, update, delete on public.ac_announcements to authenticated;

-- ---------------------------------------------------------------- kalender event
create table if not exists public.ac_events (
  id          bigint generated always as identity primary key,
  title       text        not null check (length(title) between 1 and 140),
  sport       text        not null default 'Lari' check (sport in ('Lari', 'Sepeda', 'Triathlon', 'Renang', 'Trail', 'Lainnya')),
  event_date  date        not null,
  city        text        not null default '' check (length(city) <= 80),
  location    text        not null default '' check (length(location) <= 160),
  distances   text        not null default '' check (length(distances) <= 120),
  url         text        not null default '' check (length(url) <= 500),
  description text        not null default '' check (length(description) <= 1500),
  active      boolean     not null default true,
  created_by  uuid        default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists ac_events_date_idx on public.ac_events (event_date);
alter table public.ac_events enable row level security;
drop policy if exists "event lihat" on public.ac_events;
create policy "event lihat" on public.ac_events for select to authenticated
  using (active or public.ac_is_admin());
drop policy if exists "event kelola" on public.ac_events;
create policy "event kelola" on public.ac_events for all to authenticated
  using (public.ac_is_admin()) with check (public.ac_is_admin());
grant select, insert, update, delete on public.ac_events to authenticated;

-- ---------------------------------------------------------------- statistik pemakaian (anonim)
-- Satu baris per pengguna per hari. Pengguna hanya bisa menulis & membaca barisnya sendiri;
-- admin hanya melihat angka gabungan lewat ac_admin_stats() — tidak ada data per orang.
create table if not exists public.ac_usage (
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  day         date        not null default current_date,
  app_version text        not null default '' check (length(app_version) <= 20),
  platform    text        not null default '' check (length(platform) <= 20),
  opens       integer     not null default 0 check (opens between 0 and 100000),
  features    jsonb       not null default '{}'::jsonb,
  errors      jsonb       not null default '[]'::jsonb,
  updated_at  timestamptz not null default now(),
  primary key (user_id, day),
  check (pg_column_size(features) <= 8000 and pg_column_size(errors) <= 8000)
);
create index if not exists ac_usage_day_idx on public.ac_usage (day);
alter table public.ac_usage enable row level security;
drop policy if exists "usage milik sendiri" on public.ac_usage;
create policy "usage milik sendiri" on public.ac_usage for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
grant select, insert, update, delete on public.ac_usage to authenticated;

-- ---------------------------------------------------------------- angka gabungan untuk dasbor admin
create or replace function public.ac_admin_stats(p_days integer default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  d integer := greatest(7, least(coalesce(p_days, 30), 365));
  today date := (now() at time zone 'Asia/Makassar')::date;
  res jsonb;
begin
  if not public.ac_is_admin() then
    raise exception 'Hanya admin' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'generated_at', now(),
    'days', d,
    'users_total', (select count(*) from auth.users where email like 'strava-%@athlete.activecoach.app'),
    'users_new_7d', (select count(*) from auth.users where email like 'strava-%@athlete.activecoach.app' and created_at > now() - interval '7 days'),
    'users_new_30d', (select count(*) from auth.users where email like 'strava-%@athlete.activecoach.app' and created_at > now() - interval '30 days'),
    'dau', (select count(distinct user_id) from ac_usage where day = today),
    'wau', (select count(distinct user_id) from ac_usage where day > today - 7),
    'mau', (select count(distinct user_id) from ac_usage where day > today - 30),
    'opens_7d', (select coalesce(sum(opens), 0) from ac_usage where day > today - 7),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', g.day::date, 'users', coalesce(u.n, 0)) order by g.day), '[]'::jsonb)
              from generate_series(today - (d - 1), today, interval '1 day') as g(day)
              left join (select day, count(distinct user_id) n from ac_usage group by day) u on u.day = g.day::date),
    'versions', (select coalesce(jsonb_agg(jsonb_build_object('version', v, 'users', n) order by n desc), '[]'::jsonb)
                 from (select app_version v, count(*) n from (
                         select distinct on (user_id) user_id, app_version from ac_usage
                         where day > today - d and app_version <> ''
                         order by user_id, day desc) last group by app_version) x),
    'features', (select coalesce(jsonb_agg(jsonb_build_object('name', k, 'count', c, 'users', u) order by c desc), '[]'::jsonb)
                 from (select e.key k, sum((e.value)::text::numeric)::bigint c, count(distinct a.user_id) u
                       from ac_usage a, jsonb_each(a.features) e
                       where a.day > today - d and jsonb_typeof(e.value) = 'number'
                       group by e.key order by c desc limit 15) f),
    'errors', (select coalesce(jsonb_agg(jsonb_build_object('message', m, 'count', c, 'users', u, 'last', l) order by c desc), '[]'::jsonb)
               from (select x->>'m' m, sum(coalesce((x->>'n')::int, 1))::bigint c, count(distinct a.user_id) u, max(a.day) l
                     from ac_usage a, jsonb_array_elements(a.errors) x
                     where a.day > today - 7 and jsonb_typeof(a.errors) = 'array' and coalesce(x->>'m', '') <> ''
                     group by x->>'m' order by c desc limit 12) er),
    'feedback', (select jsonb_build_object(
                   'baru', count(*) filter (where status = 'baru'),
                   'dibaca', count(*) filter (where status = 'dibaca'),
                   'selesai', count(*) filter (where status = 'selesai'),
                   'minggu_ini', count(*) filter (where created_at > now() - interval '7 days'))
                 from ac_feedback),
    'announcements_live', (select count(*) from ac_announcements where active and starts_at <= now() and (ends_at is null or ends_at > now())),
    'events_upcoming', (select count(*) from ac_events where active and event_date >= today)
  ) into res;
  return res;
end $$;
revoke all on function public.ac_admin_stats(integer) from public, anon;
grant execute on function public.ac_admin_stats(integer) to authenticated;

notify pgrst, 'reload schema';
