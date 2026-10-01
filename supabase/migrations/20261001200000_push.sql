-- Active Coach · token notifikasi HP (Firebase Cloud Messaging)
-- Satu baris per HP. Pengguna hanya bisa mengelola token miliknya; server (strava-callback ?push=1)
-- membaca semua token memakai service key untuk mengirim pengumuman. Aman dijalankan berulang kali.
create table if not exists public.ac_push_tokens (
  token       text primary key check (length(token) between 20 and 4096),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  platform    text not null default 'android' check (length(platform) <= 20),
  app_version text not null default '' check (length(app_version) <= 20),
  updated_at  timestamptz not null default now()
);
create index if not exists ac_push_tokens_user_idx on public.ac_push_tokens (user_id);
alter table public.ac_push_tokens enable row level security;
drop policy if exists "push milik sendiri" on public.ac_push_tokens;
create policy "push milik sendiri" on public.ac_push_tokens for select to authenticated
  using ((select auth.uid()) = user_id);
grant select on public.ac_push_tokens to authenticated;

-- Daftarkan / pindahkan token ke akun yang sedang login (HP yang sama bisa ganti akun).
create or replace function public.ac_register_push(p_token text, p_platform text default 'android', p_version text default '')
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Belum login' using errcode = '42501'; end if;
  insert into public.ac_push_tokens (token, user_id, platform, app_version, updated_at)
  values (p_token, auth.uid(), left(coalesce(p_platform, 'android'), 20), left(coalesce(p_version, ''), 20), now())
  on conflict (token) do update set user_id = excluded.user_id, platform = excluded.platform, app_version = excluded.app_version, updated_at = now();
end $$;
create or replace function public.ac_unregister_push(p_token text)
returns void language sql security definer set search_path = public as $$
  delete from public.ac_push_tokens where token = p_token and user_id = auth.uid();
$$;
revoke all on function public.ac_register_push(text, text, text) from public, anon;
revoke all on function public.ac_unregister_push(text) from public, anon;
grant execute on function public.ac_register_push(text, text, text) to authenticated;
grant execute on function public.ac_unregister_push(text) to authenticated;

notify pgrst, 'reload schema';
