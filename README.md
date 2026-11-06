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
4. Pasang reverse proxy HTTPS (Nginx/Caddy/Traefik) ke `127.0.0.1:3000` dan set `TRUST_PROXY=1` (jumlah proxy). **Jangan** `TRUST_PROXY=true` dan jangan buka port 3000 ke internet; compose sudah mengikat port ke `127.0.0.1`.
   Contoh Nginx: `proxy_pass http://127.0.0.1:3000; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; proxy_set_header Host $host; client_max_body_size 8m;`
5. Buka `BASE_URL`, tekan **Coba gratis**, lalu daftar studio. Untuk mencoba alur tanpa Google, pilih sumber **Foto contoh** saat membuat galeri.

Cek kesehatan: `GET /healthz`. Tabel dibuat otomatis saat start (lihat `migrations/`).

## Menyambungkan Google Drive

Semua langkah di Google Cloud Console, dalam satu project:

1. Aktifkan **Google Drive API**, dan **Google Picker API** bila memakai tombol "Pilih dari Google Drive".
2. **Service account** (jalur utama, folder tetap privat): buat service account, buat key JSON, lalu isi `GOOGLE_SERVICE_ACCOUNT_JSON` (isi JSON-nya, boleh di-base64) atau `GOOGLE_SERVICE_ACCOUNT_FILE`. Email service account akan tampil di dasbor. Studio membagikan folder sesi ke email itu sebagai **Pelihat**.
3. **API key** → `GOOGLE_API_KEY`. Dipakai untuk folder "link publik" dan Google Picker. Batasi key ke Drive API dan Picker API, plus HTTP referrer domainmu.
4. **OAuth Client ID (Web application)** → `GOOGLE_CLIENT_ID`, dengan *Authorized JavaScript origins* = `BASE_URL`. **Wajib untuk produksi**: ini satu-satunya cara login studio. Juga mengaktifkan "Pilih dari Google Drive" (scope `drive.file`). Isi juga `GOOGLE_APP_ID` dengan *Project number*. Layar izin OAuth perlu diverifikasi Google sebelum dipakai publik (PRD: ajukan sejak minggu 2).

Tanpa variabel di atas, aplikasi tetap jalan dengan sumber **Foto contoh**. Pilihan Drive yang konfigurasinya belum diisi akan tampil nonaktif.

## Fitur (semua P0, P1, P2 di PRD)

**MVP (P0)**

| Area | Kebutuhan PRD |
| --- | --- |
| Studio, tim, paket | F-01 daftar/masuk email atau Google; branding. F-02 undang Admin/Editor. F-03/F-04 paket, nilainya disalin ke sesi dan bisa diubah per sesi. |
| Sesi & Drive | F-06, F-51 Google Picker + bagikan otomatis ke service account, F-07 cek akses + langkah perbaikan, F-08 sinkron dengan progres, F-09 sinkron ulang, F-10 nama kembar. |
| Akses pelanggan | F-13 link 128-bit + PIN, F-14 tombol WhatsApp, F-15 PIN terkunci 15 menit setelah 5 kali salah. |
| Galeri | F-18 grid + layar penuh, F-47 nomor tetap, F-19/F-48 pilih & salin link, F-20 simpan per ketukan, F-21 filter, F-22 catatan, F-23 watermark, F-24 ringkasan, F-49 salin semua + WhatsApp, F-25 terkunci setelah kirim. |
| Timer | F-27 tenggat, F-28 hitung mundur (jam server), F-29 peringatan 5 & 1 menit, F-30 kirim otomatis, F-31 minta tambah waktu, F-32 perpanjang/buka ulang/reset + log. Gangguan sistem memperpanjang timer otomatis. |
| Foto tambahan | F-33 melebihi kuota dengan total berjalan, F-34 status bayar. |
| Dasbor & editor | F-37, F-38, F-39 salin nama file (Lightroom/Windows/baris/koma) + CSV/TXT dengan path, F-40 notifikasi in-app + email. |

**V1 (P1)**

