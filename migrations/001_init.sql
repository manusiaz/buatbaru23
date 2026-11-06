-- Galeri Seleksi: skema awal (PostgreSQL 13+)

CREATE TABLE IF NOT EXISTS studios (
  id            BIGSERIAL PRIMARY KEY,
  nama          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  logo_path     TEXT,
  warna         TEXT NOT NULL DEFAULT '#005F73',
  no_wa         TEXT,
  zona_waktu    TEXT NOT NULL DEFAULT 'Asia/Jakarta',
  watermark     TEXT,
  retensi_hari  INTEGER NOT NULL DEFAULT 30,
  format_salin  TEXT NOT NULL DEFAULT 'lightroom',
  template_wa   TEXT,
  dibuat_pada   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  studio_id     BIGINT NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  nama          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  google_sub    TEXT UNIQUE,
  peran         TEXT NOT NULL CHECK (peran IN ('owner','admin','editor')),
  aktif         BOOLEAN NOT NULL DEFAULT true,
  dibuat_pada   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invites (
  id            BIGSERIAL PRIMARY KEY,
  studio_id     BIGINT NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  peran         TEXT NOT NULL CHECK (peran IN ('admin','editor')),
  token_hash    TEXT NOT NULL UNIQUE,
  dipakai_pada  TIMESTAMPTZ,
  kedaluwarsa   TIMESTAMPTZ NOT NULL,
  dibuat_pada   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash    TEXT PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent    TEXT,
  kedaluwarsa   TIMESTAMPTZ NOT NULL,
  dibuat_pada   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pakets (
  id                  BIGSERIAL PRIMARY KEY,
  studio_id           BIGINT NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  nama                TEXT NOT NULL,
  kuota               INTEGER NOT NULL CHECK (kuota > 0),
  durasi_pilih_menit  INTEGER NOT NULL DEFAULT 0 CHECK (durasi_pilih_menit >= 0),
  masa_aktif_jam      INTEGER NOT NULL DEFAULT 168 CHECK (masa_aktif_jam > 0),
  harga_foto_tambahan INTEGER NOT NULL DEFAULT 0 CHECK (harga_foto_tambahan >= 0),
  maks_foto_tambahan  INTEGER NOT NULL DEFAULT 0 CHECK (maks_foto_tambahan >= 0),
  arsip               BOOLEAN NOT NULL DEFAULT false,
  dibuat_pada         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pelanggans (
  id          BIGSERIAL PRIMARY KEY,
  studio_id   BIGINT NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  nama        TEXT NOT NULL,
  no_wa       TEXT,
  dibuat_pada TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sesis (
  id                  BIGSERIAL PRIMARY KEY,
  studio_id           BIGINT NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  pelanggan_id        BIGINT NOT NULL REFERENCES pelanggans(id) ON DELETE CASCADE,
  paket_id            BIGINT REFERENCES pakets(id) ON DELETE SET NULL,
  judul               TEXT NOT NULL,
  jenis               TEXT,
  tanggal_sesi        DATE,
  -- salinan nilai paket (F-04)
  kuota               INTEGER NOT NULL,
  durasi_pilih_menit  INTEGER NOT NULL DEFAULT 0,
  masa_aktif_jam      INTEGER NOT NULL,
  harga_foto_tambahan INTEGER NOT NULL DEFAULT 0,
  maks_foto_tambahan  INTEGER NOT NULL DEFAULT 0,
  tampil_nama_file    BOOLEAN NOT NULL DEFAULT true,
  izin_catatan        BOOLEAN NOT NULL DEFAULT true,
  -- sumber Drive
  sumber              TEXT NOT NULL CHECK (sumber IN ('service_account','link_publik','contoh')),
  drive_folder_id     TEXT,
  resource_key        TEXT,
  urutan              TEXT NOT NULL DEFAULT 'nama' CHECK (urutan IN ('nama','waktu')),
  sinkron_status      TEXT NOT NULL DEFAULT 'menunggu',
  sinkron_total       INTEGER NOT NULL DEFAULT 0,
  sinkron_selesai     INTEGER NOT NULL DEFAULT 0,
  sinkron_error       TEXT,
  sinkron_pada        TIMESTAMPTZ,
  -- akses pelanggan
  -- token link >=128 bit: hanya hash untuk lookup, salinan terenkripsi (AES-GCM) agar staf bisa menampilkan ulang
  token_hash          TEXT NOT NULL UNIQUE,
  token_enc           TEXT NOT NULL,
  pin_hash            TEXT NOT NULL,
  pin_enc             TEXT NOT NULL,
  -- waktu & status
  status              TEXT NOT NULL DEFAULT 'menyinkron',
  tenggat_link        TIMESTAMPTZ,
  link_dikirim_pada   TIMESTAMPTZ,
  dibuka_pada         TIMESTAMPTZ,
  jumlah_dibuka       INTEGER NOT NULL DEFAULT 0,
  mulai_pilih_pada    TIMESTAMPTZ,
  berakhir_pada       TIMESTAMPTZ,
  dikirim_pada        TIMESTAMPTZ,
  dikirim_otomatis    BOOLEAN NOT NULL DEFAULT false,
  minta_waktu_pada    TIMESTAMPTZ,
  catatan_umum        TEXT,
  editor_id           BIGINT REFERENCES users(id) ON DELETE SET NULL,
  editor_status       TEXT NOT NULL DEFAULT 'antre' CHECK (editor_status IN ('antre','dikerjakan','selesai')),
  dibuat_oleh         BIGINT REFERENCES users(id) ON DELETE SET NULL,
  dibuat_pada         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sesis_studio_idx ON sesis(studio_id, dibuat_pada DESC);
CREATE INDEX IF NOT EXISTS sesis_berakhir_idx ON sesis(status, berakhir_pada);

CREATE TABLE IF NOT EXISTS fotos (
  id              BIGSERIAL PRIMARY KEY,
  sesi_id         BIGINT NOT NULL REFERENCES sesis(id) ON DELETE CASCADE,
  drive_file_id   TEXT NOT NULL,
  nama_file       TEXT NOT NULL,
  path_subfolder  TEXT NOT NULL DEFAULT '',
  mime            TEXT,
  checksum        TEXT,
  ukuran          BIGINT,
  diambil_pada    TIMESTAMPTZ,
  nomor           INTEGER NOT NULL,
  nama_kembar     BOOLEAN NOT NULL DEFAULT false,
  resource_key    TEXT,
  thumb_siap      BOOLEAN NOT NULL DEFAULT false,
  preview_siap    BOOLEAN NOT NULL DEFAULT false,
  thumb_error     TEXT,
  dihapus         BOOLEAN NOT NULL DEFAULT false,
  dibuat_pada     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sesi_id, nomor),
  UNIQUE (sesi_id, drive_file_id)
);

CREATE TABLE IF NOT EXISTS pilihans (
  sesi_id      BIGINT NOT NULL REFERENCES sesis(id) ON DELETE CASCADE,
  foto_id      BIGINT NOT NULL REFERENCES fotos(id) ON DELETE CASCADE,
  catatan      TEXT,
  is_tambahan  BOOLEAN NOT NULL DEFAULT false,
  dipilih_pada TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sesi_id, foto_id)
);

CREATE TABLE IF NOT EXISTS tagihans (
  sesi_id      BIGINT PRIMARY KEY REFERENCES sesis(id) ON DELETE CASCADE,
  jumlah_foto  INTEGER NOT NULL DEFAULT 0,
  total_rupiah BIGINT NOT NULL DEFAULT 0,
  status_bayar TEXT NOT NULL DEFAULT 'belum_bayar' CHECK (status_bayar IN ('belum_bayar','lunas')),
  metode       TEXT,
  diubah_pada  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id        BIGSERIAL PRIMARY KEY,
  sesi_id   BIGINT NOT NULL REFERENCES sesis(id) ON DELETE CASCADE,
  jenis     TEXT NOT NULL,
  aktor     TEXT NOT NULL,
  detail    JSONB,
  waktu     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_sesi_idx ON events(sesi_id, waktu DESC);

CREATE TABLE IF NOT EXISTS notifikasis (
  id          BIGSERIAL PRIMARY KEY,
  studio_id   BIGINT NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  sesi_id     BIGINT REFERENCES sesis(id) ON DELETE CASCADE,
  jenis       TEXT NOT NULL,
  pesan       TEXT NOT NULL,
  dibaca      BOOLEAN NOT NULL DEFAULT false,
  dibuat_pada TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notif_studio_idx ON notifikasis(studio_id, dibuat_pada DESC);

CREATE TABLE IF NOT EXISTS pin_attempts (
  sesi_id      BIGINT NOT NULL REFERENCES sesis(id) ON DELETE CASCADE,
  ip           TEXT NOT NULL,
  gagal        INTEGER NOT NULL DEFAULT 0,
  kunci_sampai TIMESTAMPTZ,
  PRIMARY KEY (sesi_id, ip)
);

CREATE TABLE IF NOT EXISTS client_sessions (
  token_hash  TEXT PRIMARY KEY,
  sesi_id     BIGINT NOT NULL REFERENCES sesis(id) ON DELETE CASCADE,
  kedaluwarsa TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS system_state (
  kunci TEXT PRIMARY KEY,
  nilai TEXT NOT NULL,
  waktu TIMESTAMPTZ NOT NULL DEFAULT now()
);
