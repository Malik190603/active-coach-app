# Active Coach — Aplikasi Android

Aplikasi Android (APK) untuk Active Coach. Tampilan dan semua fiturnya sama dengan versi web. Datanya disimpan di **Supabase** (database + server gratis), tidak lagi di Google Sheets.

```
HP Android (APK)                                Supabase (gratis)
┌───────────────────────────────┐   HTTPS     ┌─────────────────────────────────┐
│ Tampilan Active Coach         │ ──────────► │ Auth: akun email + sandi        │
│ Engine (Code.gs asli, jalan   │             │ Database: tabel ac_chunks,      │
│ di HP) + cache offline        │ ◄────────── │   ac_meta, ac_files (per akun)  │
└───────────────────────────────┘             │ Edge Function "proxy" ─► Strava,│
                                              │   Open-Meteo (secret aman)      │
                                              │ Edge Function "strava-callback" │
                                              └─────────────────────────────────┘
```

- **Code.gs tetap dipakai apa adanya.** Code.gs dijalankan di HP oleh lapisan tiruan Apps Script (`app/engine/gas-shim.js`). Jadi sinkron Strava, plan, garasi, analisis Pro, dan laporan PDF hasilnya sama persis.
- **Cepat dan tetap jalan offline.** Data disimpan juga di memori HP, jadi aplikasi langsung terbuka. Perubahan dikirim ke Supabase otomatis, hanya bagian yang berubah.
- **Aman.** `STRAVA_CLIENT_SECRET` hanya ada di server Supabase, tidak pernah ada di HP. Setiap akun hanya bisa membaca datanya sendiri (Row Level Security).

---

## Langkah 1 — Siapkan Supabase (±10 menit, sekali saja)

1. Daftar di <https://supabase.com>, lalu **New project** (paket gratis cukup). Catat password database.
2. **Buat tabel:** buka **SQL Editor** → *New query* → tempel seluruh isi `supabase/migrations/20260930000000_active_coach.sql` → **Run**.
3. **Login email tanpa konfirmasi (disarankan):** buka **Authentication → Sign In / Providers → Email**, lalu matikan **Confirm email**. Kalau tetap dinyalakan, setiap akun baru harus mengetuk tautan di email dulu sebelum bisa masuk.
4. **Buat 2 Edge Function:** buka **Edge Functions → Deploy a new function → Via Editor**.
   - Nama `proxy` → tempel isi `supabase/functions/proxy/index.ts` → *Deploy*.
   - Nama `strava-callback` → tempel isi `supabase/functions/strava-callback/index.ts` → *Deploy*.
   - Di halaman **Details/Settings** masing-masing fungsi, **matikan "Verify JWT" / "Enforce JWT verification"**. Pengecekan login sudah dilakukan di dalam fungsi `proxy`.
   - Kalau kamu memakai Supabase CLI, cukup jalankan `supabase functions deploy proxy strava-callback`. Pengaturan JWT sudah diatur di `supabase/config.toml`.
5. **Isi secret Strava:** buka **Edge Functions → Secrets**, lalu tambahkan:
   - `STRAVA_CLIENT_ID` = Client ID dari <https://www.strava.com/settings/api>
   - `STRAVA_CLIENT_SECRET` = Client Secret dari halaman yang sama
6. **Ubah callback di Strava:** buka <https://www.strava.com/settings/api>, lalu ganti **Authorization Callback Domain** menjadi domain project Supabase-mu, misalnya `abcdxyz.supabase.co` (tanpa `https://`).
   > Kalau versi web lama (Apps Script) masih mau dipakai, Strava hanya menerima satu callback domain per aplikasi. Buat aplikasi Strava kedua untuk HP kalau kedua versi mau dipakai bersamaan.
7. Catat **Project URL** dan **anon / publishable key** di **Project Settings → API**. Keduanya dipakai di langkah 2 atau saat pertama kali membuka aplikasi.

## Langkah 2 — Buat APK (tanpa install apa pun di komputer)

APK dibangun otomatis oleh GitHub Actions (gratis).

1. Buat akun di <https://github.com>, lalu **New repository** (boleh *Private*), misalnya `active-coach-app`.
2. Unggah **seluruh isi folder ini** ke repository: di halaman repo, pilih **Add file → Upload files**, seret semua file dan folder termasuk `.github`, lalu **Commit**.
   > Kalau folder `.github` tidak ikut terunggah (tersembunyi), buat manual lewat **Add file → Create new file** dengan nama `.github/workflows/android.yml`, lalu tempel isinya.
3. *(Opsional tapi praktis)* Isi alamat server supaya tertanam di APK: buka **Settings → Secrets and variables → Actions → tab Variables**, lalu tambahkan `SUPABASE_URL` dan `SUPABASE_ANON_KEY`. Kalau dilewati, alamat server diisi sekali di layar masuk aplikasi (tombol **Atur server**).
4. Buka tab **Actions**. Workflow **Build APK Android** berjalan otomatis (±8–12 menit). Kalau tidak jalan, pilih workflow itu lalu klik **Run workflow**.
5. Setelah selesai, buka **Releases** di halaman repo (dari HP juga bisa). Unduh `ActiveCoach-v1.0.x.apk`, lalu pasang. Android akan meminta izin *"Instal aplikasi tidak dikenal"*; izinkan untuk browser atau file manager-mu.

