// Active Coach · Login & koneksi Strava.
//
//   GET  ?start=1&nonce=XXXX          → arahkan ke halaman izin Strava (Masuk dengan Strava)
//   GET  ?code=...&state=login.XXXX   → tukar kode di server, buat/masuk akun Supabase, simpan
//                                       paket sesi sekali-pakai, lalu kembali ke aplikasi:
//                                       activecoach://auth?code=<handoff>&nonce=XXXX
//   POST ?redeem=1 {code, nonce}      → aplikasi mengambil sesi + token Strava (sekali pakai, 10 menit)
//   GET  ?code=...&state=<lainnya>    → (hubungkan ulang Strava dari dalam aplikasi) diteruskan ke
//                                       activecoach://strava?... seperti sebelumnya
//   POST ?push=1 {title, body, data, target, category, user_id, version, tag}
//                                     → kirim notifikasi HP lewat Firebase. Admin: target "all" / "outdated"
//                                       (versi lebih lama dari `version`) / "user" (user_id). Siapa pun: "self".
//   POST ?release=1                   → (dipanggil GitHub Actions setelah rilis) cek rilis terbaru di GitHub;
//                                       kalau versinya belum diumumkan: buat pengumuman + notifikasi ke HP
//                                       yang versinya lebih lama. Aman dipanggil berulang (sekali per versi).
//
// Secret yang dipakai: STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET (wajib), FCM_SERVICE_ACCOUNT (opsional, JSON
// kunci akun layanan Firebase untuk notifikasi HP),
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
const GOOGLE_OAUTH = env('FCM_OAUTH_URL') || 'https://oauth2.googleapis.com/token';
const FCM_BASE = env('FCM_BASE_URL') || 'https://fcm.googleapis.com';

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


/* ---------- Webhook Strava: aktivitas baru & pencabutan izin ---------- */
async function verifyToken() {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env('STRAVA_CLIENT_SECRET') + ':active-coach-webhook'));
  return Array.from(new Uint8Array(d)).slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function upsertMeta(userId: string, key: string, value: unknown) {
  await fetch(BASE + '/rest/v1/ac_meta?on_conflict=user_id,key', { method: 'POST', headers: { ...adminHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ user_id: userId, key, value }]) });
}
async function linkAthlete(userId: string, athleteId: string | number) {
  if (userId && athleteId) await upsertMeta(userId, 'strava_link', { id: String(athleteId) });
}
async function userForAthlete(athleteId: string | number) {
  const r = await fetch(BASE + '/rest/v1/ac_meta?select=user_id&key=eq.strava_link&value->>id=eq.' + encodeURIComponent(String(athleteId)), { headers: adminHeaders(false) });
  const rows = await readJson(r);
  return Array.isArray(rows) && rows[0] ? String(rows[0].user_id) : '';
}
async function ensureSubscription() {
  const id = env('STRAVA_CLIENT_ID'), secret = env('STRAVA_CLIENT_SECRET');
  if (!id || !secret) return { ok: false, error: 'STRAVA_CLIENT_ID/SECRET kosong' };
  const list = await readJson(await fetch(STRAVA + '/api/v3/push_subscriptions?client_id=' + id + '&client_secret=' + encodeURIComponent(secret)));
  if (Array.isArray(list) && list.length) {
    const mine = list.find((x: { callback_url?: string }) => String(x.callback_url || '').replace(/\/+$/, '') === SELF);
    if (mine) return { ok: true, id: mine.id, existing: true };
    const old = list[0];
    // Webhook lama dari versi web (Apps Script) sudah tidak dipakai sejak callback pindah ke Supabase → ganti.
    if (!/script\.google(usercontent)?\.com/.test(String(old.callback_url || ''))) return { ok: false, error: 'Aplikasi Strava sudah punya webhook ke alamat lain: ' + old.callback_url };
    await fetch(STRAVA + '/api/v3/push_subscriptions/' + old.id + '?client_id=' + id + '&client_secret=' + encodeURIComponent(secret), { method: 'DELETE' });
  }
  const body = new URLSearchParams({ client_id: id, client_secret: secret, callback_url: SELF, verify_token: await verifyToken() });
  const res = await fetch(STRAVA + '/api/v3/push_subscriptions', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const j = await readJson(res);
  return res.ok && j.id ? { ok: true, id: j.id, created: true } : { ok: false, error: 'Strava menolak webhook (' + res.status + '): ' + JSON.stringify(j).slice(0, 200) };
}
async function userFromToken(req: Request) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const who = await fetch(BASE + '/auth/v1/user', { headers: { apikey: ANON || SERVICE, Authorization: 'Bearer ' + token } });
  const user = await readJson(who);
  return who.ok && user.id ? user : null;
}

