-- Otomasi follow-up pelanggan & alert staf

ALTER TABLE studios ADD COLUMN IF NOT EXISTS otomasi JSONB NOT NULL DEFAULT '{}';
ALTER TABLE sesis ADD COLUMN IF NOT EXISTS pengingat_mati BOOLEAN NOT NULL DEFAULT false;

-- Satu baris per pengingat/alert yang sudah diproses (dedup: tiap aturan hanya sekali per sesi/tahap)
CREATE TABLE IF NOT EXISTS followups (
  id          BIGSERIAL PRIMARY KEY,
  studio_id   BIGINT NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  sesi_id     BIGINT REFERENCES sesis(id) ON DELETE CASCADE,
  kunci       TEXT NOT NULL,
  target      TEXT NOT NULL CHECK (target IN ('pelanggan','staf')),
  kanal       TEXT NOT NULL CHECK (kanal IN ('wa_api','manual','inapp')),
  status      TEXT NOT NULL CHECK (status IN ('terkirim','antre','gagal','dilewati')),
  tujuan      TEXT,
  pesan       TEXT NOT NULL,
  error       TEXT,
  dibuat_pada TIMESTAMPTZ NOT NULL DEFAULT now(),
  dikirim_pada TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS followups_unik ON followups(studio_id, COALESCE(sesi_id, 0), kunci);
CREATE INDEX IF NOT EXISTS followups_antre_idx ON followups(studio_id, status, dibuat_pada DESC);
