-- Active Coach · mode maintenance (kunci aplikasi sementara untuk pengguna selain pemilik)
-- Satu baris 'maintenance' di ac_config: {"on":true,"until":"…","reason":"…"}. Semua orang (juga yang belum
-- login) boleh membaca supaya aplikasi bisa menampilkan layar maintenance; hanya admin / server yang mengubah.
-- Butuh: 20261001120000_feedback.sql (ac_is_admin). Aman dijalankan berulang.

create table if not exists public.ac_config (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.ac_config enable row level security;

drop policy if exists "config baca" on public.ac_config;
create policy "config baca" on public.ac_config for select to anon, authenticated
  using (key in ('maintenance'));

drop policy if exists "config kelola" on public.ac_config;
create policy "config kelola" on public.ac_config for all to authenticated
  using (public.ac_is_admin()) with check (public.ac_is_admin());

grant select on public.ac_config to anon, authenticated;
grant insert, update on public.ac_config to authenticated;

insert into public.ac_config (key, value) values ('maintenance', '{"on": false}'::jsonb)
on conflict (key) do nothing;

notify pgrst, 'reload schema';
