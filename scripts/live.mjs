// Update kilat (live update) di GitHub Actions.
//   node scripts/live.mjs base     → tentukan "basis native" rilis ini (NATIVE_BASE, LIVE_HASH ke $GITHUB_ENV)
//   node scripts/live.mjs pack     → zip isi web dari APK + tulis info ke catatan rilis (release-notes.md)
//
// Basis native = versi APK terakhir yang mengubah bagian native (plugin, izin, ikon, konfigurasi Capacitor,
// kunci tanda tangan, Firebase). Paket web hanya dipasang di HP yang basis native-nya sama; selain itu
// pengguna diarahkan memasang APK seperti biasa.
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
const VERSION = process.env.APP_VERSION || JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const REPO = process.env.GITHUB_REPOSITORY || 'Malik190603/active-coach-app';
const API = process.env.LIVE_GITHUB_API || 'https://api.github.com';
const env = (k, v) => { console.log(k + '=' + v); if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, k + '=' + v + '\n'); };
const out = (k, v) => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, k + '=' + v + '\n'); };

function nativeFingerprint() {
  const h = crypto.createHash('sha256');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  h.update('deps:' + JSON.stringify(Object.entries(pkg.dependencies || {}).sort()));
  const files = ['capacitor.config.json', 'scripts/prepare-android.mjs', 'signing/debug.keystore'];
  const assets = path.join(ROOT, 'assets');
  if (fs.existsSync(assets)) for (const f of fs.readdirSync(assets).sort()) files.push('assets/' + f);
  for (const f of files) { const p = path.join(ROOT, f); h.update('\n' + f + ':'); if (fs.existsSync(p) && fs.statSync(p).isFile()) h.update(fs.readFileSync(p)); }
  const gs = (process.env.GOOGLE_SERVICES_JSON || '').trim();
  h.update('\nfirebase:' + (gs ? crypto.createHash('sha256').update(gs).digest('hex') : (fs.existsSync(path.join(ROOT, 'firebase/google-services.json')) ? 'file' : 'none')));
  return h.digest('hex').slice(0, 24);
}
const marker = (body) => { const m = String(body || '').match(/<!--\s*ac-live\s+(\{[\s\S]*?\})\s*-->/); try { return m ? JSON.parse(m[1]) : null; } catch { return null; } };

async function base() {
  const hash = nativeFingerprint();
  let prev = null;
  try {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'active-coach-ci' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
    let r = await fetch(API + '/repos/' + REPO + '/releases?per_page=15', { headers });
    if (r.status === 401 && headers.Authorization) { delete headers.Authorization; r = await fetch(API + '/repos/' + REPO + '/releases?per_page=15', { headers }); }
    if (r.ok) for (const rel of await r.json()) { if (rel.draft) continue; const m = marker(rel.body); if (m) { prev = { ...m, tag: rel.tag_name }; break; } }
    else console.log('GitHub API ' + r.status + ' — anggap rilis native');
  } catch (e) { console.log('Tidak bisa membaca rilis sebelumnya: ' + e.message); }
  const same = prev && prev.hash === hash && prev.native;
  const nb = same ? prev.native : VERSION;
  console.log(same ? `Tanpa perubahan native sejak ${prev.tag} → update kilat (basis v${nb})` : `Perubahan native (atau rilis pertama) → APK baru jadi basis v${nb}`);
  env('NATIVE_BASE', nb); env('LIVE_HASH', hash); out('native', same ? 'false' : 'true'); out('base', nb);
}

function pack() {
  const pub = path.join(ROOT, 'android/app/src/main/assets/public');
  if (!fs.existsSync(path.join(pub, 'index.html'))) { console.error('android/app/src/main/assets/public belum ada — jalankan npm run android:prepare'); process.exit(1); }
  const cfg = fs.readFileSync(path.join(pub, 'config.js'), 'utf8');
  if (!cfg.includes('"version": "' + VERSION + '"')) { console.error('config.js tidak berisi versi ' + VERSION); process.exit(1); }
  const name = 'ActiveCoach-web-' + VERSION + '.zip', zip = path.join(ROOT, name);
  fs.rmSync(zip, { force: true });
  execSync('zip -q -r -9 -X ' + JSON.stringify(zip) + ' .', { cwd: pub, stdio: 'inherit' });
  const buf = fs.readFileSync(zip), sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const info = { v: VERSION, native: process.env.NATIVE_BASE || VERSION, hash: process.env.LIVE_HASH || nativeFingerprint(), asset: name, sha256, size: buf.length };
  const notes = path.join(ROOT, 'release-notes.md');
  fs.appendFileSync(notes, '\n<!-- ac-live ' + JSON.stringify(info) + ' -->\n');
  console.log('Paket web ' + name + ' · ' + (buf.length / 1048576).toFixed(2) + ' MB · sha256 ' + sha256.slice(0, 16) + '… · basis native v' + info.native);
}

if (mode === 'base') await base();
else if (mode === 'pack') pack();
else { console.error('Pakai: node scripts/live.mjs base|pack'); process.exit(1); }
