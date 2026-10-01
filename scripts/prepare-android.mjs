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

// 1c) Privasi & sistem: tanpa cadangan otomatis (token login tidak ikut ke Google Drive / HP lain),
//     gestur kembali prediktif Android 14+
manifest = fs.readFileSync(manifestPath, 'utf8');
if (!manifest.includes('ac_data_extraction')) {
  manifest = manifest.replace(/android:allowBackup="true"/, 'android:allowBackup="false"');
  manifest = manifest.replace(/<application/, '<application\n        android:fullBackupContent="false"\n        android:dataExtractionRules="@xml/ac_data_extraction"\n        android:enableOnBackInvokedCallback="true"');
  fs.writeFileSync(manifestPath, manifest);
  console.log('Cadangan otomatis dimatikan, gestur kembali prediktif aktif');
}
const xmlDir = path.join(ROOT, 'android/app/src/main/res/xml');
fs.mkdirSync(xmlDir, { recursive: true });
fs.writeFileSync(path.join(xmlDir, 'ac_data_extraction.xml'), `<?xml version="1.0" encoding="utf-8"?>
<!-- Data login & cache tidak ikut dicadangkan ke cloud maupun dipindah ke HP lain; cukup masuk lagi dengan Strava. -->
<data-extraction-rules>
    <cloud-backup>
        <exclude domain="root" path="." />
        <exclude domain="file" path="." />
        <exclude domain="database" path="." />
        <exclude domain="sharedpref" path="." />
        <exclude domain="external" path="." />
    </cloud-backup>
    <device-transfer>
        <exclude domain="root" path="." />
        <exclude domain="file" path="." />
        <exclude domain="database" path="." />
        <exclude domain="sharedpref" path="." />
        <exclude domain="external" path="." />
    </device-transfer>
</data-extraction-rules>
`);

// 1d) Ukuran huruf mengikuti pengaturan HP (aksesibilitas), dibatasi 85–125% agar tata letak tetap rapi
const javaDir = path.join(ROOT, 'android/app/src/main/java', ...pkgId().split('.'));
function pkgId() { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'capacitor.config.json'), 'utf8')).appId; } catch { return 'com.activecoach.app'; } }
const mainJava = path.join(javaDir, 'MainActivity.java');
if (fs.existsSync(mainJava)) {
  fs.writeFileSync(mainJava, `package ${pkgId()};

import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onResume() {
        super.onResume();
        applySystemTextSize();
    }

    /* Ikuti ukuran huruf di Pengaturan Android (aksesibilitas), dibatasi 85–125%. */
    private void applySystemTextSize() {
        try {
            if (bridge == null) return;
            WebView web = bridge.getWebView();
            if (web == null) return;
            float scale = getResources().getConfiguration().fontScale;
            int zoom = Math.round(Math.max(0.85f, Math.min(1.25f, scale)) * 100);
            web.getSettings().setTextZoom(zoom);
        } catch (Exception ignored) {
            // biarkan ukuran bawaan
        }
    }
}
`);
  console.log('MainActivity: ukuran huruf mengikuti pengaturan HP');
} else console.warn('MainActivity.java tidak ditemukan di ' + javaDir);