| ID | Fitur | Di mana |
| --- | --- | --- |
| F-11 | Subfolder jadi tab di galeri | Galeri pelanggan |
| F-16 | Link terkirim otomatis lewat WhatsApp Business Cloud API (saat sesi dibuat, tombol "Kirim otomatis", CSV massal, hasil akhir) | Pengaturan › WhatsApp, detail sesi |
| F-17 | QR code sesi (lihat, unduh SVG, cetak) | Detail sesi › QR |
| F-26 / PL7 | Bandingkan dua foto berdampingan (atas-bawah di HP), bisa pilih langsung | Galeri pelanggan › Bandingkan |
| F-35 | Bayar foto tambahan online via Midtrans (QRIS, VA, e-wallet); webhook menandai Lunas otomatis | Halaman terkirim pelanggan, detail sesi › Link bayar online |
| F-41 | Tugaskan editor, status Antre/Dikerjakan/Selesai | Detail sesi, Pilihan masuk |
| F-42 | Salin file terpilih ke subfolder "Terpilih" di Drive | Detail sesi (butuh service account sebagai **Editor** folder) |
| F-43 | Link hasil akhir: simpan, kirim via WhatsApp, tampil di galeri pelanggan | Detail sesi › Hasil akhir |
| F-44 / S9 | Laporan: sesi, waktu sampai pilihan masuk, % tepat waktu, % minta perpanjangan, pendapatan foto tambahan, per hari/cabang/paket + CSV | Laporan |
| F-45 / S10 | Mode kiosk: daftar sesi hari ini, buka tanpa PIN, timer mulai otomatis, selesai kembali ke kiosk | Mode kiosk |
| F-46 | Langganan Gratis/Starter/Pro/Bisnis (batas sesi & pengguna, gating fitur) dibayar dari **saldo**. Saldo di-top up lewat **QRIS statis** + kode unik, dikonfirmasi manual oleh super admin. Perpanjang otomatis dari saldo, buku besar mutasi saldo | Langganan (aktif bila `BILLING_ENABLED=true`), Super admin |
| F-50 | Tempel teks chat, nomor & link dikenali | Pilihan masuk |

**V2 (P2)**

| ID | Fitur | Di mana |
| --- | --- | --- |
| F-05 | Multi-cabang: kelola cabang, sesi per cabang, user bisa dibatasi ke satu cabang, filter & laporan per cabang | Pengaturan › Cabang, Tim, Galeri, Laporan |
| F-12 | Buat sesi massal dari CSV (nama, no_wa, link_folder, paket, judul, tanggal, pin), salin semua link+PIN, kirim WA per baris | Galeri › Buat massal (CSV) |
| F-36 | Harga bertingkat foto tambahan (mis. `5=100000`); sistem memilih total termurah | Paket & harga, buat/ubah sesi |

**Super admin** (ditandai lewat CLI: `node scripts/superadmin.js tambah email@kamu.com`, bukan lewat env): ringkasan platform, unggah QRIS statis, setujui/tolak top up (lihat bukti transfer), koreksi saldo dengan alasan, daftar tenant, ubah paket/masa berlaku, tangguhkan studio, log audit.

**Pengaman saldo:** saldo hanya bertambah lewat persetujuan super admin; persetujuan & pembayaran berjalan dalam transaksi database dengan row lock (persetujuan ganda / pemakaian saldo ganda secara paralel diuji); constraint `saldo >= 0`; buku besar `saldo_mutasi` tidak bisa di-UPDATE/DELETE (trigger); nominal top up hanya dari daftar tetap; bukti transfer di-encode ulang dan hanya bisa dilihat studio pemiliknya & super admin; semua aksi super admin masuk audit.

Keamanan & non-fungsional: RBAC ditegakkan di server, rate limit, cookie HttpOnly/SameSite, mutasi hanya JSON, ID/link Drive tidak pernah sampai ke browser pelanggan, webhook diverifikasi signature SHA-512, token WA studio dienkripsi, retensi pratinjau otomatis dan log 12 bulan, hapus galeri beserta data pelanggan (UU PDP), halaman `/privasi`.

### Integrasi yang butuh kredensial

Semua fitur di atas jalan tanpa kredensial pihak ketiga **kecuali** yang memang memanggil layanan luar. Yang ini sudah ditulis lengkap tapi **belum pernah dites ke layanan aslinya**, jadi uji dulu dengan akun sandbox:

