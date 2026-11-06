# Galeri Seleksi

Aplikasi web (SaaS) pilih foto online untuk studio foto, dibangun dari PRD "Aplikasi Pilih Foto Online untuk Studio Foto" dan desain *Galeri Seleksi*.

Alurnya begini. Studio menautkan folder Google Drive hasil sesi. Pelanggan lalu memilih foto sesuai kuota paket lewat link privat ber-PIN, dalam batas waktu tertentu. Setelah itu daftar nama file pilihan langsung sampai ke editor.

- **Backend:** Node.js 20+ dan Express 5, PostgreSQL 13+. Migrasi berjalan otomatis saat start.
- **Frontend:** HTML/CSS/JS biasa tanpa build step. Sisi pelanggan mobile-first, sisi studio desktop-first tapi tetap responsif.
- **Pratinjau:** WebP 400 px dan 1600 px ber-watermark, dibuat dengan `sharp` dan disimpan di disk (`DATA_DIR`). Pratinjau disajikan lewat URL bertanda tangan yang berlaku ≤ 60 menit.

## Deploy ke VPS (database sudah ada)

1. Buat database kosong di Postgres VPS kamu:
   ```sql
   CREATE DATABASE galeri;
   CREATE USER galeri WITH PASSWORD 'ganti-ini';
   GRANT ALL PRIVILEGES ON DATABASE galeri TO galeri;
   -- Postgres 15+: ALTER DATABASE galeri OWNER TO galeri;
   ```
2. Clone repo ini di VPS, lalu salin `.env.example` menjadi `.env` dan isi minimal:
   - `DATABASE_URL=postgres://galeri:ganti-ini@HOST:5432/galeri`
     Kalau Postgres jalan langsung di host dan aplikasinya di Docker, isi `HOST` dengan `host.docker.internal`. Pastikan Postgres juga menerima koneksi dari jaringan Docker (`listen_addresses` dan `pg_hba.conf`).
   - `BASE_URL=https://galeri.domainkamu.com`
   - `APP_SECRET=` hasil `openssl rand -base64 48`. **Jangan diganti setelah ada data**, karena link galeri dan PIN dienkripsi dengan kunci ini.
3. Jalankan salah satu:
   - **Docker:** `docker compose up -d --build`. Pratinjau disimpan di volume `galeri-data`.
   - **Tanpa Docker:** `npm ci --omit=dev && npm start` (pakai pm2/systemd agar tetap hidup).
   - **Coolify / Dokploy / Easypanel / CapRover:** sambungkan repo GitHub ini, pilih build dari `Dockerfile`, isi environment variable dari `.env.example`, lalu mount volume ke `/data`.
4. Pasang reverse proxy HTTPS (Nginx/Caddy/Traefik) ke port 3000 dan set `TRUST_PROXY=true`.
5. Buka `BASE_URL`, tekan **Coba gratis**, lalu daftar studio. Untuk mencoba alur tanpa Google, pilih sumber **Foto contoh** saat membuat galeri.

Cek kesehatan: `GET /healthz`. Tabel dibuat otomatis saat start (lihat `migrations/`).

## Menyambungkan Google Drive

Semua langkah di Google Cloud Console, dalam satu project:

1. Aktifkan **Google Drive API**, dan **Google Picker API** bila memakai tombol "Pilih dari Google Drive".
2. **Service account** (jalur utama, folder tetap privat): buat service account, buat key JSON, lalu isi `GOOGLE_SERVICE_ACCOUNT_JSON` (isi JSON-nya, boleh di-base64) atau `GOOGLE_SERVICE_ACCOUNT_FILE`. Email service account akan tampil di dasbor. Studio membagikan folder sesi ke email itu sebagai **Pelihat**.
3. **API key** → `GOOGLE_API_KEY`. Dipakai untuk folder "link publik" dan Google Picker. Batasi key ke Drive API dan Picker API, plus HTTP referrer domainmu.
4. **OAuth Client ID (Web application)** → `GOOGLE_CLIENT_ID`, dengan *Authorized JavaScript origins* = `BASE_URL`. Ini mengaktifkan "Masuk dengan Google" dan "Pilih dari Google Drive" (scope `drive.file`). Isi juga `GOOGLE_APP_ID` dengan *Project number*. Layar izin OAuth perlu diverifikasi Google sebelum dipakai publik (PRD: ajukan sejak minggu 2).

Tanpa variabel di atas, aplikasi tetap jalan dengan sumber **Foto contoh**. Pilihan Drive yang konfigurasinya belum diisi akan tampil nonaktif.

## Apa yang sudah ada (P0 · MVP)

