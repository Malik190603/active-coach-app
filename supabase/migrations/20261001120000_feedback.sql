-- Active Coach · kotak masuk kritik & saran
-- Pengguna mengirim masukan; hanya admin (pemilik aplikasi) yang bisa melihat semuanya & membalas.
create table if not exists public.ac_feedback (
  id          bigint generated always as identity primary key,
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  name        text        not null default '',
  kind        text        not null default 'Saran fitur',
  message     text        not null check (length(message) between 1 and 4000),
  app_version text        not null default '',
  device      text        not null default '',
  status      text        not null default 'baru' check (status in ('baru', 'dibaca', 'selesai')),
  reply       text,
  replied_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists ac_feedback_created_idx on public.ac_feedback (created_at desc);

create table if not exists public.ac_admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

alter table public.ac_feedback enable row level security;
alter table public.ac_admins   enable row level security;

create or replace function public.ac_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.ac_admins where user_id = auth.uid())
$$;

drop policy if exists "feedback kirim" on public.ac_feedback;
create policy "feedback kirim" on public.ac_feedback for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists "feedback lihat" on public.ac_feedback;
create policy "feedback lihat" on public.ac_feedback for select to authenticated
  using ((select auth.uid()) = user_id or public.ac_is_admin());
drop policy if exists "feedback kelola" on public.ac_feedback;
create policy "feedback kelola" on public.ac_feedback for update to authenticated
  using (public.ac_is_admin()) with check (public.ac_is_admin());
drop policy if exists "feedback hapus" on public.ac_feedback;
create policy "feedback hapus" on public.ac_feedback for delete to authenticated
  using (public.ac_is_admin());
drop policy if exists "admin cek diri" on public.ac_admins;
create policy "admin cek diri" on public.ac_admins for select to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.ac_feedback to authenticated;
grant select on public.ac_admins to authenticated;

-- Admin = akun Strava pertama yang masuk ke aplikasi (pemilik aplikasi).
insert into public.ac_admins (user_id)
select id from auth.users
where email like 'strava-%@athlete.activecoach.app'
order by created_at
limit 1
on conflict do nothing;

-- Pindahkan masukan lama (tersimpan di data masing-masing akun) ke kotak masuk.
insert into public.ac_feedback (user_id, name, kind, message, created_at)
select c.user_id,
       coalesce(r->>2, ''),
       coalesce(nullif(r->>3, ''), 'Saran fitur'),
       r->>4,
       case when jsonb_typeof(r->0) = 'object' and (r->0) ? '$d'
            then to_timestamp(((r->0)->>'$d')::bigint / 1000.0) else now() end
from public.ac_chunks c, jsonb_array_elements(c.data) r
where c.sheet = 'Feedback'
  and jsonb_typeof(r) = 'array'
  and coalesce(r->>1, '') <> 'AthleteId'
  and coalesce(r->>4, '') <> ''
  and not exists (select 1 from public.ac_feedback f where f.user_id = c.user_id and f.message = r->>4);

notify pgrst, 'reload schema';
