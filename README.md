# Active Coach — Aplikasi Android

Aplikasi Android (APK) untuk Active Coach. Masuk dengan Strava, data tersimpan di **Supabase** (database + server gratis).

```
HP Android (APK)                                Supabase (gratis)
┌───────────────────────────────┐   HTTPS     ┌─────────────────────────────────┐
│ Tampilan Active Coach         │ ──────────► │ Auth: Masuk dengan Strava       │
│ Engine (Code.gs asli, jalan   │             │ Database: tabel ac_chunks,      │
│ di HP) + cache offline        │ ◄────────── │   ac_meta, ac_files (per akun)  │
└───────────────────────────────┘             │ Edge Function "proxy" ─► Strava,│
                                              │   Open-Meteo (secret aman)      │
                                              │ Edge Function "strava-callback" │
                                              └─────────────────────────────────┘
```

- **Mesin analisis berjalan di HP.** `src/Code.gs` dijalankan di HP oleh lapisan kompatibilitas (`app/engine/gas-shim.js`). Jadi sinkron Strava, plan, garasi, analisis Pro, dan laporan PDF hasilnya sama persis.
- **Cepat dan tetap jalan offline.** Data disimpan juga di memori HP, jadi aplikasi langsung terbuka. Perubahan dikirim ke Supabase otomatis, hanya bagian yang berubah.
- **Masuk dengan Strava.** Tidak ada email/sandi. Akun dibuat otomatis dari akun Strava, lalu aktivitas langsung diimpor.
- **Aman.** `STRAVA_CLIENT_SECRET` dan service key hanya ada di server Supabase, tidak pernah ada di HP. Setiap akun hanya bisa membaca datanya sendiri (Row Level Security).

---

## Langkah 1 — Siapkan Supabase (±10 menit, sekali saja)

1. Daftar di <https://supabase.com>, lalu **New project** (paket gratis cukup). Catat password database.
2. **Buat tabel:** buka **SQL Editor** → *New query* → tempel seluruh isi `supabase/migrations/20260930000000_active_coach.sql` → **Run**. Lalu ulangi dengan `supabase/migrations/20261001000000_strava_login.sql` (tabel serah-terima login Strava).
3. **Pengaturan Auth:** buka **Authentication → Sign In / Providers**.
   - Provider **Email** harus tetap **menyala** (dipakai di balik layar untuk membuat sesi login Strava; tidak ada email yang dikirim).
   - **Allow new users to sign up** boleh dimatikan supaya orang tidak bisa daftar lewat email. Login Strava tetap bisa membuat akun baru.
4. **Buat 2 Edge Function:** buka **Edge Functions → Deploy a new function → Via Editor**.
   - Nama `proxy` → tempel isi `supabase/functions/proxy/index.ts` → *Deploy*.
   - Nama `strava-callback` → tempel isi `supabase/functions/strava-callback/index.ts` → *Deploy*.
   - Di halaman **Details/Settings** masing-masing fungsi, **matikan "Verify JWT" / "Enforce JWT verification"**. Pengecekan keamanan sudah dilakukan di dalam fungsi.
   - **Sudah pernah deploy versi lama?** Buka fungsi `strava-callback` → *Code* → ganti seluruh isinya dengan versi terbaru → *Deploy*. Tanpa ini tombol **Masuk dengan Strava** tidak akan berfungsi.
   - Kalau kamu memakai Supabase CLI, cukup jalankan `supabase functions deploy proxy strava-callback`. Pengaturan JWT sudah diatur di `supabase/config.toml`.
5. **Isi secret Strava:** buka **Edge Functions → Secrets**, lalu tambahkan:
   - `STRAVA_CLIENT_ID` = Client ID dari <https://www.strava.com/settings/api>
   - `STRAVA_CLIENT_SECRET` = Client Secret dari halaman yang sama
6. **Ubah callback di Strava:** buka <https://www.strava.com/settings/api>, lalu ganti **Authorization Callback Domain** menjadi domain project Supabase-mu, misalnya `abcdxyz.supabase.co` (tanpa `https://`).
   > **Kuota atlet:** aplikasi Strava baru hanya mengizinkan **1 atlet** (kamu sendiri). Supaya teman bisa ikut masuk, ajukan kenaikan kuota di halaman API Strava (*Request athlete capacity*). Sampai disetujui, orang lain akan melihat pesan "batas jumlah atlet".
7. Catat **Project URL** dan **anon / publishable key** di **Project Settings → API**. Keduanya dipakai di langkah 2 atau saat pertama kali membuka aplikasi.

## Langkah 2 — Buat APK (tanpa install apa pun di komputer)