// 2) Versi aplikasi (versionCode dari nomor build CI bila ada)
const gradlePath = path.join(ROOT, 'android/app/build.gradle');
let gradle = fs.readFileSync(gradlePath, 'utf8');
const code = Number(process.env.VERSION_CODE || process.env.GITHUB_RUN_NUMBER || 1);
const versionName = process.env.APP_VERSION || ((process.env.VERSION_CODE || process.env.GITHUB_RUN_NUMBER) ? pkg.version.split('.').slice(0, 2).join('.') + '.' + code : pkg.version);
gradle = gradle.replace(/versionCode\s+\d+/, 'versionCode ' + code).replace(/versionName\s+"[^"]*"/, 'versionName "' + versionName + '"');
console.log('Versi aplikasi: ' + versionName + ' (kode ' + code + ')');
// Tanda tangan TETAP: semua APK (debug) ditandatangani kunci signing/debug.keystore di repo,
// ditulis eksplisit di build.gradle (tidak bergantung ~/.android yang bisa berbeda di runner CI).
// Kunci yang sama = update selalu bisa dipasang menimpa versi lama tanpa uninstall.
const keystore = path.join(ROOT, 'signing', 'debug.keystore');
if (!fs.existsSync(keystore)) throw new Error('signing/debug.keystore tidak ditemukan — jangan hapus file kunci ini');
if (!gradle.includes('/* ac-fixed-signing */')) {
  gradle = gradle.replace(/android \{/, `android {
    /* ac-fixed-signing */
    signingConfigs {
        debug {
            storeFile file(${JSON.stringify(keystore.split(path.sep).join('/'))})
            storePassword "android"
            keyAlias "androiddebugkey"
            keyPassword "android"
        }
    }`);
  gradle = gradle.replace(/buildTypes \{/, 'buildTypes {\n        debug {\n            signingConfig signingConfigs.debug\n        }');
  console.log('Tanda tangan tetap: ' + keystore);
}
// Build RILIS (bukan debug): tidak bisa di-debug lewat USB, WebView tidak bisa diintip, tetap memakai kunci
// yang SAMA supaya pengguna update menimpa tanpa uninstall. Lint dijalankan tapi tidak memblokir rilis.
if (!process.env.RELEASE_KEYSTORE_PATH && !gradle.includes('/* ac-release-same-key */')) {
  gradle = gradle.replace(/buildTypes \{([\s\S]*?)release \{/, (m, mid) => 'buildTypes {' + mid + 'release {\n            /* ac-release-same-key */\n            signingConfig signingConfigs.debug\n            debuggable false');
  gradle = gradle.replace(/android \{/, 'android {\n    lint {\n        checkReleaseBuilds false\n        abortOnError false\n    }');
  if (!gradle.includes('/* ac-release-same-key */')) throw new Error('buildTypes.release tidak ditemukan di build.gradle');
  console.log('Build rilis memakai kunci tetap yang sama');
}
// Tanda tangan rilis: dipakai bila kunci rilis tersedia (GitHub Secrets → RELEASE_KEYSTORE_PATH dst.)
if (process.env.RELEASE_KEYSTORE_PATH && !gradle.includes("signingConfig signingConfigs.release")) {
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
  try { run('npx @capacitor/assets generate --android --iconBackgroundColor "#12121a" --iconBackgroundColorDark "#12121a" --splashBackgroundColor "#0e0e14" --splashBackgroundColorDark "#0e0e14"'); }
  catch (e) { console.warn('Ikon gagal dibuat (lanjut dengan ikon bawaan):', e.message); }
}

// Ikon tema Android 13+ (monokrom): garis denyut yang sama dengan ikon notifikasi
const anyDpi = path.join(ROOT, 'android/app/src/main/res/mipmap-anydpi-v26');
fs.mkdirSync(path.join(ROOT, 'android/app/src/main/res/drawable'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'android/app/src/main/res/drawable/ic_launcher_mono.xml'), `<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">
  <path android:fillColor="#00000000" android:strokeColor="#FFFFFFFF" android:strokeWidth="5.5" android:strokeLineCap="round" android:strokeLineJoin="round" android:pathData="M31,57h9l5.5,-13l9,24l5.5,-11h17"/>
</vector>
`);
for (const f of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
  const fp = path.join(anyDpi, f); if (!fs.existsSync(fp)) continue;
  let x = fs.readFileSync(fp, 'utf8');
  if (!x.includes('<monochrome')) { x = x.replace('</adaptive-icon>', '    <monochrome android:drawable="@drawable/ic_launcher_mono"/>\n</adaptive-icon>'); fs.writeFileSync(fp, x); }
}
console.log('Ikon tema (monokrom) ditambahkan');

// Firebase (notifikasi HP): google-services.json dari GitHub Secret GOOGLE_SERVICES_JSON atau file firebase/google-services.json
const gsDest = path.join(ROOT, 'android/app/google-services.json');
const gsEnv = (process.env.GOOGLE_SERVICES_JSON || '').trim(), gsFile = path.join(ROOT, 'firebase', 'google-services.json');
if (gsEnv) { JSON.parse(gsEnv); fs.writeFileSync(gsDest, gsEnv); console.log('Firebase aktif (dari secret GOOGLE_SERVICES_JSON)'); }
else if (fs.existsSync(gsFile)) { fs.copyFileSync(gsFile, gsDest); console.log('Firebase aktif (firebase/google-services.json)'); }
else { if (fs.existsSync(gsDest)) fs.unlinkSync(gsDest); console.log('Firebase belum diatur — notifikasi server dinonaktifkan'); }
manifest = fs.readFileSync(manifestPath, 'utf8');
if (!manifest.includes('default_notification_icon')) {
  manifest = manifest.replace(/<application([^>]*)>/, `<application$1>
        <meta-data android:name="com.google.firebase.messaging.default_notification_icon" android:resource="@drawable/ic_stat_ac" />
        <meta-data android:name="com.google.firebase.messaging.default_notification_color" android:resource="@color/ac_notif" />
        <meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="announcements" />`);
  fs.writeFileSync(manifestPath, manifest);
}

// Layar pembuka: latar gelap seragam (Android 12+ splash sistem & versi lama) agar menyambung mulus ke animasi logo
const valDir = path.join(ROOT, 'android/app/src/main/res/values');
fs.writeFileSync(path.join(valDir, 'ac_splash.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ac_splash_bg">#0E0E14</color>
    <color name="ac_notif">#FC4C02</color>
</resources>
`);
const stylesPath = path.join(valDir, 'styles.xml');
let styles = fs.readFileSync(stylesPath, 'utf8');
styles = styles.replace(/<style name="AppTheme\.NoActionBarLaunch"[\s\S]*?<\/style>/, `<style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">
        <item name="android:background">@drawable/splash</item>
        <item name="windowSplashScreenBackground">@color/ac_splash_bg</item>
        <item name="windowSplashScreenAnimatedIcon">@mipmap/ic_launcher</item>
        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>
        <item name="android:windowBackground">@color/ac_splash_bg</item>
    </style>`);
fs.writeFileSync(stylesPath, styles);
console.log('Layar pembuka gelap diterapkan');

// Ikon kecil notifikasi (monokrom, dipakai LocalNotifications)
const drawDir = path.join(ROOT, 'android/app/src/main/res/drawable');
fs.mkdirSync(drawDir, { recursive: true });
fs.writeFileSync(path.join(drawDir, 'ic_stat_ac.xml'), `<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">
  <path android:fillColor="#00000000" android:strokeColor="#FFFFFFFF" android:strokeWidth="2.4" android:strokeLineCap="round" android:strokeLineJoin="round" android:pathData="M2.5,13.5h4l2.5,-6l4,11l2.5,-5h6"/>
</vector>
`);

run('npx cap sync android');
console.log('Proyek Android siap. Build: cd android && ./gradlew assembleRelease');