| Area | Kebutuhan PRD |
| --- | --- |
| Studio, tim, paket | F-01 daftar/masuk email atau Google; branding (nama, logo, warna, WA, zona waktu, watermark, retensi). F-02 undang Admin/Editor lewat link. F-03/F-04 paket, dengan nilai yang disalin ke sesi dan bisa diubah per sesi. |
| Sesi & Drive | F-06 buat sesi. F-51 Google Picker lalu folder otomatis dibagikan ke service account. F-07 cek akses beserta langkah perbaikan. F-08 sinkron dengan progres "x dari y". F-09 sinkron ulang (file baru, terhapus, ganti nama, isi berubah). F-10 nama kembar ditandai dan subfolder ditampilkan. |
| Akses pelanggan | F-13 link 128-bit dan PIN 4–6 digit (hash, plus salinan terenkripsi untuk staf). F-14 tombol "Kirim via WhatsApp" dengan template. F-15 PIN terkunci 15 menit setelah 5 kali salah. |
| Galeri | F-18 grid lazy-load, layar penuh dengan geser dan zoom. F-47 nomor tetap (#001…). F-19 ketuk ikon sudut untuk pilih, penghitung dan timer selalu terlihat. F-48 layar penuh dengan Pilih dan Salin link. F-20 setiap ketukan tersimpan di server. F-21 filter. F-22 catatan per foto dan catatan umum. F-23 watermark tanpa tombol unduh. F-24 ringkasan. F-49 Salin semua pilihan, lalu Kirim membuka WhatsApp studio. F-25 terkunci setelah kirim. |
| Timer | F-27 tenggat link. F-28 hitung mundur dari "Mulai pilih" (jam server). F-29 peringatan 5 dan 1 menit (banner dan getar). F-30 kirim otomatis saat habis, dengan masa tenggang 10 detik. F-31 minta tambah waktu. F-32 perpanjang, buka ulang, dan reset, semuanya tercatat di log. Gangguan sistem memperpanjang timer otomatis. |
| Foto tambahan | F-33 melebihi kuota bila paket mengizinkan, total biaya berjalan. F-34 status bayar Belum bayar/Lunas. |
| Dasbor & editor | F-37 daftar sesi, status, filter, pencarian. F-38 detail dengan log aktivitas. F-39 salin nama file (nomor, per baris, koma, Lightroom, Windows, dengan atau tanpa ekstensi) serta unduh CSV/TXT dengan path subfolder. F-40 notifikasi in-app, dan email bila `SMTP_URL` diisi. Metrik PRD (waktu sampai pilihan masuk, % tepat waktu, % minta perpanjangan, attach rate) tampil di dasbor. |
| Non-fungsional | RBAC ditegakkan di server, rate limit, cookie HttpOnly/SameSite, mutasi hanya JSON, ID/link Drive tidak pernah sampai ke browser pelanggan, retensi pratinjau otomatis (default 30 hari) dan log 12 bulan, hapus galeri beserta data pelanggan (UU PDP), halaman `/privasi`. |

Bonus V1 yang ikut dikerjakan karena murah: F-41 (tugaskan editor dengan status Antre/Dikerjakan/Selesai) dan F-50 (tempel teks chat untuk mencocokkan nomor/link).

**Belum dikerjakan:** P1/P2 lainnya, yaitu WhatsApp Business API, QR, mode kiosk, bandingkan dua foto, payment gateway, salin ke folder "Terpilih" di Drive, laporan lengkap, langganan/billing, multi-cabang, dan super admin. Harga di landing page diambil dari tabel hipotesis PRD.

## Pengembangan

```bash
npm install
cp .env.example .env    # isi DATABASE_URL lokal
npm run dev             # http://localhost:3000
```

Tes integrasi butuh PostgreSQL dengan database khusus tes. Tes **menghapus skema** database itu dan menolak jalan kalau nama database tidak mengandung "test".

```bash
TEST_DATABASE_URL=postgres://app:app@localhost:5432/pilihfoto_test npm test
```

CI GitHub Actions (`.github/workflows/ci.yml`) menjalankan tes di Postgres 16 dan build Docker image.

## Struktur

```
src/            server (Express): routes/studio.js (API studio), routes/client.js (API galeri pelanggan),
                sesi.js (aturan timer & status), sync.js (sinkron Drive), drive.js (Drive REST),
                images.js + media.js (pratinjau ber-watermark & URL bertanda tangan), retensi.js
public/         index.html (landing), masuk.html, app.html (dasbor studio), galeri.html (pelanggan)
public/shared/format.js   format teks salin/CSV, dipakai server & browser
migrations/     SQL skema
test/           tes integrasi (node:test)
```