- **Google Drive** (service account, link publik, Picker, salin ke "Terpilih").
- **Midtrans** (hanya untuk pelanggan membayar foto tambahan ke studio): pakai sandbox dulu (`MIDTRANS_PRODUCTION=false`), set Payment Notification URL ke `{BASE_URL}/api/webhooks/midtrans`.
- **WhatsApp Cloud API**: pesan pembuka ke pelanggan wajib memakai template yang disetujui Meta (`WA_TEMPLATE_LINK`, `WA_TEMPLATE_HASIL`). Tanpa template, pesan dikirim sebagai teks biasa dan hanya sampai bila pelanggan pernah chat ke nomor itu dalam 24 jam terakhir.

Tanpa kredensial, tombolnya disembunyikan atau memberi pesan jelas, dan alur manual (wa.me, bayar di kasir) tetap jalan.

## Keamanan

Audit keamanan independen dijalankan (exploit dicoba langsung). Semua temuan sudah diperbaiki dan punya tes regresi (`test/app.test.js`, bagian "Regresi audit keamanan"):

| Temuan | Perbaikan |
| --- | --- |
| Kritis: siapa pun bisa jadi super admin dengan mendaftar email yang ada di `SUPERADMIN_EMAILS` | Super admin = flag `users.superadmin` yang hanya bisa diset lewat CLI di server |
| Tinggi: kunci PIN & rate limit bisa dilewati dengan memalsukan `X-Forwarded-For` (`TRUST_PROXY=true`) | `TRUST_PROXY` = jumlah hop (`1`); nilai `true` diturunkan jadi 1; port Docker hanya `127.0.0.1` |
| Tinggi: satu orang bisa mengunci input PIN semua pelanggan (semua request terlihat dari IP proxy) | Limiter PIN per galeri + IP; batas tambahan 30 gagal/jam per galeri (lintas IP) yang mengunci galeri itu saja dan memberi tahu studio |
| Menengah-tinggi: bayar dengan link lama yang nominalnya lebih kecil tetap dianggap lunas | Link bayar dibatalkan saat total berubah; webhook mewajibkan nominal ≥ total terkini |
| Menengah: studio lain bisa membaca folder Drive lewat service account bersama | Folder terikat ke studio pertama yang menautkannya; escape query Drive diperbaiki |
| Menengah: nomor WA platform bisa dipakai spam oleh studio baru | Hanya studio yang diizinkan super admin; `ALLOW_REGISTRATION=false` untuk instalasi satu studio |
| Menengah: file Drive raksasa bisa menghabiskan memori | Batas unduhan 25 MB (thumbnail) / 60 MB (asli) + batas piksel `sharp` |
| Menengah: injeksi formula di ekspor CSV | Sel diawali `= + - @` diberi prefiks `'` |
| Rendah: login Google menempel ke akun berkata sandi milik email yang sama | Tidak ditautkan otomatis |
| Rendah: race percobaan PIN paralel | Jatah percobaan dipesan atomik sebelum PIN dicek |
| Rendah: top up kedaluwarsa / kode unik dipakai ulang | Top up kedaluwarsa tidak bisa disetujui; jumlah transfer tidak dipakai ulang 7 hari; batas antrean global |
| Rendah: staf cabang/editor melihat data di luar cakupannya | Dasbor, notifikasi, dan akses galeri difilter per cabang/penugasan; daftar tim hanya admin/owner |
| Rendah: PIN di-hash SHA-256 polos; `APP_SECRET` punya nilai bawaan; tanpa CSP | PIN di-hash scrypt bersalt; app menolak start tanpa `APP_SECRET` ≥ 32 karakter; CSP + HSTS aktif |

Yang dinyatakan bersih oleh audit: SQL injection, XSS, IDOR antar studio lewat API, CSRF, path traversal, tanda tangan URL media, SSRF.

### Masa coba gratis (per studio)