APK dibangun otomatis oleh GitHub Actions (gratis).

1. Buat akun di <https://github.com>, lalu **New repository** (boleh *Private*), misalnya `active-coach-app`.
2. Unggah **seluruh isi folder ini** ke repository: di halaman repo, pilih **Add file → Upload files**, seret semua file dan folder termasuk `.github`, lalu **Commit**.
   > Kalau folder `.github` tidak ikut terunggah (tersembunyi), buat manual lewat **Add file → Create new file** dengan nama `.github/workflows/android.yml`, lalu tempel isinya.
3. *(Opsional tapi praktis)* Isi alamat server supaya tertanam di APK: buka **Settings → Secrets and variables → Actions → tab Variables**, lalu tambahkan `SUPABASE_URL` dan `SUPABASE_ANON_KEY`. Kalau dilewati, alamat server diisi sekali di layar masuk aplikasi (tombol **Atur server**).
4. Buka tab **Actions**. Workflow **Build APK Android** berjalan otomatis (±8–12 menit). Kalau tidak jalan, pilih workflow itu lalu klik **Run workflow**.
5. Setelah selesai, buka **Releases** di halaman repo (dari HP juga bisa). Unduh `ActiveCoach-v1.1.x.apk`, lalu pasang. Android akan meminta izin *"Instal aplikasi tidak dikenal"*; izinkan untuk browser atau file manager-mu.

Setiap kali kamu mengubah file di repo, APK baru dibuat otomatis. Versi baru bisa langsung dipasang menimpa versi lama tanpa uninstall, karena tanda tangannya selalu sama (`signing/debug.keystore`).

**Alternatif lewat Android Studio:** `npm install` → `npm run build` → `npm run android:prepare` → `npm run android:open` → tombol ▶ Run.

## Pemakaian sehari-hari

- **Masuk:** ketuk **Masuk dengan Strava** → izinkan di Strava → otomatis kembali ke aplikasi, akun dibuat dan aktivitas diimpor. Sesi disimpan, jadi aplikasi langsung terbuka berikutnya. Akun yang sama bisa dipakai di beberapa HP.
- **Pindah dari akun email lama:** setelah update, layar masuk menampilkan pemberitahuan. Cukup masuk dengan Strava; data dari akun email lama di HP itu dipindahkan otomatis.
- **Sinkron:** otomatis dan senyap saat aplikasi dibuka atau kembali aktif (maks. tiap 20 menit). Bisa juga tarik layar ke bawah, atau ketuk ikon sinkron → *Sinkronkan sekarang*.
- **Peta:** tombol lapis untuk gaya peta (Standar, Satelit, Topo, Terang, Gelap), tombol layar penuh, dan pusatkan rute. Kalau satu server peta gagal, aplikasi otomatis pindah ke server cadangan.
- **Studio:** Berbagi → Studio. 28 template (stiker transparan, minimalis, angka raksasa, rute neon, struk, poster finisher, split per KM, profil elevasi, kartu kaca, Now Playing, notifikasi, rekap minggu, sampul majalah, polaroid, data lengkap, peta rute, boarding pass, terminal, medali, bento grid, wrapped, kontur topo, papan skor, chat coach, widget HP, detak jantung, retro 80-an, cap paspor). Latar transparan/foto/warna/peta sungguhan, warna aksen otomatis dari foto, pilihan data, privasi rute, ukuran Story/Feed/Kotak, caption + hashtag otomatis. Tombol **Simpan gambar** menyimpan ke Galeri, **Bagikan** membuka menu Android.
- **Putuskan Strava / Hapus akun:** *Putuskan Strava* mencabut izin di Strava dan menghapus token. **Profil → Hapus akun & data** menghapus akun dan seluruh data secara permanen (butuh `strava-callback` versi terbaru). Kebijakan privasi ada di `PRIVACY.md`.
- **Notifikasi:** Profil → Notifikasi. Pengingat latihan harian sesuai plan (jam bisa dipilih), rekap mingguan (Minggu 19:00), dan pengingat servis sepeda.
- **Impor file:** Profil → Impor aktivitas (GPX/TCX/FIT) untuk aktivitas dari Garmin, Coros, Wahoo, dll. yang tidak ada di Strava.
- **Video animasi:** di Studio, tombol *Buat video animasi (5 dtk)* — rute tergambar & angka berjalan, hasil MP4 untuk Reels/Story.
- **Laporan PDF dan kartu Wrapped:** tombol unduh akan membuka menu *Simpan / Bagikan* Android.

## Kritik & saran

