-- Tangguhkan akses pelanggan: per galeri atau per pelanggan (semua galerinya). Data tetap utuh.
ALTER TABLE sesis ADD COLUMN IF NOT EXISTS ditangguhkan_pada TIMESTAMPTZ;
ALTER TABLE sesis ADD COLUMN IF NOT EXISTS ditangguhkan_alasan TEXT;
ALTER TABLE pelanggans ADD COLUMN IF NOT EXISTS ditangguhkan_pada TIMESTAMPTZ;
ALTER TABLE pelanggans ADD COLUMN IF NOT EXISTS ditangguhkan_alasan TEXT;
