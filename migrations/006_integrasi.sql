-- Halaman integrasi: siapa mengubah setting, dan sudo mode (konfirmasi identitas ulang) per sesi login
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS diubah_oleh TEXT;
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS sudo_sampai TIMESTAMPTZ;