Masukan dari menu **Saran & kritik** masuk ke tabel `ac_feedback` (jalankan `supabase/migrations/20261001120000_feedback.sql` sekali). Akun Strava pertama yang masuk (pemilik aplikasi) otomatis menjadi admin dan melihat **Profil → Kotak masuk masukan**: daftar masukan semua pengguna, badge jumlah yang baru, tombol Balas / Selesai / Hapus. Pengirim melihat status dan balasanmu di menu Saran & kritik miliknya. Masukan lama ikut dipindahkan oleh SQL tersebut.

## Catatan rilis: pengguna vs developer

Pesan commit menjadi catatan rilis. Pisahkan dengan baris `Untuk pengguna:` dan `Untuk developer:`. Layar update & "Yang baru" hanya menampilkan bagian pengguna; bagian developer hanya terlihat oleh admin (bisa dibuka di bagian *Catatan developer*).

## Pembaruan wajib

Setiap build baru di GitHub terbit di **Releases** dengan catatan dari pesan commit. Saat dibuka atau kembali aktif, aplikasi (mulai v1.1.15) memeriksa rilis terbaru. Kalau ada versi lebih baru, aplikasi **terkunci** di layar *Pembaruan wajib* sampai versi terbaru dipasang: APK diunduh di dalam aplikasi (dengan progres), lalu penginstal Android terbuka — pasang menimpa, data tetap ada. Pertama kali, Android meminta izin *Instal aplikasi tidak dikenal* untuk Active Coach. Jika offline, kunci tetap berlaku bila versi baru sudah pernah terdeteksi.

## Panel admin (khusus pemilik aplikasi)

Jalankan SQL `supabase/migrations/20261001180000_admin_suite.sql` sekali di Supabase › SQL Editor. Setelah itu di **Profil › Panel admin** (hanya muncul untuk akun admin):
- **Dasbor** — jumlah pengguna, aktif harian/mingguan/bulanan, versi aplikasi yang dipakai, fitur paling sering dibuka, error terbanyak, dan jumlah masukan. Semua angka anonim & gabungan.
- **Pengumuman** — kirim pesan ke semua pengguna (Info, Pembaruan, Event, atau Penting = pop-up), dengan masa tampil. Ada **template cepat**: Maintenance terjadwal (isi tanggal & jam, otomatis hilang 1 jam setelah selesai), Gangguan sementara, Maintenance selesai, Update APK baru (judul & isi diambil otomatis dari rilis GitHub + tombol *Perbarui sekarang*, tersembunyi bagi yang sudah update), Fitur baru, dan Event baru — lengkap dengan pratinjau tampilan di HP pengguna.
- **Event** — kelola Kalender event (lari, sepeda, trail, triathlon, renang). Pengguna melihatnya di Profil › Kalender event dan bisa menjadikannya target latihan (hitung mundur di Hari Ini + pengingat H-7 & H-1).
- **Masukan** — kotak masuk kritik & saran.

**Menu developer** (Profil › Menu developer, khusus admin): info sistem & perangkat, cek kesehatan server (Supabase, fungsi, tabel, token Strava, webhook), status sinkron & antrean, log 200 baris terakhir (salin/bagikan/kirim ke kotak masuk), uji notifikasi & layar, saklar lokal (jeda sinkron, overlay FPS, banner error), hapus cache, dan info rilis + sidik jari APK.

**Karya tahunan** (Rekap › Tahunan): Poster A3 semua rute (PNG/PDF), video "setahun dalam 30 detik", dan kalender dinding PDF 13 halaman. Ada juga kartu **Kenangan** ("setahun lalu hari ini") dan **template musiman** otomatis (17 Agustus, Ramadan, Lebaran, Natal, Tahun Baru).

Fitur lain di versi ini: **Rekap bulanan & tahunan** otomatis (kartu di Hari Ini tiap awal bulan + template Studio "Rekap Bulanan") dan **tutorial singkat** per fitur (bisa diulang dari Profil).

## Notifikasi HP (Firebase) — sekali setup

Supaya pengumuman (maintenance, versi baru, dll.) masuk ke bilah notifikasi HP pengguna walau aplikasi tertutup:

