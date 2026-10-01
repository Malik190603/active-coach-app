# Privacy Policy — Active Coach

_Last updated: 1 October 2026_ · [Bahasa Indonesia di bawah](#kebijakan-privasi--active-coach)

Active Coach is a personal training-analysis app for Android. It is an independent project and is **not affiliated with, endorsed by, or sponsored by Strava**. Activity data is **Powered by Strava**.

## What we access
When you choose **Connect with Strava**, you authorize Active Coach with the scopes `read`, `activity:read_all` and `profile:read_all`. With this we read:
- your Strava profile (name, profile photo, athlete ID, bikes/shoes);
- your activities, including summary stats, GPS route, and streams (heart rate, power, cadence, altitude, speed), and laps.

We also store data you enter yourself in the app (training plans, notes, garage/maintenance records, photos you add).

## How we use it
Your data is used **only to show you your own training analysis**: readiness, training load, plans, records, maps, maintenance reminders, and share cards you create yourself.
- Your data is **never shown to other users**, never sold, never used for advertising.
- Your data is **not used to train any AI or machine-learning model**.
- Active Coach never posts, edits, or deletes anything on your Strava account (read-only access).
- Share images are created on your phone and only leave the device when you tap **Share**.

## Anonymous usage statistics
To find bugs and improve the app, Active Coach sends a small **daily usage summary**: app version, platform, how many times the app was opened, which screens/features were used (counts only), and error messages. It contains **no activity data, no location, no name**. Feature and error statistics are shown to the developer only as totals across all users (for example "35 users opened Studio this week"). You can turn this off anytime in Profile → *Bantu kembangkan aplikasi*.

## Automatic error reports
When the app hits a code error, it may send a short report to the developer's inbox: the error message, app version, phone model & Android version, the screen you were on, and a few lines of technical trace. It contains **no activity data, routes or location**, is linked to your account so the developer can follow up, is limited to 3 reports per day, and is turned off together with *Bantu kembangkan aplikasi* in Profile.

## On your phone
Your login session is stored encrypted with the Android Keystore. App data is excluded from Android cloud backup and device-to-device transfer; on a new phone you simply sign in with Strava again and your data is restored from the server.

## App updates
Updates are downloaded directly from this project's GitHub Releases (the APK or a small web package installed inside the app). No third-party update service or analytics is used.

## What the app owner can see
To run the service (support, update reminders, maintenance notices), the app owner has an admin list of registered accounts showing only: Strava display name and profile photo, Strava athlete ID, join date, last sign-in, the last day the app was opened and its version, how many times it was opened in the last 30 days, whether phone notifications are enabled, and the **number** of stored activities. The owner does **not** see your email, tokens, routes, or the content of your activities through this list, and it is never shown to other users. The owner can send a notification to a specific account (for example a reminder to update). Announcements and the event calendar are read-only lists published by the developer.

## Where it is stored
- Your data is stored in a private workspace in our Supabase database (cloud Postgres). Row-Level Security ensures each account can only read its own data. A cached copy is kept on your phone so the app works offline.
- Strava access/refresh tokens are stored in your private workspace. The Strava client secret and database service key exist only on the server and are never shipped in the app.

## Third-party services
- **Strava** – source of your activity data.
- **Supabase** – authentication, database and server functions.
- **Open-Meteo** – weather for your activities (the activity's approximate location and time are sent to fetch weather).
- **CARTO / Esri** – map tiles (the map area you view is requested from these tile servers).
- **Google Firebase Cloud Messaging** – delivers announcement notifications (maintenance, new versions) to your phone. Only an anonymous device token is stored; no activity data is sent to Firebase. You can turn notifications off in Android settings.

## Retention and deletion
- **Disconnect Strava** (Profile → Strava): revokes Active Coach's access via Strava's deauthorization endpoint and deletes the stored tokens. Synchronisation stops immediately.
- **Delete account & data** (Profile → Hapus akun & data): permanently deletes your account and all stored data from the server, deletes the cached copy on the phone, and revokes Strava access.
- If you revoke access from strava.com (Settings → My Apps), Active Coach can no longer read any new data.

## Contact
Questions or deletion requests: open an issue at <https://github.com/Malik190603/active-coach-app/issues> or contact Instagram [@muh.malikkk](https://instagram.com/muh.malikkk).

---

# Kebijakan Privasi — Active Coach

Active Coach adalah aplikasi analisis latihan pribadi untuk Android. Proyek independen dan **tidak berafiliasi dengan Strava**. Data aktivitas **Powered by Strava**.

**Yang diakses:** saat kamu memilih *Connect with Strava*, aplikasi mendapat izin baca (`read`, `activity:read_all`, `profile:read_all`) untuk profil dan aktivitasmu (ringkasan, rute GPS, detak jantung, power, cadence, elevasi, lap). Data yang kamu isi sendiri (plan, catatan, garasi, foto) juga disimpan.

**Penggunaan:** hanya untuk menampilkan analisis latihanmu sendiri. Data **tidak pernah ditampilkan ke pengguna lain**, tidak dijual, tidak untuk iklan, dan **tidak dipakai melatih AI**. Aplikasi tidak pernah memposting atau mengubah apa pun di Strava. Kartu story dibuat di HP dan hanya keluar dari HP saat kamu menekan *Bagikan*.

**Statistik pemakaian anonim:** untuk menemukan bug dan memperbaiki aplikasi, dikirim ringkasan harian kecil: versi aplikasi, platform, berapa kali aplikasi dibuka, fitur yang dipakai (hanya jumlah), dan pesan error. **Tanpa data aktivitas, tanpa lokasi, tanpa nama.** Statistik fitur & error hanya dilihat pengembang sebagai angka gabungan semua pengguna. Bisa dimatikan kapan saja di Profil → *Bantu kembangkan aplikasi*.

**Laporan error otomatis:** bila terjadi error pada kode aplikasi, laporan singkat bisa dikirim ke kotak masuk pengembang: pesan error, versi aplikasi, model HP & versi Android, halaman yang sedang dibuka, dan beberapa baris jejak teknis. **Tanpa data aktivitas, rute, atau lokasi**, terkait akunmu agar bisa ditindaklanjuti, maks. 3 laporan per hari, dan ikut mati bila *Bantu kembangkan aplikasi* dimatikan.

**Di HP-mu:** sesi login disimpan terenkripsi dengan Android Keystore. Data aplikasi tidak ikut cadangan cloud Android maupun pemindahan ke HP lain — di HP baru cukup masuk lagi dengan Strava dan datamu dipulihkan dari server.

**Pembaruan aplikasi:** diunduh langsung dari GitHub Releases proyek ini (APK atau paket web kecil yang dipasang di dalam aplikasi), tanpa layanan update atau analitik pihak ketiga.

**Yang bisa dilihat pemilik aplikasi:** untuk menjalankan layanan (bantuan, pengingat update, kabar maintenance), pemilik aplikasi punya daftar akun terdaftar yang hanya berisi: nama & foto profil Strava, ID atlet Strava, tanggal bergabung, login terakhir, hari terakhir membuka aplikasi beserta versinya, berapa kali dibuka 30 hari terakhir, status notifikasi HP, dan **jumlah** aktivitas tersimpan. Pemilik **tidak** melihat email, token, rute, atau isi aktivitasmu lewat daftar ini, dan daftar ini tidak pernah ditampilkan ke pengguna lain. Pemilik bisa mengirim notifikasi ke akun tertentu (mis. pengingat update).

**Penyimpanan:** di workspace pribadi pada database Supabase dengan Row-Level Security (tiap akun hanya bisa membaca datanya sendiri), plus salinan cache di HP. Client secret Strava hanya ada di server.

**Layanan pihak ketiga:** Strava (sumber data), Supabase (akun & database), Open-Meteo (cuaca; lokasi & waktu perkiraan aktivitas dikirim), CARTO/Esri (tile peta), Google Firebase Cloud Messaging (notifikasi pengumuman ke HP; hanya token perangkat yang disimpan, tanpa data aktivitas).

**Penghapusan:** *Putuskan Strava* mencabut izin di Strava dan menghapus token. *Hapus akun & data* menghapus akun dan seluruh data secara permanen dari server dan HP, sekaligus mencabut izin Strava.

**Kontak:** <https://github.com/Malik190603/active-coach-app/issues> atau Instagram [@muh.malikkk](https://instagram.com/muh.malikkk).
