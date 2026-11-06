'use strict';
// Jadikan / cabut super admin platform. Jalankan di server:
//   node scripts/superadmin.js tambah email@domain.com
//   node scripts/superadmin.js cabut email@domain.com
//   node scripts/superadmin.js daftar
const db = require('../src/db');

(async () => {
  const [aksi, email] = process.argv.slice(2);
  await db.migrate();
  if (aksi === 'daftar') {
    const rows = await db.many('SELECT id, email, nama FROM users WHERE superadmin ORDER BY id');
    console.table(rows);
  } else if ((aksi === 'tambah' || aksi === 'cabut') && email) {
    const r = await db.one('UPDATE users SET superadmin=$2 WHERE lower(email)=lower($1) RETURNING id, email', [email, aksi === 'tambah']);
    if (!r) { console.error('User tidak ditemukan. Daftar dulu lewat aplikasi, lalu jalankan perintah ini.'); process.exitCode = 1; }
    else {
      await db.q('DELETE FROM user_sessions WHERE user_id=$1', [r.id]); // paksa login ulang
      await db.q('INSERT INTO admin_audit(aktor, aksi, detail) VALUES ($1,$2,$3)', ['cli', aksi === 'tambah' ? 'superadmin_tambah' : 'superadmin_cabut', JSON.stringify({ email: r.email })]);
      console.log(`${r.email}: super admin ${aksi === 'tambah' ? 'aktif' : 'dicabut'}.`);
    }
  } else {
    console.log('Pakai: node scripts/superadmin.js tambah|cabut <email> | daftar');
    process.exitCode = 1;
  }
  await db.pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
