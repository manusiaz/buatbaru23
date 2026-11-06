'use strict';
// Aturan timer, status sesi, pilihan, dan tagihan foto tambahan.
const db = require('./db');
const { notify } = require('./notify');

const GRACE_MS = 10 * 1000; // simpanan yang tiba <=10 detik setelah waktu habis masih diterima

async function logEvent(c, sesiId, jenis, aktor, detail) {
  await (c || db.pool).query('INSERT INTO events(sesi_id, jenis, aktor, detail) VALUES ($1,$2,$3,$4)',
    [sesiId, jenis, aktor, detail ? JSON.stringify(detail) : null]);
}

function modeHitungMundur(sesi) { return sesi.durasi_pilih_menit > 0; }

// Hitung ulang flag is_tambahan (urut waktu pilih) dan tagihan.
async function recomputeTagihan(c, sesi) {
  await c.query(`WITH urut AS (
      SELECT foto_id, row_number() OVER (ORDER BY dipilih_pada, foto_id) AS rn FROM pilihans WHERE sesi_id=$1)
    UPDATE pilihans p SET is_tambahan = (u.rn > $2) FROM urut u WHERE p.sesi_id=$1 AND p.foto_id=u.foto_id`, [sesi.id, sesi.kuota]);
  const r = await c.query('SELECT count(*)::int AS n FROM pilihans WHERE sesi_id=$1', [sesi.id]);
  const n = r.rows[0].n;
  const tambahan = Math.max(0, n - sesi.kuota);
  await c.query(`INSERT INTO tagihans(sesi_id, jumlah_foto, total_rupiah) VALUES ($1,$2,$3)
    ON CONFLICT (sesi_id) DO UPDATE SET jumlah_foto=EXCLUDED.jumlah_foto, total_rupiah=EXCLUDED.total_rupiah, diubah_pada=now()`,
  [sesi.id, tambahan, tambahan * sesi.harga_foto_tambahan]);
  return { jumlah: n, tambahan };
}

async function submit(c, sesi, { otomatis = false, aktor = 'pelanggan' } = {}) {
  const r = await c.query(`UPDATE sesis SET status='terkirim', dikirim_pada=now(), dikirim_otomatis=$2
    WHERE id=$1 AND status IN ('dibuka','memilih') RETURNING *`, [sesi.id, otomatis]);
  if (!r.rowCount) return null;
  const n = (await c.query('SELECT count(*)::int AS n FROM pilihans WHERE sesi_id=$1', [sesi.id])).rows[0].n;
  await logEvent(c, sesi.id, otomatis ? 'waktu_habis' : 'kirim', aktor, { jumlah: n, kuota: sesi.kuota, kurang_dari_kuota: n < sesi.kuota });
  return { sesi: r.rows[0], jumlah: n };
}

async function afterSubmit(sesi, jumlah, otomatis) {
  const kurang = jumlah < sesi.kuota ? ' (kurang dari kuota)' : '';
  const pesan = otomatis
    ? `Waktu habis: pilihan ${sesi.judul} terkirim otomatis, ${jumlah}/${sesi.kuota} foto${kurang}`
    : `${sesi.judul} mengirim ${jumlah} pilihan${kurang}`;
  await notify(sesi.studio_id, sesi.id, 'pilihan_masuk', pesan);
}

// Terapkan aturan waktu ke satu sesi (dipanggil saat sesi diakses dan oleh sweeper).
async function enforce(sesiId) {
  let submitted = null;
  const sesi = await db.tx(async (c) => {
    const r = await c.query('SELECT * FROM sesis WHERE id=$1 FOR UPDATE', [sesiId]);
    const s = r.rows[0];
    if (!s) return null;
    const now = Date.now();
    if (s.status === 'memilih' && s.berakhir_pada && now > new Date(s.berakhir_pada).getTime() + GRACE_MS) {
      const out = await submit(c, s, { otomatis: true, aktor: 'sistem' });
      if (out) { submitted = out; return out.sesi; }
    }
    if (['siap', 'dibuka'].includes(s.status) && s.tenggat_link && now > new Date(s.tenggat_link).getTime()) {
      const u = await c.query("UPDATE sesis SET status='kedaluwarsa' WHERE id=$1 RETURNING *", [s.id]);
      await logEvent(c, s.id, 'kedaluwarsa', 'sistem');
      return u.rows[0];
    }
    return s;
  });
  if (submitted) await afterSubmit(submitted.sesi, submitted.jumlah, true);
  return sesi;
}

async function sweep() {
  const rows = await db.many(`SELECT id FROM sesis WHERE
    (status='memilih' AND berakhir_pada < now() - interval '10 seconds')
    OR (status IN ('siap','dibuka') AND tenggat_link < now())`);
  for (const r of rows) {
    try { await enforce(r.id); } catch (e) { console.error('[sweep]', r.id, e.message); }
  }
  return rows.length;
}

// Gangguan sistem: waktu pelanggan diperpanjang otomatis sebesar durasi gangguan.
async function heartbeat() {
  await db.q(`INSERT INTO system_state(kunci, nilai, waktu) VALUES ('heartbeat', '', now())
    ON CONFLICT (kunci) DO UPDATE SET waktu=now()`);
}
async function compensateDowntime() {
  const hb = await db.one("SELECT waktu FROM system_state WHERE kunci='heartbeat'");
  if (!hb) return 0;
  const gapMs = Date.now() - new Date(hb.waktu).getTime();
  if (gapMs < 60 * 1000) return 0;
  const rows = await db.many(`UPDATE sesis SET berakhir_pada = berakhir_pada + ($1 || ' milliseconds')::interval
    WHERE status='memilih' AND berakhir_pada > $2 RETURNING id`, [String(gapMs), hb.waktu]);
  for (const r of rows) await logEvent(null, r.id, 'perpanjang', 'sistem', { alasan: 'gangguan_sistem', detik: Math.round(gapMs / 1000) });
  if (rows.length) console.log(`[downtime] ${rows.length} timer diperpanjang ${Math.round(gapMs / 1000)} detik`);
  return rows.length;
}

let timers = [];
function startBackground() {
  const run = (fn, ms) => {
    const t = setInterval(() => fn().catch((e) => console.error('[bg]', e.message)), ms);
    t.unref();
    timers.push(t);
  };
  run(sweep, 15000);
  run(heartbeat, 20000);
}
function stopBackground() { timers.forEach(clearInterval); timers = []; }

module.exports = {
  logEvent, recomputeTagihan, submit, afterSubmit, enforce, sweep, heartbeat, compensateDowntime,
  startBackground, stopBackground, modeHitungMundur, GRACE_MS,
};
