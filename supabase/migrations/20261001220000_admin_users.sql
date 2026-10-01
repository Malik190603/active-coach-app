-- Active Coach · daftar pengguna untuk admin + preferensi notifikasi per HP
-- Butuh: 20261001120000_feedback.sql, 20261001180000_admin_suite.sql, 20261001200000_push.sql. Aman dijalankan berulang.

-- Preferensi notifikasi per HP (mis. {"update": false, "event": false})
alter table public.ac_push_tokens add column if not exists prefs jsonb not null default '{}'::jsonb;

create or replace function public.ac_register_push(p_token text, p_platform text, p_version text, p_prefs jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Belum login' using errcode = '42501'; end if;
  insert into public.ac_push_tokens (token, user_id, platform, app_version, prefs, updated_at)
  values (p_token, auth.uid(), left(coalesce(p_platform, 'android'), 20), left(coalesce(p_version, ''), 20), coalesce(p_prefs, '{}'::jsonb), now())
  on conflict (token) do update set user_id = excluded.user_id, platform = excluded.platform, app_version = excluded.app_version, prefs = excluded.prefs, updated_at = now();
end $$;
revoke all on function public.ac_register_push(text, text, text, jsonb) from public, anon;
grant execute on function public.ac_register_push(text, text, text, jsonb) to authenticated;

-- Siapa saja yang memakai aplikasi (hanya admin). Tidak mengembalikan email/token/data latihan,
-- hanya profil Strava publik + angka pemakaian.
create or replace function public.ac_admin_users()
returns table (
  user_id uuid, name text, avatar text, strava_id text, joined timestamptz, last_sign_in timestamptz,
  last_active date, app_version text, platform text, opens_30d bigint, push_devices bigint, activities bigint, is_admin boolean
) language plpgsql stable security definer set search_path = public as $$
begin
  if not public.ac_is_admin() then raise exception 'Hanya admin' using errcode = '42501'; end if;
  return query
  select u.id,
         coalesce(nullif(u.raw_user_meta_data->>'name', ''), nullif(u.raw_user_meta_data->>'full_name', ''), 'Atlet')::text,
         coalesce(u.raw_user_meta_data->>'avatar', '')::text,
         coalesce(nullif(u.raw_user_meta_data->>'strava_id', ''), substring(u.email from 'strava-([0-9]+)@'), '')::text,
         u.created_at, u.last_sign_in_at,
         (select max(a.day) from public.ac_usage a where a.user_id = u.id),
         (select a.app_version from public.ac_usage a where a.user_id = u.id order by a.day desc limit 1)::text,
         (select a.platform from public.ac_usage a where a.user_id = u.id order by a.day desc limit 1)::text,
         (select coalesce(sum(a.opens), 0) from public.ac_usage a where a.user_id = u.id and a.day > current_date - 30)::bigint,
         (select count(*) from public.ac_push_tokens t where t.user_id = u.id)::bigint,
         (select coalesce(sum(greatest(jsonb_array_length(c.data) - case when c.chunk = 0 then 1 else 0 end, 0)), 0)
            from public.ac_chunks c where c.user_id = u.id and c.sheet = 'LogAktivitas' and jsonb_typeof(c.data) = 'array')::bigint,
         exists (select 1 from public.ac_admins ad where ad.user_id = u.id)
  from auth.users u
  where u.email like 'strava-%@athlete.activecoach.app'
  order by u.created_at desc;
end $$;
revoke all on function public.ac_admin_users() from public, anon;
grant execute on function public.ac_admin_users() to authenticated;

notify pgrst, 'reload schema';
