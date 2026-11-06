'use strict';
// Sinkronisasi folder Drive → tabel fotos + gambar mini (F-08, F-09, F-10, F-47).
const db = require('./db');
const drive = require('./drive');
const images = require('./images');
const { logEvent } = require('./sesi');

const running = new Map();

function demoFiles(spec) {
  // spec "contoh:48" → 48 file + 2 file kembar di subfolder lain (untuk menunjukkan F-10)
  const n = Math.max(1, Math.min(500, parseInt(String(spec).split(':')[1] || '48', 10) || 48));
  const out = [];
  const t0 = Date.parse('2026-10-12T02:00:00Z');
  for (let i = 0; i < n; i++) {
    out.push({ id: `demo-${i + 1}`, name: `DSC_${4501 + i}.JPG`, mime: 'image/jpeg', size: 8_000_000 + i * 1000,
      checksum: `demo${i}`, path: n > 20 && i >= n - 6 ? 'Kamera B' : 'Kamera A', takenAt: new Date(t0 + i * 45000).toISOString() });
  }
  if (n >= 4) {
    out.push({ id: 'demo-dup-1', name: 'DSC_4501.JPG', mime: 'image/jpeg', size: 7_900_000, checksum: 'dup1', path: 'Kamera B', takenAt: new Date(t0 + n * 45000).toISOString() });
  }
  return out;
}

function sortFiles(files, urutan) {
  const coll = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  return files.slice().sort((a, b) => {
    if (urutan === 'waktu') {
      const d = (Date.parse(a.takenAt) || 0) - (Date.parse(b.takenAt) || 0);
      if (d) return d;
    }
    return coll.compare(a.name, b.name) || coll.compare(a.path, b.path);
  });
}

async function listFor(sesi) {
  if (sesi.sumber === 'contoh') return demoFiles(sesi.drive_folder_id);
  return drive.listImages({ sumber: sesi.sumber, folderId: sesi.drive_folder_id, resourceKey: sesi.resource_key });
}

async function setProgress(id, patch) {
  const keys = Object.keys(patch);
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(',');
  await db.q(`UPDATE sesis SET ${sets} WHERE id=$1`, [id, ...keys.map((k) => patch[k])]);
}

async function runSync(sesiId, aktor = 'sistem') {
  const sesi = await db.one('SELECT s.*, st.nama AS studio_nama, st.watermark FROM sesis s JOIN studios st ON st.id=s.studio_id WHERE s.id=$1', [sesiId]);
  if (!sesi) return;
  const wm = sesi.watermark || sesi.studio_nama;
  await setProgress(sesiId, { sinkron_status: 'berjalan', sinkron_error: null, sinkron_selesai: 0 });
  try {
    const files = sortFiles(await listFor(sesi), sesi.urutan);
    const existing = await db.many('SELECT * FROM fotos WHERE sesi_id=$1', [sesiId]);
    const byId = new Map(existing.map((f) => [f.drive_file_id, f]));
    const seen = new Set();
    let baru = 0; let ganti = 0; let hapus = 0;
    await db.tx(async (c) => {
      const mx = await c.query('SELECT COALESCE(max(nomor),0)::int AS m FROM fotos WHERE sesi_id=$1', [sesiId]);
      let next = mx.rows[0].m;
      for (const f of files) {
        seen.add(f.id);
        const old = byId.get(f.id);
        if (!old) {
          next += 1; baru += 1;
          await c.query(`INSERT INTO fotos(sesi_id, drive_file_id, resource_key, nama_file, path_subfolder, mime, checksum, ukuran, diambil_pada, nomor)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [sesiId, f.id, f.resourceKey || null, f.name, f.path || '', f.mime, f.checksum, f.size, f.takenAt, next]);
        } else {
          const changed = old.nama_file !== f.name || old.path_subfolder !== (f.path || '') || old.dihapus;
          const contentChanged = (old.checksum || '') !== (f.checksum || '');
          if (changed || contentChanged) {
            ganti += 1;
            await c.query(`UPDATE fotos SET nama_file=$2, path_subfolder=$3, checksum=$4, ukuran=$5, dihapus=false,
              thumb_siap = thumb_siap AND NOT $6, preview_siap = preview_siap AND NOT $6 WHERE id=$1`,
            [old.id, f.name, f.path || '', f.checksum, f.size, contentChanged]);
            if (contentChanged) await images.removeFoto(sesiId, old.id);
          }
        }
      }
      for (const old of existing) {
        if (!seen.has(old.drive_file_id) && !old.dihapus) {
          hapus += 1;
          await c.query('UPDATE fotos SET dihapus=true WHERE id=$1', [old.id]);
        }
      }
      // Tandai nama file kembar (F-10)
      await c.query(`UPDATE fotos f SET nama_kembar = (SELECT count(*) FROM fotos g WHERE g.sesi_id=f.sesi_id AND NOT g.dihapus
        AND lower(g.nama_file)=lower(f.nama_file)) > 1 WHERE f.sesi_id=$1`, [sesiId]);
    });
    const todo = await db.many('SELECT * FROM fotos WHERE sesi_id=$1 AND NOT dihapus ORDER BY nomor', [sesiId]);
    await setProgress(sesiId, { sinkron_total: todo.length, sinkron_selesai: todo.filter((f) => f.thumb_siap).length });
    let done = todo.filter((f) => f.thumb_siap).length;
    const queue = todo.filter((f) => !f.thumb_siap);
    const worker = async () => {
      while (queue.length) {
        const f = queue.shift();
        try {
          await images.ensure(sesi, f, 'thumb', wm);
          await db.q('UPDATE fotos SET thumb_siap=true, thumb_error=NULL WHERE id=$1', [f.id]);
        } catch (e) {
          await db.q('UPDATE fotos SET thumb_error=$2 WHERE id=$1', [f.id, String(e.message).slice(0, 300)]);
        }
        done += 1;
        if (done % 5 === 0 || !queue.length) await setProgress(sesiId, { sinkron_selesai: done });
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    await db.q(`UPDATE sesis SET sinkron_status='selesai', sinkron_pada=now(), sinkron_selesai=$2,
      status = CASE WHEN status='menyinkron' THEN 'siap' ELSE status END WHERE id=$1`, [sesiId, done]);
    await logEvent(null, sesiId, 'sinkron', aktor, { total: todo.length, baru, berubah: ganti, terhapus: hapus });
  } catch (e) {
    console.error('[sync]', sesiId, e.message);
    await setProgress(sesiId, { sinkron_status: 'gagal', sinkron_error: String(e.message).slice(0, 500) });
    await logEvent(null, sesiId, 'sinkron_gagal', aktor, { error: e.message });
  }
}

function startSync(sesiId, aktor) {
  if (running.has(sesiId)) return running.get(sesiId);
  const p = runSync(sesiId, aktor).finally(() => running.delete(sesiId));
  running.set(sesiId, p);
  return p;
}

// Lanjutkan sinkron yang terputus saat server restart
async function resumePending() {
  const rows = await db.many("SELECT id FROM sesis WHERE sinkron_status IN ('menunggu','berjalan')");
  rows.forEach((r) => startSync(r.id, 'sistem'));
}

module.exports = { startSync, runSync, resumePending, isRunning: (id) => running.has(id), sortFiles };
