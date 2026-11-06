'use strict';
// Retensi (UU PDP): pratinjau cache dihapus setelah sesi selesai + N hari (default 30); log aktivitas 12 bulan.
const db = require('./db');
const images = require('./images');

async function run() {
  const rows = await db.many(`SELECT s.id FROM sesis s JOIN studios st ON st.id=s.studio_id
    WHERE s.status IN ('terkirim','selesai','kedaluwarsa')
      AND COALESCE(s.dikirim_pada, s.tenggat_link) < now() - (st.retensi_hari || ' days')::interval
      AND EXISTS (SELECT 1 FROM fotos f WHERE f.sesi_id=s.id AND (f.thumb_siap OR f.preview_siap))`);
  for (const r of rows) {
    await images.removeSesi(r.id);
    await db.q('UPDATE fotos SET thumb_siap=false, preview_siap=false WHERE sesi_id=$1', [r.id]);
  }
  await db.q("DELETE FROM events WHERE waktu < now() - interval '12 months'");
  await db.q("DELETE FROM notifikasis WHERE dibuat_pada < now() - interval '6 months'");
  await db.q('DELETE FROM user_sessions WHERE kedaluwarsa < now()');
  await db.q('DELETE FROM client_sessions WHERE kedaluwarsa < now()');
  return rows.length;
}

function start() {
  const t = setInterval(() => run().catch((e) => console.error('[retensi]', e.message)), 6 * 3600 * 1000);
  t.unref();
  setTimeout(() => run().catch(() => {}), 30000).unref();
}

module.exports = { run, start };
