-- Log keamanan studio & rotasi link galeri

-- Log keamanan per studio (login, perubahan tim/pengaturan, penghapusan, rotasi link)
CREATE TABLE IF NOT EXISTS studio_audit (
  id         BIGSERIAL PRIMARY KEY,
  studio_id  BIGINT NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  aktor      TEXT NOT NULL,
  aksi       TEXT NOT NULL,
  detail     JSONB,
  ip         TEXT,
  user_agent TEXT,
  waktu      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS studio_audit_idx ON studio_audit(studio_id, waktu DESC);

-- Versi media per sesi: dinaikkan saat PIN/link diganti agar URL pratinjau lama ikut mati
ALTER TABLE sesis ADD COLUMN IF NOT EXISTS media_versi INTEGER NOT NULL DEFAULT 1;
