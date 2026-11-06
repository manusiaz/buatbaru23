'use strict';
// Pemulihan darurat setting integrasi dari server (mis. Client ID Google salah sehingga tidak ada yang bisa login).
//   node scripts/integrasi.js daftar
//   node scripts/integrasi.js hapus google_client_id
const db = require('../src/db');
const integrasi = require('../src/integrasi');

(async () => {
  const [aksi, kunci] = process.argv.slice(2);
  await db.migrate();
  if (aksi === 'daftar') {
    const rows = await db.many("SELECT substr(kunci, 5) AS kunci, waktu, diubah_oleh FROM platform_settings WHERE kunci LIKE 'int:%' ORDER BY kunci");
    console.table(rows); // nilai tidak pernah ditampilkan
  } else if (aksi === 'hapus' && kunci) {
    if (!integrasi.FIELDS.some((f) => f.k === kunci)) { console.error('Kunci tidak dikenal:', integrasi.FIELDS.map((f) => f.k).join(', ')); process.exitCode = 1; }
    else {
      await db.q('DELETE FROM platform_settings WHERE kunci=$1', ['int:' + kunci]);
      await db.q('INSERT INTO admin_audit(aktor, aksi, detail) VALUES ($1,$2,$3)', ['cli', 'hapus_integrasi', JSON.stringify({ kunci })]);
      console.log(`${kunci} dihapus dari database; nilai .env (bila ada) dipakai lagi. Restart app agar langsung berlaku.`);
    }
  } else {
    console.log('Pakai: node scripts/integrasi.js daftar | hapus <kunci>');
    process.exitCode = 1;
  }
  await db.pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
