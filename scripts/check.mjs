// Pemeriksaan sebelum rilis (dijalankan di GitHub Actions setelah `npm run build`).
// 1) Sintaks semua skrip aplikasi & engine  2) file wajib ada  3) tidak ada kunci rahasia ikut ke APK
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WWW = path.join(ROOT, 'www');
let bad = 0;
const fail = (m) => { bad++; console.error('✗ ' + m); };
const ok = (m) => console.log('✓ ' + m);

if (!fs.existsSync(path.join(WWW, 'index.html'))) { console.error('www/index.html belum ada — jalankan npm run build dulu'); process.exit(1); }

// 1) sintaks
const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
const re = /<script>([\s\S]*?)<\/script>/g;
let m, n = 0;
while ((m = re.exec(html))) {
  n++;
  try { new vm.Script(m[1], { filename: 'index.html#script' + n }); }
  catch (e) { fail('index.html skrip ke-' + n + ': ' + e.message + ' → ' + m[1].trim().slice(0, 80).replace(/\s+/g, ' ')); }
}
ok(n + ' skrip di index.html');
for (const f of ['bridge.js', 'config.js', 'engine/code.js', 'engine/worker.js', 'engine/gas-shim.js', 'engine/app-engine.js']) {
  const p = path.join(WWW, f);
  if (!fs.existsSync(p)) { fail('file hilang: www/' + f); continue; }
  try { new vm.Script(fs.readFileSync(p, 'utf8'), { filename: f }); ok(f); } catch (e) { fail(f + ': ' + e.message); }
}

// 2) file & library lokal wajib ada (aplikasi harus bisa dibuka tanpa internet)
for (const f of ['vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/chart.umd.js', 'vendor/three.min.js', 'fonts/fonts.css']) {
  if (!fs.existsSync(path.join(WWW, f))) fail('library lokal hilang: www/' + f);
}
const remote = (html.match(/<(?:script|link)[^>]+(?:src|href)="https?:\/\/[^"]+"/g) || []);
if (remote.length) fail('masih memuat file dari internet: ' + remote.join(', ')); else ok('semua skrip & gaya dimuat lokal');
for (const f of ['package.json', 'capacitor.config.json']) { try { JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); ok(f); } catch (e) { fail(f + ': ' + e.message); } }

// 2b) update kilat: tanpa server & statistik pihak ketiga
try {
  const cu = (JSON.parse(fs.readFileSync(path.join(ROOT, 'capacitor.config.json'), 'utf8')).plugins || {}).CapacitorUpdater;
  if (!cu) fail('konfigurasi CapacitorUpdater tidak ada');
  else if (cu.autoUpdate !== false || cu.statsUrl !== '' || cu.updateUrl !== '' || cu.channelUrl !== '') fail('CapacitorUpdater harus mode manual tanpa statistik/server pihak ketiga (autoUpdate:false, statsUrl/updateUrl/channelUrl kosong)');
  else ok('update kilat: mode manual, tanpa statistik pihak ketiga');
} catch (e) { fail('capacitor.config.json: ' + e.message); }

// 3) kunci rahasia tidak boleh ikut ke aplikasi
const PATTERNS = [
  [/sb_secret_[A-Za-z0-9_-]{10,}/, 'Supabase secret key'],
  [/"role"\s*:\s*"service_role"/, 'service_role JWT'],
  [/eyJhbGciOi[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]*c2VydmljZV9yb2xl/, 'service_role JWT'],
  [/-----BEGIN (?:RSA )?PRIVATE KEY-----/, 'private key'],
  [/STRAVA_CLIENT_SECRET\s*[:=]\s*['"][0-9a-f]{20,}/i, 'Strava client secret'],
  [/sbp_[0-9a-f]{20,}/, 'Supabase access token']
];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
let scanned = 0;
for (const f of walk(WWW)) {
  if (!/\.(js|html|css|json)$/.test(f)) continue;
  const t = fs.readFileSync(f, 'utf8'); scanned++;
  for (const [rx, name] of PATTERNS) if (rx.test(t)) fail(name + ' ditemukan di ' + path.relative(ROOT, f));
}
ok(scanned + ' file dipindai: tidak ada kunci rahasia');

if (bad) { console.error('\n' + bad + ' masalah — rilis dibatalkan.'); process.exit(1); }
console.log('\nSemua pemeriksaan lolos.');