Setiap kali kamu mengubah file di repo, APK baru dibuat otomatis. Versi baru bisa langsung dipasang menimpa versi lama tanpa uninstall, karena tanda tangannya selalu sama (`signing/debug.keystore`).

**Alternatif lewat Android Studio:** `npm install` → `npm run build` → `npm run android:prepare` → `npm run android:open` → tombol ▶ Run.

## Langkah 3 — Pindahkan data dari Google Sheets

1. Di project Apps Script lama, tambahkan file script baru bernama **Migrasi**, lalu tempel isi `apps-script/Migrasi.gs`.
2. Pilih fungsi **eksporUntukAplikasi** → **Run** → izinkan akses. Di *Execution log* akan muncul tautan file `active-coach-export-....json` di Google Drive.
3. Unduh file itu ke HP.
4. Di aplikasi: **Daftar** akun (email + sandi), lalu buka **Profil → Impor dari Google Sheets** dan pilih file tadi.

Yang ikut pindah: semua aktivitas, plan, catatan, garasi dan servis, foto sepeda, hasil analisis Pro, pengaturan, dan **token Strava**. Karena token ikut pindah, Strava biasanya langsung tersambung tanpa login ulang. Kalau spreadsheet berisi lebih dari satu atlet, aplikasi akan menanyakan profil mana yang milikmu.

## Pemakaian sehari-hari

- **Masuk:** pakai email dan sandi. Sesi disimpan, jadi aplikasi langsung terbuka berikutnya. Satu akun bisa dipakai di beberapa HP, dan datanya ikut tersinkron.
- **Hubungkan Strava:** ketuk ikon sinkron → Hubungkan Strava → login di Strava → otomatis kembali ke aplikasi dan aktivitas diimpor.
- **Sinkron:** tarik layar ke bawah, atau ketuk ikon sinkron → *Sinkronkan sekarang*.
- **Cadangan:** buka **Profil → Cadangkan data** untuk menyimpan salinan lengkap (.json). File ini juga bisa diimpor kembali.
- **Laporan PDF, kartu Wrapped, dan Overlay:** tombol unduh akan membuka menu *Simpan / Bagikan* Android.

### Perbedaan dengan versi web

| Fitur | Versi web (Apps Script) | Aplikasi |
|---|---|---|
| Aktivitas baru dari Strava | Webhook real-time | Sinkron saat aplikasi dibuka, tarik ke bawah, atau tombol sinkron |
| Analisis otomatis tiap jam | Trigger Apps Script | Berjalan saat aplikasi dibuka (dan tiap 30 menit selama terbuka) |
| Login | Nama + PIN | Email + sandi (Supabase Auth) |
| Data | Google Sheets | Supabase (+ cache di HP, tetap bisa dibuka offline) |

## Struktur proyek

| Folder / file | Isi |
|---|---|
| `src/` | File Apps Script asli (Code.gs, Index.html, JS*.html, Stylesheet.html). **Ubah tampilan atau fitur di sini.** Salin `StravaLogo.html` ke sini kalau mau logo Strava asli. |
| `app/engine/` | `gas-shim.js` (tiruan Apps Script), `worker.js` (penyimpanan dan sinkron), `app-engine.js` (fungsi khusus aplikasi) |
| `app/bridge.js` | Pengganti `google.script.run`, login akun, deep link Strava, tombol kembali, simpan/bagikan file |
| `supabase/` | Skema database dan dua Edge Function |
| `apps-script/Migrasi.gs` | Ekspor data dari Google Sheets |
| `scripts/` | `build-web.mjs` (menyusun `www/`) dan `prepare-android.mjs` (proyek Android, deep link, ikon) |
| `assets/` | Ikon dan splash aplikasi |
| `.github/workflows/android.yml` | Build APK otomatis |

## Masalah umum

- **"Server belum diatur"** — isi Project URL dan anon key lewat **Atur server** di layar masuk, atau isi variabel GitHub di langkah 2.3.
- **"Email belum dikonfirmasi"** — ketuk tautan di email dari Supabase, atau matikan *Confirm email* (langkah 1.3).
- **Setelah login Strava tidak kembali ke aplikasi** — pastikan fungsi `strava-callback` sudah di-deploy dengan Verify JWT mati, dan callback domain Strava sama persis dengan `xxxx.supabase.co`.
- **"Server belum punya STRAVA_CLIENT_ID"** — isi secret di langkah 1.5, lalu buka ulang aplikasi.
- **Build GitHub gagal** — buka log langkah yang merah di tab Actions. Biasanya penyebabnya `package-lock.json` atau folder `.github` tidak ikut terunggah.
