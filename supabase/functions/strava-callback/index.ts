// Active Coach · Login & koneksi Strava.
//
//   GET  ?start=1&nonce=XXXX          → arahkan ke halaman izin Strava (Masuk dengan Strava)
//   GET  ?code=...&state=login.XXXX   → tukar kode di server, buat/masuk akun Supabase, simpan
//                                       paket sesi sekali-pakai, lalu kembali ke aplikasi:
//                                       activecoach://auth?code=<handoff>&nonce=XXXX
//   POST ?redeem=1 {code, nonce}      → aplikasi mengambil sesi + token Strava (sekali pakai, 10 menit)
//   GET  ?code=...&state=<lainnya>    → (hubungkan ulang Strava dari dalam aplikasi) diteruskan ke
//                                       activecoach://strava?... seperti sebelumnya
//
// Secret yang dipakai: STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET (wajib),
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY (otomatis tersedia di Supabase).
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const SCOPE = 'read,activity:read_all,profile:read_all';

const env = (k: string) => Deno.env.get(k) ?? '';
const BASE = env('SUPABASE_URL').replace(/\/+$/, '');
const SELF = BASE + '/functions/v1/strava-callback';
function firstKey(name: string) { try { const o = JSON.parse(env(name) || '{}'); return String(o.default || Object.values(o)[0] || ''); } catch { return ''; } }
const SERVICE = env('SERVICE_ROLE_KEY') || env('SUPABASE_SERVICE_ROLE_KEY') || firstKey('SUPABASE_SECRET_KEYS');
const ANON = env('SUPABASE_ANON_KEY') || env('ANON_KEY') || firstKey('SUPABASE_PUBLISHABLE_KEYS');
const STRAVA = env('STRAVA_BASE_URL') || 'https://www.strava.com';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function back(path: string, params: Record<string, string>) {
  const q = new URLSearchParams(params).toString();
  return new Response(null, { status: 302, headers: { Location: 'activecoach://' + path + (q ? '?' + q : ''), 'Cache-Control': 'no-store' } });
}
function adminHeaders(json = true): Record<string, string> {
  const h: Record<string, string> = { apikey: SERVICE };
  if (SERVICE.startsWith('eyJ')) h.Authorization = 'Bearer ' + SERVICE;
  if (json) h['Content-Type'] = 'application/json';
  return h;
}
function randomCode(bytes = 24) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}
async function readJson(res: Response) { const t = await res.text(); try { return t ? JSON.parse(t) : {}; } catch { return { raw: t }; } }

async function stravaToken(code: string) {
  const body = new URLSearchParams({ client_id: env('STRAVA_CLIENT_ID'), client_secret: env('STRAVA_CLIENT_SECRET'), code, grant_type: 'authorization_code' });
  const res = await fetch(STRAVA + '/oauth/token', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const j = await readJson(res);
  if (!res.ok || !j.access_token) {
    const msg = JSON.stringify(j).toLowerCase();
    if (res.status === 403 || msg.includes('limit')) throw new Error('Aplikasi Strava ini sudah mencapai batas jumlah atlet. Pemilik aplikasi perlu mengajukan kenaikan kuota di strava.com/settings/api.');
    if (res.status === 401) throw new Error('STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET di Supabase tidak cocok dengan aplikasi Strava.');
    throw new Error('Strava menolak kode login (' + res.status + '). Coba lagi.');
  }
  return j;
}

async function sessionFor(athlete: Record<string, unknown>) {
  const email = 'strava-' + athlete.id + '@athlete.activecoach.app';
  const name = [athlete.firstname, athlete.lastname].filter(Boolean).join(' ').trim() || 'Atlet Strava';
  const meta = { strava_id: athlete.id, name, avatar: athlete.profile || athlete.profile_medium || '', provider: 'strava' };
  // 1) buat akun kalau belum ada (sudah ada → 422, tidak apa-apa)
  const created = await fetch(BASE + '/auth/v1/admin/users', { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ email, email_confirm: true, user_metadata: meta }) });
  if (!created.ok && created.status !== 422 && created.status !== 400) throw new Error('Gagal membuat akun (' + created.status + '): ' + JSON.stringify(await readJson(created)).slice(0, 160));
  // 2) buat tautan masuk sekali pakai lalu tukar jadi sesi
  const linkRes = await fetch(BASE + '/auth/v1/admin/generate_link', { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ type: 'magiclink', email }) });
  const link = await readJson(linkRes);
  if (!linkRes.ok) throw new Error('Gagal menyiapkan sesi (' + linkRes.status + '): ' + JSON.stringify(link).slice(0, 160));
  const tokenHash = link.hashed_token || (link.properties && link.properties.hashed_token);
  const vtype = link.verification_type || (link.properties && link.properties.verification_type) || 'magiclink';
  const userId = link.id || (link.user && link.user.id);
  if (userId) await fetch(BASE + '/auth/v1/admin/users/' + userId, { method: 'PUT', headers: adminHeaders(), body: JSON.stringify({ user_metadata: meta }) }).catch(() => {});
  const verRes = await fetch(BASE + '/auth/v1/verify', { method: 'POST', headers: { apikey: ANON || SERVICE, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: vtype, token_hash: tokenHash }) });
  const session = await readJson(verRes);
  if (!verRes.ok || !session.access_token) throw new Error('Gagal membuat sesi (' + verRes.status + '): ' + JSON.stringify(session).slice(0, 160));
  return session;
}