Berlaku bila `BILLING_ENABLED=true`. Setiap studio dapat **coba gratis 3 hari** (`GRATIS_HARI`) sejak studio itu mendaftar.
- Setelah habis: tidak bisa membuat galeri baru (termasuk CSV massal) atau mengundang anggota. Galeri yang sudah dikirim tetap bisa dibuka pelanggan sampai tenggatnya. Banner hitung mundur tampil di semua halaman dasbor.
- **Traktir kopi ☕ Rp 5.000 = +3 hari paket Gratis** (`GRATIS_PERPANJANG_HARGA`, `GRATIS_PERPANJANG_HARI`). Khusus paket Gratis, terpisah dari paket berbayar (Starter/Pro/Bisnis), bukan langganan dan tidak terpotong otomatis. Dibayar dari saldo; bisa diulang dan bertumpuk; bila saldo kurang, studio langsung ditawari top up Rp 5.000 via QRIS.
- Atau pilih paket berbayar (dibayar dari saldo). Paket berbayar yang habis kembali ke kondisi coba-habis.
- Super admin bisa mengatur tanggal akhir masa coba per studio (Ubah studio › Berlaku sampai).

### Suspend / tangguhkan

- **Studio** (super admin › Ubah › matikan "Studio aktif"): staf ter-logout & tidak bisa login, otomasi berhenti, dan **semua galeri pelanggannya offline** (pelanggan melihat "Galeri tidak tersedia" + tombol hubungi studio). Data tetap utuh; aktifkan lagi untuk memulihkan.
- **Galeri** (detail sesi › Ubah pengaturan sesi › Tangguhkan galeri) atau **pelanggan** (Tangguhkan pelanggan = semua galerinya): PIN, galeri, pilih/kirim, bayar, dan gambar pratinjau publik ditolak; pengingat otomatis berhenti; alasan hanya terlihat tim; pilihan, catatan, dan tagihan tetap tersimpan. Tim tetap bisa melihat galeri di dasbor. Filter "Ditangguhkan" di daftar galeri. Pulihkan kapan saja; cookie pelanggan lama berlaku lagi. Semua tercatat di log keamanan.

### Otomasi follow-up & alert

Menu **Otomasi & follow-up** (owner/admin). Mesin otomasi berjalan tiap 5 menit di server.

| Ke pelanggan | Bawaan |
| --- | --- |
| Link sudah dikirim tapi galeri belum dibuka | setelah 24 jam |
| Tenggat memilih sudah dekat, belum kirim pilihan | 24 jam & 3 jam sebelum tenggat |
| Galeri kedaluwarsa tanpa pilihan (pelanggan + tim) | sekali |
| Foto tambahan belum dibayar (dengan link bayar online bila aktif) | 24 jam setelah terkirim |
| Kirim hasil edit otomatis saat link hasil disimpan | mati (opsional) |

| Alert ke tim studio | Bawaan |
| --- | --- |
| Pilihan masuk belum selesai dikerjakan (ke owner/admin + editor yang ditugaskan) | 48 jam |
| Pelanggan minta tambah waktu tapi belum direspons | 10 menit |
| Galeri siap tapi link belum dikirim | 3 jam |
| Sinkron Drive gagal · Kuota sesi bulanan hampir habis (80%) | sekali |
| Ringkasan mingguan | Senin pagi |

- **Kanal:** ke pelanggan lewat WhatsApp Cloud API bila aktif (template `WA_TEMPLATE_PENGINGAT` dengan {{1}} nama, {{2}} isi pesan; tanpa template dikirim sebagai teks). Bila API tidak ada/gagal, pesan masuk **antrean klik-kirim** (wa.me dengan pesan siap kirim, otomatis ditandai terkirim). Ke tim: notifikasi aplikasi + email (bila SMTP) + opsional WhatsApp studio.
- **Anti-spam:** tiap aturan hanya sekali per sesi/tahap, jam tenang (bawaan 21.00–08.00 waktu studio), maks 2 pesan per pelanggan per 24 jam, pelanggan bisa menekan "Jangan ingatkan saya lagi" di galeri, staf bisa mematikan pengingat per sesi.
- Semua aturan bisa dinyalakan/dimatikan, diatur waktunya, dan teks pesannya bisa diubah per studio. Aman untuk banyak instance (advisory lock PostgreSQL).

### Integrasi & kunci API (satu halaman)

Menu **Integrasi & kunci API** (khusus super admin) mengatur semua kredensial dari satu tempat: Google (Client ID, API key, service account, App ID), Midtrans, WhatsApp Cloud API, SMTP, dan kontak keamanan. Nilai di halaman ini mengalahkan `.env`; `.env` tetap jadi cadangan. Perubahan langsung berlaku tanpa restart, dan semua instance memuat ulang tiap menit.

