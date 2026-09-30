// Menyiapkan proyek Android (Capacitor): tambah platform, deep link Strava, ikon, versi, lalu sinkronkan www/.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd) => { console.log('> ' + cmd); execSync(cmd, { cwd: ROOT, stdio: 'inherit' }); };
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

if (!fs.existsSync(path.join(ROOT, 'www', 'index.html'))) run('node scripts/build-web.mjs');
if (!fs.existsSync(path.join(ROOT, 'android'))) run('npx cap add android');

// 1) Deep link activecoach://strava (kembali dari login Strava ke aplikasi)
const manifestPath = path.join(ROOT, 'android/app/src/main/AndroidManifest.xml');
let manifest = fs.readFileSync(manifestPath, 'utf8');
if (!manifest.includes('android:scheme="activecoach"')) {
  const filter = `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="activecoach" />
            </intent-filter>
`;
  const act = manifest.indexOf('android:name=".MainActivity"');
  const close = manifest.indexOf('</activity>', act);
  if (act < 0 || close < 0) throw new Error('MainActivity tidak ditemukan di AndroidManifest.xml');
  manifest = manifest.slice(0, close) + filter + '        ' + manifest.slice(close);
  fs.writeFileSync(manifestPath, manifest);
  console.log('Deep link activecoach:// ditambahkan');
}

// 2) Versi aplikasi (versionCode dari nomor build CI bila ada)
const gradlePath = path.join(ROOT, 'android/app/build.gradle');
let gradle = fs.readFileSync(gradlePath, 'utf8');
const code = Number(process.env.VERSION_CODE || process.env.GITHUB_RUN_NUMBER || 1);
gradle = gradle.replace(/versionCode\s+\d+/, 'versionCode ' + code).replace(/versionName\s+"[^"]*"/, 'versionName "' + pkg.version + '"');
fs.writeFileSync(gradlePath, gradle);

// 3) Ikon & splash dari folder assets/
if (fs.existsSync(path.join(ROOT, 'assets', 'icon-only.png'))) {
  try { run('npx @capacitor/assets generate --android --iconBackgroundColor "#12121a" --iconBackgroundColorDark "#12121a" --splashBackgroundColor "#f4f4f7" --splashBackgroundColorDark "#0b0b0f"'); }
  catch (e) { console.warn('Ikon gagal dibuat (lanjut dengan ikon bawaan):', e.message); }
}

run('npx cap sync android');
console.log('Proyek Android siap. Build: cd android && ./gradlew assembleDebug');