async function saveHandoff(code: string, payload: unknown) {
  const res = await fetch(BASE + '/rest/v1/ac_handoff', { method: 'POST', headers: { ...adminHeaders(), Prefer: 'return=minimal' }, body: JSON.stringify([{ code, payload }]) });
  if (!res.ok) throw new Error(res.status === 404 ? 'Tabel ac_handoff belum ada. Jalankan SQL 20261001000000_strava_login.sql di Supabase › SQL Editor, lalu coba lagi.' : 'Gagal menyimpan sesi sementara (' + res.status + ').');
}
async function takeHandoff(code: string) {
  const q = BASE + '/rest/v1/ac_handoff?code=eq.' + encodeURIComponent(code);
  const res = await fetch(q + '&select=payload,created_at', { headers: adminHeaders(false) });
  const rows = await readJson(res);
  await fetch(q, { method: 'DELETE', headers: adminHeaders(false) }).catch(() => {});
  await fetch(BASE + '/rest/v1/ac_handoff?created_at=lt.' + encodeURIComponent(new Date(Date.now() - 15 * 60000).toISOString()), { method: 'DELETE', headers: adminHeaders(false) }).catch(() => {});
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  if (Date.now() - new Date(row.created_at).getTime() > 10 * 60000) return null;
  return row.payload;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const u = new URL(req.url), q = u.searchParams;

  // Cek dari aplikasi: fungsi ada & versi terbaru
  if (q.has('ping')) {
    let table = false;
    if (SERVICE) { try { const t = await fetch(BASE + '/rest/v1/ac_handoff?select=code&limit=1', { headers: adminHeaders(false) }); table = t.ok; } catch { /* abaikan */ } }
    return json({ ok: true, v: 2, strava: !!env('STRAVA_CLIENT_ID') && !!env('STRAVA_CLIENT_SECRET'), service: !!SERVICE, table });
  }

  // Aplikasi mengambil hasil login
  if (req.method === 'POST' && q.has('redeem')) {
    let b: { code?: string; nonce?: string } = {};
    try { b = await req.json(); } catch { /* kosong */ }
    if (!b.code) return json({ error: 'Kode login kosong' }, 400);
    const payload = await takeHandoff(String(b.code));
    if (!payload) return json({ error: 'Kode login kedaluwarsa. Ulangi Masuk dengan Strava.' }, 410);
    if (payload.nonce && b.nonce && payload.nonce !== b.nonce) return json({ error: 'Kode login bukan untuk perangkat ini.' }, 403);
    return json(payload);
  }

  // Mulai login
  if (q.has('start')) {
    const nonce = (q.get('nonce') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    if (!env('STRAVA_CLIENT_ID')) return back('auth', { error: 'STRAVA_CLIENT_ID belum diisi di Supabase › Edge Functions › Secrets' });
    const target = new URL('https://www.strava.com/oauth/mobile/authorize');
    target.search = new URLSearchParams({ client_id: env('STRAVA_CLIENT_ID'), redirect_uri: SELF, response_type: 'code', approval_prompt: 'auto', scope: SCOPE, state: 'login.' + nonce }).toString();
    return new Response(null, { status: 302, headers: { Location: target.toString(), 'Cache-Control': 'no-store' } });
  }

  const state = q.get('state') || '';
  if (state.startsWith('login.')) {
    const nonce = state.slice(6);
    if (q.get('error')) return back('auth', { error: 'Izin Strava dibatalkan', nonce });
    try {
      if (!SERVICE) throw new Error('SUPABASE_SERVICE_ROLE_KEY tidak tersedia di Edge Function');
      const tok = await stravaToken(q.get('code') || '');
      const session = await sessionFor(tok.athlete || {});
      const code = randomCode();
      await saveHandoff(code, {
        nonce,
        session: { access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at, expires_in: session.expires_in, user: session.user },
        strava: { access_token: tok.access_token, refresh_token: tok.refresh_token, expires_at: tok.expires_at, athlete: tok.athlete, scope: q.get('scope') || '' },
      });
      return back('auth', { code, nonce });
    } catch (e) {
      return back('auth', { error: String((e as Error).message || e).slice(0, 220), nonce });
    }
  }

  // Hubungkan ulang Strava dari dalam aplikasi (alur lama)
  return back('strava', Object.fromEntries(q.entries()));
});