/* ---------------- Firebase Cloud Messaging (HTTP v1) ---------------- */
const GITHUB_REPO = env('GITHUB_REPO') || 'Malik190603/active-coach-app';
const GITHUB_API = env('GITHUB_API') || 'https://api.github.com';
function verNewer(a: string, b: string) { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; }
type TokRow = { token: string; user_id?: string; app_version?: string; prefs?: Record<string, unknown> };
async function pushTokens(filter = ''): Promise<TokRow[] | null> {
  let r = await fetch(BASE + '/rest/v1/ac_push_tokens?select=token,user_id,app_version,prefs' + filter, { headers: adminHeaders(false) });
  if (!r.ok) r = await fetch(BASE + '/rest/v1/ac_push_tokens?select=token,user_id,app_version' + filter, { headers: adminHeaders(false) });
  if (r.status === 404) return null;
  const j = await readJson(r); return Array.isArray(j) ? j : [];
}
function wants(row: TokRow, category: string) { if (!category || category === 'maint') return true; const p = row.prefs || {}; return p[category] !== false; }
function channelFor(category: string) { return category === 'maint' ? 'alerts' : 'announcements'; }

let FCM_TOKEN: { token: string; exp: number } | null = null;
function fcmAccount(): { client_email: string; private_key: string; project_id: string } | null {
  try { const a = JSON.parse(env('FCM_SERVICE_ACCOUNT') || 'null'); return a && a.client_email && a.private_key && a.project_id ? a : null; } catch { return null; }
}
function b64url(data: Uint8Array | string) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let s = ''; bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function fcmAccessToken() {
  if (FCM_TOKEN && FCM_TOKEN.exp > Date.now() + 60000) return FCM_TOKEN.token;
  const sa = fcmAccount(); if (!sa) throw new Error('FCM_SERVICE_ACCOUNT belum diisi');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\\n/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  const res = await fetch(GOOGLE_OAUTH, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + unsigned + '.' + b64url(sig) });
  const j = await readJson(res);
  if (!res.ok || !j.access_token) throw new Error('Google menolak kunci Firebase (' + res.status + '): ' + JSON.stringify(j).slice(0, 160));
  FCM_TOKEN = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return FCM_TOKEN.token;
}
async function fcmSend(tokens: string[], title: string, body: string, data: Record<string, string>, opt: { channel?: string; tag?: string } = {}) {
  const sa = fcmAccount(); if (!sa) throw new Error('FCM_SERVICE_ACCOUNT belum diisi');
  const access = await fcmAccessToken(), url = FCM_BASE + '/v1/projects/' + sa.project_id + '/messages:send';
  let sent = 0, failed = 0; const dead: string[] = [], errors: string[] = [];
  const queue = tokens.slice();
  async function worker() {
    while (queue.length) {
      const token = queue.shift() as string;
      try {
        const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: { token, notification: { title, body }, data, android: { priority: 'HIGH', notification: Object.assign({ channel_id: opt.channel || 'announcements', icon: 'ic_stat_ac', color: '#FC4C02', default_sound: true }, opt.tag ? { tag: opt.tag } : {}) } } }) });
        if (r.ok) { sent++; continue; }
        failed++; const j = await readJson(r), code = JSON.stringify(j);
        if (r.status === 404 || /UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT/.test(code)) dead.push(token);
        else if (errors.length < 3) errors.push(r.status + ' ' + code.slice(0, 140));
      } catch (e) { failed++; if (errors.length < 3) errors.push(String((e as Error).message || e)); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(10, tokens.length) }, worker));
  for (const t of dead) { try { await fetch(BASE + '/rest/v1/ac_push_tokens?token=eq.' + encodeURIComponent(t), { method: 'DELETE', headers: adminHeaders(false) }); } catch { /* abaikan */ } }
  return { sent, failed, removed: dead.length, errors };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const u = new URL(req.url), q = u.searchParams;

  // Strava memverifikasi alamat webhook
  if (req.method === 'GET' && q.get('hub.mode') === 'subscribe') {
    if (q.get('hub.verify_token') !== await verifyToken()) return json({ error: 'verify_token salah' }, 403);
    return json({ 'hub.challenge': q.get('hub.challenge') || '' });
  }
  // Event webhook dari Strava (aktivitas dibuat/diubah/dihapus, atau izin dicabut)
  if (req.method === 'POST' && ![...q.keys()].length) {
    let ev: { object_type?: string; aspect_type?: string; object_id?: number; owner_id?: number; updates?: Record<string, string>; event_time?: number } = {};
    try { ev = await req.json(); } catch { /* bukan JSON */ }
    if (ev && ev.owner_id && ev.object_type && SERVICE) {
      try {
        const userId = await userForAthlete(ev.owner_id);
        if (userId) {
          if (ev.object_type === 'athlete' && ev.updates && String(ev.updates.authorized) === 'false') await upsertMeta(userId, 'strava_revoked', { at: Date.now() });
          else if (ev.object_type === 'activity') await upsertMeta(userId, 'strava_inbox', { at: Date.now(), id: ev.object_id, aspect: ev.aspect_type });
        }
      } catch { /* jangan gagal: Strava butuh 200 */ }
    }
    return json({ ok: true });
  }
  // Aplikasi mendaftarkan webhook (sekali) & menautkan akun Strava ke akun aplikasi
  if (req.method === 'POST' && q.has('subscribe')) {
    const user = await userFromToken(req);
    if (!user || !SERVICE) return json({ error: 'Belum login' }, 401);
    const sid = (user.user_metadata && user.user_metadata.strava_id) || (String(user.email || '').match(/^strava-(\d+)@/) || [])[1];
    if (sid) await linkAthlete(user.id, sid);
    let sub: Record<string, unknown> = { ok: false };
    try { sub = await ensureSubscription(); } catch (e) { sub = { ok: false, error: String((e as Error).message || e) }; }
    return json({ ok: true, linked: !!sid, webhook: sub });
  }

  // Kirim notifikasi HP (pengumuman dari admin, atau uji ke HP sendiri)
  if (req.method === 'POST' && q.has('push')) {
    const user = await userFromToken(req);
    if (!user || !SERVICE) return json({ error: 'Belum login' }, 401);
    let b: { title?: string; body?: string; data?: Record<string, unknown>; target?: string; category?: string; user_id?: string; version?: string; tag?: string } = {};
    try { b = await req.json(); } catch { /* kosong */ }
    const target = b.target || 'all', self = target === 'self';
    if (!self) {
      const ad = await fetch(BASE + '/rest/v1/ac_admins?select=user_id&user_id=eq.' + user.id, { headers: adminHeaders(false) });
      const rows = await readJson(ad);
      if (!ad.ok || !Array.isArray(rows) || !rows.length) return json({ error: 'Hanya admin yang bisa mengirim ke pengguna lain' }, 403);
    }
    if (!fcmAccount()) return json({ error: 'Secret FCM_SERVICE_ACCOUNT belum diisi di Supabase › Edge Functions › Secrets' }, 400);
    const filter = self ? '&user_id=eq.' + user.id : target === 'user' && b.user_id ? '&user_id=eq.' + encodeURIComponent(b.user_id) : '';
    const list = await pushTokens(filter);
    if (list === null) return json({ error: 'Tabel ac_push_tokens belum ada — jalankan SQL 20261001200000_push.sql' }, 400);
    const category = String(b.category || ''), seen = new Set<string>();
    const picked = list.filter((r) => {
      if (seen.has(r.token)) return false; seen.add(r.token);
      if (target === 'outdated' && b.version && r.app_version && !verNewer(String(b.version), r.app_version)) return false;
      return self || target === 'user' || wants(r, category);
    }).map((r) => r.token);
    if (!picked.length) return json({ ok: true, total: 0, sent: 0, failed: 0, removed: 0, skipped: list.length });
    const data: Record<string, string> = {};
    Object.entries(b.data || {}).forEach(([k, v]) => { data[k] = String(v ?? '').slice(0, 300); });
    try {
      const r = await fcmSend(picked, String(b.title || 'Active Coach').slice(0, 120), String(b.body || '').slice(0, 300), data, { channel: channelFor(category), tag: b.tag ? String(b.tag).slice(0, 40) : undefined });
      return json({ ok: true, total: picked.length, skipped: list.length - picked.length, ...r });
    } catch (e) { return json({ error: String((e as Error).message || e) }, 500); }
  }

  // Rilis baru di GitHub → pengumuman + notifikasi otomatis (sekali per versi)
  if (q.has('release')) {
    if (!SERVICE) return json({ error: 'Service key tidak tersedia' }, 500);
    const gr = await fetch(GITHUB_API + '/repos/' + GITHUB_REPO + '/releases/latest', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'active-coach' } });
    if (!gr.ok) return json({ error: 'GitHub ' + gr.status }, 502);
    const rel = await readJson(gr), version = String(rel.tag_name || '').replace(/^v/i, '');
    if (!/^\d+\.\d+\.\d+$/.test(version)) return json({ error: 'Versi rilis tidak dikenali' }, 400);
    const title = '🚀 Versi ' + version + ' sudah tersedia';
    const ex = await fetch(BASE + '/rest/v1/ac_announcements?select=id&title=eq.' + encodeURIComponent(title), { headers: adminHeaders(false) });
    if (ex.status === 404) return json({ error: 'Tabel ac_announcements belum ada' }, 400);
    const exRows = await readJson(ex);
    if (Array.isArray(exRows) && exRows.length) return json({ ok: true, version, already: true });
    const notes = String(rel.body || '').replace(/\r/g, ''), cut = notes.search(/^## Catatan developer/m), user = cut >= 0 ? notes.slice(0, cut) : notes;
    const bullets = user.split('\n').map((l) => l.trim()).filter((l) => /^[-*•] /.test(l)).slice(0, 4).map((l) => '• ' + l.replace(/^[-*•] /, ''));
    const body = (bullets.length ? 'Yang baru:\n' + bullets.join('\n') + '\n\n' : '') + 'Perbarui langsung dari aplikasi — tanpa uninstall, data tetap aman.';
    const ins = await fetch(BASE + '/rest/v1/ac_announcements', { method: 'POST', headers: { ...adminHeaders(true), Prefer: 'return=representation' }, body: JSON.stringify([{ title, body, level: 'update', link: String(rel.html_url || ''), active: true, starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 14 * 864e5).toISOString(), created_by: null }]) });
    const insRows = await readJson(ins), annId = Array.isArray(insRows) && insRows[0] ? String(insRows[0].id) : '';
    let push: Record<string, unknown> = { skipped: 'FCM belum diatur' };
    if (fcmAccount()) {
      const list = (await pushTokens('')) || [], seen = new Set<string>();
      const picked = list.filter((r) => { if (seen.has(r.token)) return false; seen.add(r.token); return (!r.app_version || verNewer(version, r.app_version)) && wants(r, 'update'); }).map((r) => r.token);
      if (picked.length) {
        const short = bullets.length ? bullets.slice(0, 2).map((b) => b.replace(/^• /, '')).join(' · ') : 'Ketuk untuk memperbarui — tanpa uninstall.';
        try { push = await fcmSend(picked, title, short.slice(0, 230), { go: 'update', id: annId, version }, { channel: 'announcements', tag: 'update' }); push.total = picked.length; } catch (e) { push = { error: String((e as Error).message || e) }; }
      } else push = { total: 0 };
    }
    return json({ ok: true, version, announced: ins.ok, push });
  }

  // Cek dari aplikasi: fungsi ada & versi terbaru
  if (q.has('ping')) {
    let table = false;
    if (SERVICE) { try { const t = await fetch(BASE + '/rest/v1/ac_handoff?select=code&limit=1', { headers: adminHeaders(false) }); table = t.ok; } catch { /* abaikan */ } }
    return json({ ok: true, v: 5, strava: !!env('STRAVA_CLIENT_ID') && !!env('STRAVA_CLIENT_SECRET'), service: !!SERVICE, table, push: !!fcmAccount() });
  }

  // Cabut izin Strava (Putuskan Strava) & hapus akun beserta semua data
  if (req.method === 'POST' && (q.has('deauth') || q.has('delete'))) {
    let b: { access_token?: string } = {};
    try { b = await req.json(); } catch { /* kosong */ }
    let revoked = false;
    if (b.access_token) {
      try { const r = await fetch(STRAVA + '/oauth/deauthorize', { method: 'POST', headers: { Authorization: 'Bearer ' + b.access_token } }); revoked = r.ok || r.status === 401; } catch { /* abaikan */ }
    }
    if (q.has('deauth')) return json({ ok: true, revoked });
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token || !SERVICE) return json({ error: 'Belum login' }, 401);
    const who = await fetch(BASE + '/auth/v1/user', { headers: { apikey: ANON || SERVICE, Authorization: 'Bearer ' + token } });
    const user = await readJson(who);
    if (!who.ok || !user.id) return json({ error: 'Sesi tidak valid, masuk lagi lalu ulangi.' }, 401);
    const del = await fetch(BASE + '/auth/v1/admin/users/' + user.id, { method: 'DELETE', headers: adminHeaders(false) });
    if (!del.ok) return json({ error: 'Gagal menghapus akun (' + del.status + ')' }, 500);
    return json({ ok: true, revoked, deleted: true });
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
      try { if (session.user && session.user.id && tok.athlete && tok.athlete.id) await linkAthlete(session.user.id, tok.athlete.id); } catch { /* abaikan */ }
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
