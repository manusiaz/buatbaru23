-- Perbaikan keamanan hasil audit

-- Super admin ditandai di database (lewat CLI), bukan dari email yang belum terverifikasi
ALTER TABLE users ADD COLUMN IF NOT EXISTS superadmin BOOLEAN NOT NULL DEFAULT false;

-- Nomor WhatsApp milik platform hanya boleh dipakai studio yang diizinkan super admin
ALTER TABLE studios ADD COLUMN IF NOT EXISTS wa_platform BOOLEAN NOT NULL DEFAULT false;

-- Folder Drive terikat ke studio pertama yang menautkannya (cegah studio lain membaca folder lewat service account bersama)
CREATE TABLE IF NOT EXISTS drive_folders (
  folder_id   TEXT PRIMARY KEY,
  studio_id   BIGINT NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  dibuat_pada TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO drive_folders(folder_id, studio_id)
  SELECT DISTINCT ON (drive_folder_id) drive_folder_id, studio_id FROM sesis
  WHERE sumber='service_account' AND drive_folder_id IS NOT NULL ORDER BY drive_folder_id, dibuat_pada
ON CONFLICT DO NOTHING;

-- Batas gagal PIN per galeri (semua IP)
CREATE TABLE IF NOT EXISTS pin_galeri (
  sesi_id      BIGINT PRIMARY KEY REFERENCES sesis(id) ON DELETE CASCADE,
  gagal        INTEGER NOT NULL DEFAULT 0,
  jendela_mulai TIMESTAMPTZ NOT NULL DEFAULT now(),
  kunci_sampai TIMESTAMPTZ
);