Pengaman:
- **Sudo mode**: halaman terkunci sampai super admin mengonfirmasi identitas lagi (login Google dengan akun yang sama; kata sandi bila mode sandi). Akses berlaku 10 menit per sesi login, lalu terkunci otomatis; bisa dikunci manual.
- **Rahasia terenkripsi** AES-256-GCM di database (kunci turunan `APP_SECRET`, terpisah dari enkripsi lain) dan **tidak pernah dikirim ke browser**: hanya 4 karakter terakhir, sumber (database/env), siapa & kapan mengubah.
- **Validasi format** tiap kunci sebelum disimpan, plus **Tes koneksi** dari server (Google, Midtrans, WhatsApp, SMTP).
- **Client ID Google baru wajib dibuktikan** dengan login Google memakai Client ID itu oleh akun super admin yang sama, jadi Client ID salah tidak bisa membuat semua orang terkunci.
- **Audit**: setiap konfirmasi identitas (berhasil/gagal), perubahan, penghapusan, dan tes tercatat dengan nama kunci & IP; nilai tidak pernah dicatat.
- **Batasi IP admin** (opsional, hanya lewat `.env` agar tidak bisa mengunci diri sendiri): `ADMIN_IP_ALLOWLIST=203.0.113.5,10.0.0.0/8`.
- **Pemulihan darurat** di server: `node scripts/integrasi.js daftar` / `node scripts/integrasi.js hapus google_client_id`.

Catatan: karena rahasia dienkripsi dengan `APP_SECRET`, mengganti `APP_SECRET` membuat nilai yang tersimpan tidak terbaca (harus diisi ulang).

### Login & akun

- **Login studio hanya lewat Google** (bila `GOOGLE_CLIENT_ID` diisi). Aplikasi tidak menyimpan kata sandi; verifikasi email, verifikasi 2 langkah, dan pemulihan akun diurus Google. Token Google dicek: penerbit, `aud` = client ID-mu, email terverifikasi, belum kedaluwarsa.
- **Undangan tim** hanya bisa diterima dengan akun Google yang emailnya sama dengan email yang diundang.
- Login email+kata sandi hanya aktif bila `ALLOW_PASSWORD_LOGIN=true` atau `GOOGLE_CLIENT_ID` kosong (lokal/tes).
- **Log keamanan studio** (Pengaturan › Log keamanan, khusus owner): masuk/gagal/keluar dengan IP & perangkat, undang/ubah anggota, ubah pengaturan/logo/token WA, ganti PIN/link, ekspor, hapus galeri.
- **Ganti link galeri** (detail sesi): link lama, sesi pelanggan, dan URL pratinjau lama langsung mati. Ganti PIN juga mematikan URL pratinjau lama.
- Batas ukuran request 256 KB (5 MB khusus unggahan gambar & CSV), `/.well-known/security.txt`, CSP, HSTS.
- CI menjalankan `npm audit` dan Dependabot memantau dependensi.

## Pengembangan

```bash
npm install
cp .env.example .env    # isi DATABASE_URL lokal
npm run dev             # http://localhost:3000 (NODE_ENV=development)
```

Tes integrasi (48 kasus) butuh PostgreSQL dengan database khusus tes. Tes **menghapus skema** database itu dan menolak jalan kalau nama database tidak mengandung "test".

```bash
TEST_DATABASE_URL=postgres://app:app@localhost:5432/pilihfoto_test npm test
```

CI GitHub Actions (`.github/workflows/ci.yml`) menjalankan tes di Postgres 16 dan build Docker image.

## Struktur

```
src/            server (Express): routes/studio.js (API studio), routes/client.js (API galeri pelanggan),
                sesi.js (aturan timer & status), sync.js (sinkron Drive), drive.js (Drive REST),
                images.js + media.js (pratinjau ber-watermark & URL bertanda tangan), retensi.js,
                plans.js (langganan), wa.js (WhatsApp Cloud API), payment.js + routes/webhooks.js (Midtrans)
public/         index.html (landing), masuk.html, app.html (dasbor studio), galeri.html (pelanggan)
public/shared/format.js   format teks salin/CSV, dipakai server & browser
migrations/     SQL skema
test/           tes integrasi (node:test)
```
