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

// 1b) Izin memasang update APK dari dalam aplikasi
manifest = fs.readFileSync(manifestPath, 'utf8');
if (!manifest.includes('REQUEST_INSTALL_PACKAGES')) {
  manifest = manifest.replace(/<application/, '<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />\n    <application');
  fs.writeFileSync(manifestPath, manifest);
  console.log('Izin REQUEST_INSTALL_PACKAGES ditambahkan');
}

// 2) Versi aplikasi (versionCode dari nomor build CI bila ada)
const gradlePath = path.join(ROOT, 'android/app/build.gradle');
let gradle = fs.readFileSync(gradlePath, 'utf8');
const code = Number(process.env.VERSION_CODE || process.env.GITHUB_RUN_NUMBER || 1);
const versionName = (process.env.VERSION_CODE || process.env.GITHUB_RUN_NUMBER) ? pkg.version.split('.').slice(0, 2).join('.') + '.' + code : pkg.version;
gradle = gradle.replace(/versionCode\s+\d+/, 'versionCode ' + code).replace(/versionName\s+"[^"]*"/, 'versionName "' + versionName + '"');
console.log('Versi aplikasi: ' + versionName + ' (kode ' + code + ')');
// Tanda tangan rilis: dipakai bila kunci rilis tersedia (GitHub Secrets → RELEASE_KEYSTORE_PATH dst.)
if (process.env.RELEASE_KEYSTORE_PATH && !gradle.includes('signingConfigs {')) {
  gradle = gradle.replace(/android \{/, `android {
    signingConfigs {
        release {
            storeFile file(System.getenv("RELEASE_KEYSTORE_PATH"))
            storePassword System.getenv("RELEASE_KEYSTORE_PASSWORD")
            keyAlias System.getenv("RELEASE_KEY_ALIAS")
            keyPassword System.getenv("RELEASE_KEY_PASSWORD")
        }
    }
    lint {
        checkReleaseBuilds false
        abortOnError false
    }`);
  gradle = gradle.replace(/buildTypes \{\s*release \{/, 'buildTypes {\n        release {\n            signingConfig signingConfigs.release');
  console.log('Tanda tangan rilis aktif');
}
fs.writeFileSync(gradlePath, gradle);

// 3) Ikon & splash dari folder assets/
if (fs.existsSync(path.join(ROOT, 'assets', 'icon-only.png'))) {
  try { run('npx @capacitor/assets generate --android --iconBackgroundColor "#12121a" --iconBackgroundColorDark "#12121a" --splashBackgroundColor "#f4f4f7" --splashBackgroundColorDark "#0b0b0f"'); }
  catch (e) { console.warn('Ikon gagal dibuat (lanjut dengan ikon bawaan):', e.message); }
}

// Ikon kecil notifikasi (monokrom, dipakai LocalNotifications)
const drawDir = path.join(ROOT, 'android/app/src/main/res/drawable');
fs.mkdirSync(drawDir, { recursive: true });
fs.writeFileSync(path.join(drawDir, 'ic_stat_ac.xml'), `<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">
  <path android:fillColor="#00000000" android:strokeColor="#FFFFFFFF" android:strokeWidth="2.4" android:strokeLineCap="round" android:strokeLineJoin="round" android:pathData="M2.5,13.5h4l2.5,-6l4,11l2.5,-5h6"/>
</vector>
`);

run('npx cap sync android');
console.log('Proyek Android siap. Build: cd android && ./gradlew assembleDebug');
