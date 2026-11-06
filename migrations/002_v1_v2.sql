-- V1/V2: cabang, langganan, WhatsApp API, pembayaran online, harga bertingkat, hasil akhir, Drive "Terpilih", super admin

CREATE TABLE IF NOT EXISTS cabangs (
  id          BIGSERIAL PRIMARY KEY,
  studio_id   BIGINT NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  nama        TEXT NOT NULL,
  alamat      TEXT,
  no_wa       TEXT,
  arsip       BOOLEAN NOT NULL DEFAULT false,
  dibuat_pada TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE studios ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'gratis';
ALTER TABLE studios ADD COLUMN IF NOT EXISTS plan_sampai TIMESTAMPTZ;
ALTER TABLE studios ADD COLUMN IF NOT EXISTS kredit_sesi INTEGER NOT NULL DEFAULT 0;
ALTER TABLE studios ADD COLUMN IF NOT EXISTS aktif BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE studios ADD COLUMN IF NOT EXISTS wa_otomatis BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE studios ADD COLUMN IF NOT EXISTS wa_phone_number_id TEXT;
ALTER TABLE studios ADD COLUMN IF NOT EXISTS wa_token_enc TEXT;
ALTER TABLE studios ADD COLUMN IF NOT EXISTS template_hasil TEXT;

ALTER TABLE users ADD COLUMN IF NOT EXISTS cabang_id BIGINT REFERENCES cabangs(id) ON DELETE SET NULL;

ALTER TABLE pakets ADD COLUMN IF NOT EXISTS harga_bertingkat JSONB NOT NULL DEFAULT '[]';

ALTER TABLE sesis ADD COLUMN IF NOT EXISTS cabang_id BIGINT REFERENCES cabangs(id) ON DELETE SET NULL;
ALTER TABLE sesis ADD COLUMN IF NOT EXISTS harga_bertingkat JSONB NOT NULL DEFAULT '[]';
ALTER TABLE sesis ADD COLUMN IF NOT EXISTS hasil_link TEXT;
ALTER TABLE sesis ADD COLUMN IF NOT EXISTS hasil_dikirim_pada TIMESTAMPTZ;
ALTER TABLE sesis ADD COLUMN IF NOT EXISTS terpilih_status TEXT;
ALTER TABLE sesis ADD COLUMN IF NOT EXISTS terpilih_folder_id TEXT;
ALTER TABLE sesis ADD COLUMN IF NOT EXISTS terpilih_info TEXT;
ALTER TABLE sesis ADD COLUMN IF NOT EXISTS kiosk BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS sesis_cabang_idx ON sesis(cabang_id);

ALTER TABLE tagihans ADD COLUMN IF NOT EXISTS order_id TEXT UNIQUE;
ALTER TABLE tagihans ADD COLUMN IF NOT EXISTS payment_url TEXT;
ALTER TABLE tagihans ADD COLUMN IF NOT EXISTS payment_total BIGINT;
ALTER TABLE tagihans ADD COLUMN IF NOT EXISTS dibayar_pada TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS invoices (
  id           BIGSERIAL PRIMARY KEY,
  studio_id    BIGINT NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  jenis        TEXT NOT NULL CHECK (jenis IN ('plan','kredit')),
  plan         TEXT,
  bulan        INTEGER,
  kredit       INTEGER,
  jumlah       BIGINT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'menunggu' CHECK (status IN ('menunggu','lunas','batal')),
  order_id     TEXT NOT NULL UNIQUE,
  payment_url  TEXT,
  dibayar_pada TIMESTAMPTZ,
  dibuat_pada  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wa_logs (
  id          BIGSERIAL PRIMARY KEY,
  studio_id   BIGINT NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  sesi_id     BIGINT REFERENCES sesis(id) ON DELETE CASCADE,
  tujuan      TEXT NOT NULL,
  jenis       TEXT NOT NULL,
  status      TEXT NOT NULL,
  pesan_id    TEXT,
  error       TEXT,
  dibuat_pada TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_audit (
  id        BIGSERIAL PRIMARY KEY,
  aktor     TEXT NOT NULL,
  aksi      TEXT NOT NULL,
  studio_id BIGINT,
  detail    JSONB,
  waktu     TIMESTAMPTZ NOT NULL DEFAULT now()
);
