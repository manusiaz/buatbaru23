'use strict';
// URL pratinjau bertanda tangan & kedaluwarsa (<=60 menit). Browser tidak pernah menerima ID/link Drive.
const fs = require('fs');
const config = require('./config');
const db = require('./db');
const images = require('./images');
const { hmac, safeEqual } = require('./security');

const WINDOW = 600; // URL stabil per jendela 10 menit agar cache browser efektif

function expiry() {
  const now = Math.floor(Date.now() / 1000);
  return Math.floor(now / WINDOW) * WINDOW + config.previewUrlTtlSec;
}
function sign(sesiId, fotoId, kind, exp, v) { return hmac(`m:${sesiId}:${fotoId}:${kind}:${exp}:${v}`).slice(0, 32); }
// v = media_versi sesi: dinaikkan saat PIN/link diganti sehingga URL lama langsung tidak berlaku
function url(sesiId, fotoId, kind, v = 1, staf = false) {
  const exp = expiry();
  const st = staf ? 1 : 0;
  return `/media/${sesiId}/${fotoId}/${kind}?e=${exp}&v=${v}${st ? '&staf=1' : ''}&s=${sign(sesiId, fotoId, kind, exp, `${v}:${st}`)}`;
}

const inflight = new Map();
async function handler(req, res) {
  const sesiId = parseInt(req.params.sesiId, 10);
  const fotoId = parseInt(req.params.fotoId, 10);
  const kind = req.params.kind;
  const exp = parseInt(req.query.e, 10);
  if (!['thumb', 'preview'].includes(kind) || !exp || !req.query.s) return res.status(400).end();
  const now = Math.floor(Date.now() / 1000);
  if (exp < now || exp > now + 3600 + WINDOW) return res.status(410).send('Link pratinjau kedaluwarsa, muat ulang halaman.');
  const v = parseInt(req.query.v, 10) || 1;
  const stf = req.query.staf === '1' ? 1 : 0; // ditandatangani: pelanggan tidak bisa memalsukan URL staf
  if (!safeEqual(sign(sesiId, fotoId, kind, exp, `${v}:${stf}`), req.query.s)) return res.status(403).end();
  const cur = await db.one(`SELECT s.media_versi, (st.aktif AND s.ditangguhkan_pada IS NULL AND p.ditangguhkan_pada IS NULL) AS tersedia
    FROM sesis s JOIN studios st ON st.id=s.studio_id JOIN pelanggans p ON p.id=s.pelanggan_id WHERE s.id=$1`, [sesiId]).catch(() => null);
  if (!cur || cur.media_versi !== v) return res.status(410).send('Link pratinjau sudah tidak berlaku.');
  // Pratinjau staf tetap boleh (URL dibuat di dasbor), tapi galeri tertangguh tidak melayani gambar ke publik
  if (!cur.tersedia && !stf) return res.status(423).send('Galeri sedang tidak tersedia.');
  const p = images.filePath(sesiId, fotoId, kind);
  if (!fs.existsSync(p)) {
    const key = `${fotoId}:${kind}`;
    try {
      if (!inflight.has(key)) {
        inflight.set(key, (async () => {
          const row = await db.one(`SELECT f.*, s.sumber, s.drive_folder_id, s.resource_key AS sesi_resource_key, st.nama AS studio_nama, st.watermark
            FROM fotos f JOIN sesis s ON s.id=f.sesi_id JOIN studios st ON st.id=s.studio_id WHERE f.id=$1 AND f.sesi_id=$2`, [fotoId, sesiId]);
          if (!row) throw Object.assign(new Error('not found'), { status: 404 });
          const sesi = { id: sesiId, sumber: row.sumber, drive_folder_id: row.drive_folder_id, resource_key: row.sesi_resource_key };
          await images.ensure(sesi, row, kind, row.watermark || row.studio_nama);
          await db.q(`UPDATE fotos SET ${kind === 'thumb' ? 'thumb_siap' : 'preview_siap'}=true WHERE id=$1`, [fotoId]);
        })().finally(() => inflight.delete(key)));
      }
      await inflight.get(key);
    } catch (e) {
      if (!e.status) console.error('[media]', sesiId, fotoId, kind, e.message);
      return res.status(e.status || 502).send('Pratinjau belum tersedia.');
    }
  }
  res.set('Cache-Control', `private, max-age=${Math.max(60, exp - now)}`);
  res.set('Content-Type', 'image/webp');
  res.set('Content-Disposition', 'inline');
  fs.createReadStream(p).pipe(res);
}

module.exports = { url, handler };
