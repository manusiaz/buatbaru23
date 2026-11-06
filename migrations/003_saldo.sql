-- Model tagihan studio: saldo yang di-top up lewat QRIS statis (dikonfirmasi manual super admin),
-- dipakai untuk membayar paket bulanan. Menggantikan kredit sesi & invoice gateway.

ALTER TABLE studios DROP COLUMN IF EXISTS kredit_sesi;
DROP TABLE IF EXISTS invoices;

ALTER TABLE studios ADD COLUMN IF NOT EXISTS saldo BIGINT NOT NULL DEFAULT 0;
ALTER TABLE studios ADD COLUMN IF NOT EXISTS perpanjang_otomatis BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE studios DROP CONSTRAINT IF EXISTS studios_saldo_nonneg;
ALTER TABLE studios ADD CONSTRAINT studios_saldo_nonneg CHECK (saldo >= 0);

-- Permintaan top up. jumlah_transfer = nominal + kode_unik (agar mudah dicocokkan dengan mutasi rekening).
CREATE TABLE IF NOT EXISTS topups (
  id              BIGSERIAL PRIMARY KEY,
  studio_id       BIGINT NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  nominal         BIGINT NOT NULL CHECK (nominal > 0),
  kode_unik       INTEGER NOT NULL CHECK (kode_unik BETWEEN 1 AND 999),
  jumlah_transfer BIGINT NOT NULL CHECK (jumlah_transfer > 0),
  status          TEXT NOT NULL DEFAULT 'menunggu' CHECK (status IN ('menunggu','disetujui','ditolak','batal')),
  bukti_path      TEXT,
  catatan         TEXT,
  dibuat_oleh     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  diproses_oleh   TEXT,
  diproses_pada   TIMESTAMPTZ,
  kedaluwarsa     TIMESTAMPTZ NOT NULL,
  dibuat_pada     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS topups_status_idx ON topups(status, dibuat_pada);
-- Kode unik tidak boleh dipakai dua permintaan menunggu dengan nominal yang sama
CREATE UNIQUE INDEX IF NOT EXISTS topups_pending_unik ON topups(jumlah_transfer) WHERE status = 'menunggu';

-- Buku besar saldo: hanya INSERT. saldo_akhir dicatat per baris untuk rekonsiliasi.
CREATE TABLE IF NOT EXISTS saldo_mutasi (
  id          BIGSERIAL PRIMARY KEY,
  studio_id   BIGINT NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  jenis       TEXT NOT NULL CHECK (jenis IN ('topup','bayar_paket','koreksi')),
  jumlah      BIGINT NOT NULL,
  saldo_akhir BIGINT NOT NULL CHECK (saldo_akhir >= 0),
  keterangan  TEXT NOT NULL,
  ref         TEXT,
  aktor       TEXT NOT NULL,
  waktu       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saldo_mutasi_studio_idx ON saldo_mutasi(studio_id, waktu DESC);
CREATE OR REPLACE FUNCTION saldo_mutasi_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'saldo_mutasi tidak boleh diubah atau dihapus'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS saldo_mutasi_no_update ON saldo_mutasi;
CREATE TRIGGER saldo_mutasi_no_update BEFORE UPDATE OR DELETE ON saldo_mutasi
  FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION saldo_mutasi_immutable();

-- Pengaturan platform (QRIS statis, nama penerima)
CREATE TABLE IF NOT EXISTS platform_settings (
  kunci TEXT PRIMARY KEY,
  nilai TEXT NOT NULL,
  waktu TIMESTAMPTZ NOT NULL DEFAULT now()
);
