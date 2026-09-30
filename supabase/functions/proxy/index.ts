// Active Coach · proxy aman untuk engine di HP.
// - Hanya meneruskan ke Strava & Open-Meteo (tujuan lain ditolak).
// - Menyisipkan STRAVA_CLIENT_SECRET di server, jadi secret tidak pernah ada di aplikasi.
// - Hanya melayani pengguna yang sudah login (token Supabase dicek ke /auth/v1/user).
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const ALLOW = [
  /^https:\/\/www\.strava\.com\/api\/v3\//,
  /^https:\/\/www\.strava\.com\/oauth\/token$/,
  /^https:\/\/(api|archive-api|geocoding-api)\.open-meteo\.com\//,
];
const verified = new Map<string, number>();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

async function isLoggedIn(req: Request, base: string): Promise<boolean> {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return false;
  const until = verified.get(token);
  if (until && until > Date.now()) return true;
  const apikey = req.headers.get('apikey') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const res = await fetch(base + '/auth/v1/user', { headers: { apikey, Authorization: 'Bearer ' + token } });
  if (!res.ok) return false;
  if (verified.size > 500) verified.clear();
  verified.set(token, Date.now() + 5 * 60 * 1000);
  return true;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const base = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '');
  if (!(await isLoggedIn(req, base))) return json({ error: 'Belum login' }, 401);

  const u = new URL(req.url);
  if (req.method === 'GET' && u.searchParams.has('config')) {
    return json({
      stravaClientId: Deno.env.get('STRAVA_CLIENT_ID') ?? '',
      redirectUri: base + '/functions/v1/strava-callback',
    });
  }
  if (req.method !== 'POST') return json({ error: 'Metode tidak didukung' }, 405);

  let r: { url?: string; method?: string; headers?: Record<string, string>; body?: string | null };
  try { r = await req.json(); } catch { return json({ error: 'Body bukan JSON' }, 400); }

  let target = String(r.url ?? '');
  const path = target.split('?')[0];
  if (!ALLOW.some((re) => re.test(path))) return json({ error: 'Tujuan tidak diizinkan: ' + path }, 403);

  const secret = Deno.env.get('STRAVA_CLIENT_SECRET') ?? '';
  const inject = (s: string) => s.replace(/client_secret=__SERVER__/g, 'client_secret=' + encodeURIComponent(secret));
  target = inject(target);
  let body = r.body == null ? undefined : inject(String(r.body));

  const headers = new Headers();
  for (const [k, v] of Object.entries(r.headers ?? {})) {
    if (/^(authorization|content-type|accept)$/i.test(k)) headers.set(k, String(v));
  }
  const method = String(r.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') body = undefined;

  try {
    const res = await fetch(target, { method, headers, body });
    const text = await res.text();
    return json({ status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? '' }, body: text });
  } catch (e) {
    return json({ status: 502, headers: {}, body: JSON.stringify({ message: 'Gagal menghubungi ' + path + ': ' + String(e) }) });
  }
});