1. **Firebase:** buka <https://console.firebase.google.com> → *Add project* (nama bebas, Google Analytics boleh dimatikan).
2. **Aplikasi Android:** di proyek itu → ikon Android → *Package name* `com.activecoach.app` → *Register app* → unduh **google-services.json**.
3. **GitHub:** repo → *Settings › Secrets and variables › Actions › New repository secret* → nama `GOOGLE_SERVICES_JSON`, isi = seluruh isi file google-services.json.
4. **Kunci server:** Firebase → ⚙️ *Project settings › Service accounts › Generate new private key* → file JSON terunduh. Di Supabase → *Edge Functions › Secrets* → tambah `FCM_SERVICE_ACCOUNT`, isi = seluruh isi file JSON itu. (Jangan pernah taruh file ini di repo.)
5. **SQL:** jalankan `supabase/migrations/20261001200000_push.sql` di SQL Editor.
6. **Fungsi:** perbarui kode `strava-callback` (Edge Functions › strava-callback › Code) dengan versi terbaru, lalu *Deploy*.
7. **Build ulang:** GitHub → *Actions › Build APK Android › Run workflow* (atau commit apa saja). APK baru otomatis memakai Firebase.

Cek semuanya di aplikasi: **Profil › Menu developer › Server** (bagian *Notifikasi HP*) dan **Uji › Kirim ke HP ini**. Setelah itu, setiap pengumuman dari Panel admin punya pilihan **Kirim juga ke notifikasi HP** (aktif bawaan), dan riwayat pengumuman punya tombol **🔔 Kirim notif** untuk mengirim ulang.

## Tanda tangan APK

Semua APK sejak v1.1.18 ditandatangani dengan kunci yang sama (`signing/debug.keystore`). Kunci ini ditulis langsung di `android/app/build.gradle` oleh `scripts/prepare-android.mjs`, dan workflow GitHub memeriksa sidik jari SHA-256 setiap APK (`350be897…c6d3`) — kalau berbeda, rilis dibatalkan. Jadi setiap versi baru selalu bisa dipasang **menimpa** versi lama tanpa uninstall. Jangan ganti atau hapus file kunci ini.

> Versi v1.1.17 dan sebelumnya tidak sengaja ditandatangani kunci acak per build. Pengguna versi tersebut perlu hapus aplikasi **satu kali** lalu memasang v1.1.18+; data latihan tetap aman di server (cukup login Strava lagi). Setelah itu update selalu menimpa.

## Webhook Strava (aktivitas baru langsung masuk)

Tidak perlu diatur manual: setelah login, aplikasi meminta fungsi `strava-callback` mendaftarkan webhook ke Strava (sekali). Setiap ada aktivitas baru, Strava memberi tahu server dan aplikasi langsung menyinkronkan saat dibuka/aktif (dicek tiap 90 detik selama aplikasi terbuka). Jika izin dicabut dari strava.com, aplikasi otomatis memutus Strava. Butuh `strava-callback` versi terbaru. Webhook lama dari versi web (Apps Script) diganti otomatis.

## Struktur proyek

| Folder / file | Isi |
|---|---|
| `src/` | Code.gs dan tampilan (Index.html, JS*.html, Stylesheet.html, StylePro.html). **Ubah tampilan atau fitur di sini.** `JSMap.html` = peta, `JSStudio*.html` = Studio & template. |
| `app/engine/` | `gas-shim.js` (lapisan kompatibilitas mesin), `worker.js` (penyimpanan dan sinkron), `app-engine.js` (fungsi khusus aplikasi) |
| `app/bridge.js` | Pengganti `google.script.run`, Masuk dengan Strava, deep link, sinkron otomatis, getaran, tombol kembali, simpan/bagikan file |
| `supabase/` | Skema database dan dua Edge Function |
| `scripts/` | `build-web.mjs` (menyusun `www/`) dan `prepare-android.mjs` (proyek Android, deep link, ikon) |
| `assets/` | Ikon dan splash aplikasi |
| `.github/workflows/android.yml` | Build APK otomatis |

## Masalah umum

- **"Server belum diatur"** — isi Project URL dan anon key lewat **Pengaturan server** di layar masuk, atau isi variabel GitHub di langkah 2.3.
- **Setelah izin Strava tidak kembali ke aplikasi / muncul "versi lama"** — deploy ulang `strava-callback` versi terbaru dengan Verify JWT mati, dan pastikan callback domain Strava sama persis dengan `xxxx.supabase.co`.
- **"Gagal menyimpan sesi sementara… Sudah jalankan SQL terbaru?"** — jalankan `20261001000000_strava_login.sql` (langkah 1.2).
- **"Gagal membuat sesi" / "Email logins are disabled"** — nyalakan lagi provider Email (langkah 1.3).
- **"Batas jumlah atlet"** — kuota aplikasi Strava-mu masih 1 atlet (lihat catatan di langkah 1.6).
- **"Server belum punya STRAVA_CLIENT_ID"** — isi secret di langkah 1.5, lalu buka ulang aplikasi.
- **Build GitHub gagal** — buka log langkah yang merah di tab Actions. Biasanya penyebabnya `package-lock.json` atau folder `.github` tidak ikut terunggah.
