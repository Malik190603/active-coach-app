// Menyusun folder www/ untuk Capacitor dari file Apps Script di src/.
// - Index.html + semua include() digabung jadi www/index.html
// - Code.gs dipakai apa adanya oleh engine (Web Worker) di www/engine/code.js
// - Library (Leaflet, Chart.js, Three, html2pdf) dibundel lokal supaya aplikasi bisa dibuka offline
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src'), APP = path.join(ROOT, 'app'), OUT = path.join(ROOT, 'www'), NM = path.join(ROOT, 'node_modules');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function read(p) { return fs.readFileSync(p, 'utf8'); }
function write(p, s) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); }
function copy(from, to) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
function need(p) { if (!fs.existsSync(p)) { console.error('File tidak ditemukan: ' + path.relative(ROOT, p)); process.exit(1); } return p; }

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ---------- StravaLogo: pakai file asli jika ada, kalau tidak buat dari STRAVA_LOGO_IMG di Code.gs ----------
const code = read(need(path.join(SRC, 'Code.gs')));
let stravaLogo = '';
const logoFile = path.join(SRC, 'StravaLogo.html');
if (fs.existsSync(logoFile)) stravaLogo = read(logoFile);
else {
  const m = code.match(/var STRAVA_LOGO_IMG = '(<img src="data:image\/png;base64,[^"]+")/);
  stravaLogo = m ? m[1].replace('<img ', '<img id="stravaLogoImg" alt="Strava" style="display:none" ') + '>' : '<img id="stravaLogoImg" alt="Strava" style="display:none" src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27104%27 height=%2728%27%3E%3Ctext x=%270%27 y=%2721%27 font-family=%27Arial%27 font-size=%2720%27 font-weight=%27bold%27 font-style=%27italic%27 fill=%27%23fc4c02%27%3ESTRAVA%3C/text%3E%3C/svg%3E">';
}

// ---------- index.html ----------
let html = read(need(path.join(SRC, 'Index.html')));
html = html.replace(/<\?!=\s*include\('([^']+)'\)\s*\?>/g, (m, name) => {
  if (name === 'StravaLogo') return stravaLogo;
  return read(need(path.join(SRC, name + '.html')));
});
if (/<\?/.test(html)) { console.error('Masih ada scriptlet Apps Script yang belum diproses di Index.html'); process.exit(1); }
const cdn = {
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js': 'vendor/leaflet.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js': 'vendor/chart.umd.js',
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js': 'vendor/three.min.js'
};
for (const [url, local] of Object.entries(cdn)) html = html.split(`src="${url}"`).join(`src="${local}"`);
html = html.replace('href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"', 'href="vendor/leaflet.css"');
html = html.replace(/window\.AC_BUILD='[^']*'/, `window.AC_BUILD='app-${pkg.version}'`);
html = html.replace('<base target="_top">', '');
html = html.replace(/\n\s*var t=document\.createElement\('div'\);t\.textContent='Active Coach [\s\S]*?t\.remove\(\)\},7000\)/, '');
html = html.replace('</defs>', '<symbol id="i-mail" viewBox="0 0 24 24"><rect x="3.5" y="5.5" width="17" height="13" rx="2.6"/><path d="M4.5 7.5 12 13l7.5-5.5"/></symbol></defs>');
html = html.replace('</body>', '  <script src="config.js"></script>\n  <script src="bridge.js"></script>\n</body>');
write(path.join(OUT, 'index.html'), html);

// ---------- engine ----------
write(path.join(OUT, 'engine/code.js'), code);
for (const f of ['gas-shim.js', 'worker.js', 'app-engine.js']) copy(path.join(APP, 'engine', f), path.join(OUT, 'engine', f));
copy(path.join(APP, 'bridge.js'), path.join(OUT, 'bridge.js'));

// ---------- konfigurasi server (opsional, bisa juga diisi dari layar login aplikasi) ----------
const conf = { supabaseUrl: process.env.SUPABASE_URL || '', supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '' };
const confFile = path.join(ROOT, 'app', 'config.local.json');
if (fs.existsSync(confFile)) Object.assign(conf, JSON.parse(read(confFile)));
write(path.join(OUT, 'config.js'), 'window.ACX_CONFIG = ' + JSON.stringify(conf, null, 2) + ';\n');

// ---------- vendor ----------
copy(need(path.join(NM, 'leaflet/dist/leaflet.js')), path.join(OUT, 'vendor/leaflet.js'));
copy(need(path.join(NM, 'leaflet/dist/leaflet.css')), path.join(OUT, 'vendor/leaflet.css'));
for (const img of fs.readdirSync(path.join(NM, 'leaflet/dist/images'))) copy(path.join(NM, 'leaflet/dist/images', img), path.join(OUT, 'vendor/images', img));
copy(need(path.join(NM, 'chart.js/dist/chart.umd.js')), path.join(OUT, 'vendor/chart.umd.js'));
copy(need(path.join(NM, 'three/build/three.min.js')), path.join(OUT, 'vendor/three.min.js'));
copy(need(path.join(NM, 'html2pdf.js/dist/html2pdf.bundle.min.js')), path.join(OUT, 'vendor/html2pdf.bundle.min.js'));

const size = f => (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0) + ' KB';
console.log('www/ siap:', 'index.html', size('index.html'), '· engine/code.js', size('engine/code.js'), '· server', conf.supabaseUrl || '(diisi di aplikasi)');
