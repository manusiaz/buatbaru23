'use strict';
// API galeri pelanggan: /g/:token/api/*  (link unik + PIN, F-13..F-33)
const express = require('express');
const config = require('../config');
const db = require('../db');
const media = require('../media');
const S = require('../sesi');
const { notify } = require('../notify');
const { randomToken, sha256, safeEqual } = require('../security');
const { currentUser } = require('../auth');
const { HttpError, bad, notFound, ah, str, int, parseCookies, setCookie } = require('../http');
const { limit } = require('../ratelimit');
const plans = require('../plans');
const payment = require('../payment');
const { decrypt } = require('../security');

const r = express.Router({ mergeParams: true });
const MAX_GAGAL = 5;
const KUNCI_MENIT = 15;

function cookieName(sesiId) { return `gs_c${sesiId}`; }

async function findSesi(token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token || '')) return null;
  const s = await db.one('SELECT id FROM sesis WHERE token_hash=$1', [sha256(token)]);
  if (!s) return null;
  return S.enforce(s.id);
}

async function context(req) {
  const sesi = await findSesi(req.params.token);
  if (!sesi) throw notFound('Galeri tidak ditemukan. Periksa kembali link dari studio.');
  const studio = await db.one('SELECT * FROM studios WHERE id=$1', [sesi.studio_id]);
  const pel = await db.one('SELECT nama, no_wa FROM pelanggans WHERE id=$1', [sesi.pelanggan_id]);
  const c = parseCookies(req)[cookieName(sesi.id)];
  let authed = false;
  if (c) authed = !!(await db.one('SELECT 1 FROM client_sessions WHERE token_hash=$1 AND sesi_id=$2 AND kedaluwarsa>now()', [sha256(c), sesi.id]));
  const user = await currentUser(req);
  const staff = !!(user && user.studio_id === sesi.studio_id);
  const tagihan = await db.one('SELECT jumlah_foto, total_rupiah, status_bayar, metode FROM tagihans WHERE sesi_id=$1', [sesi.id]);
  return { sesi, studio, pel, authed, staff, tagihan };
}

function gate(ctx) {
  if (!ctx.authed && !ctx.staff) throw new HttpError(401, 'Masukkan PIN dulu.');
}

function phase(s) {
  // Fase yang dilihat pelanggan
  if (s.status === 'menyinkron') return 'menyiapkan';
  if (s.status === 'kedaluwarsa') return 'kedaluwarsa';
  if (s.status === 'terkirim' || s.status === 'selesai') return s.dikirim_otomatis ? 'waktu_habis' : 'terkirim';
  if (s.status === 'memilih') return 'memilih';
  return S.modeHitungMundur(s) ? 'sebelum_mulai' : 'memilih';
}

function studioPublic(studio) {
  return {
    nama: studio.nama, warna: studio.warna, no_wa: studio.no_wa, zona_waktu: studio.zona_waktu,
    logo_url: studio.logo_path ? `/logo/${studio.id}` : null,
  };
}

function infoOut(ctx) {
  const s = ctx.sesi;
  return {
    studio: studioPublic(ctx.studio),
    judul: s.judul, jenis: s.jenis, tanggal_sesi: s.tanggal_sesi, pelanggan: ctx.pel.nama,
    kuota: s.kuota, durasi_pilih_menit: s.durasi_pilih_menit, harga_foto_tambahan: s.harga_foto_tambahan,
    maks_foto_tambahan: s.maks_foto_tambahan, tenggat_link: s.tenggat_link, izin_catatan: s.izin_catatan,
    tampil_nama_file: s.tampil_nama_file || (ctx.staff && !ctx.authed),
    fase: phase(s), perlu_pin: !ctx.authed && !ctx.staff,
    // staf yang membuka tanpa sesi pelanggan = pratinjau baca-saja; di kiosk staf memakai sesi pelanggan
    staff: ctx.staff && !ctx.authed, kiosk: !!s.kiosk && ctx.authed,
    harga_bertingkat: s.harga_bertingkat || [],
    label_produk: plans.summary(ctx.studio).label_produk,
    hasil_link: (ctx.authed || ctx.staff) && ['terkirim', 'selesai'].includes(s.status) ? s.hasil_link : null,
    tagihan: (ctx.authed || ctx.staff) && ctx.tagihan ? { jumlah_foto: ctx.tagihan.jumlah_foto, total: Number(ctx.tagihan.total_rupiah), status_bayar: ctx.tagihan.status_bayar, metode: ctx.tagihan.metode } : null,
    bayar_online: payment.enabled() && plans.has(ctx.studio, 'bayar_online'),
    staff_url: ctx.staff ? `/app#/galeri/${s.id}` : null,
    berakhir_pada: s.berakhir_pada, mulai_pilih_pada: s.mulai_pilih_pada, dikirim_pada: s.dikirim_pada,
    minta_waktu_pada: s.minta_waktu_pada, catatan_umum: ctx.authed || ctx.staff ? s.catatan_umum : null,
    server_now: new Date().toISOString(),
    gallery_url: `${config.baseUrl}/g/${encodeURIComponent(ctx.tokenParam)}`,
  };
}

async function markOpened(sesi, first) {
  await db.q(`UPDATE sesis SET jumlah_dibuka=jumlah_dibuka+1, dibuka_pada=COALESCE(dibuka_pada, now()),
    status=CASE WHEN status='siap' THEN 'dibuka' ELSE status END WHERE id=$1`, [sesi.id]);
  await S.logEvent(null, sesi.id, 'dibuka', 'pelanggan', null);
  if (first) await notify(sesi.studio_id, sesi.id, 'dibuka', `${sesi.judul} membuka galeri`, { email: false });
}

r.use((req, res, next) => { req.tokenParam = req.params.token; next(); });

r.get('/info', ah(async (req, res) => {
  const ctx = await context(req);
  ctx.tokenParam = req.params.token;
  res.json(infoOut(ctx));
}));

r.post('/pin', limit('pin', 30, 15 * 60), ah(async (req, res) => {
  const sesi = await findSesi(req.params.token);
  if (!sesi) throw notFound('Galeri tidak ditemukan.');
  const pin = String(req.body.pin || '').trim();
  const ip = req.ip || 'unknown';
  const att = await db.one('SELECT * FROM pin_attempts WHERE sesi_id=$1 AND ip=$2', [sesi.id, ip]);
  if (att && att.kunci_sampai && new Date(att.kunci_sampai) > Date.now()) {
    const sisa = Math.ceil((new Date(att.kunci_sampai) - Date.now()) / 60000);
    throw new HttpError(429, `PIN terkunci karena ${MAX_GAGAL} kali salah. Coba lagi dalam ${sisa} menit.`, { terkunci_sampai: att.kunci_sampai });
  }
  if (!/^\d{4,6}$/.test(pin) || !safeEqual(sha256(`pin:${pin}`), sesi.pin_hash)) {
    const gagal = (att ? att.gagal : 0) + 1;
    const kunci = gagal >= MAX_GAGAL ? new Date(Date.now() + KUNCI_MENIT * 60000) : null;
    await db.q(`INSERT INTO pin_attempts(sesi_id, ip, gagal, kunci_sampai) VALUES ($1,$2,$3,$4)
      ON CONFLICT (sesi_id, ip) DO UPDATE SET gagal=$3, kunci_sampai=$4`, [sesi.id, ip, kunci ? 0 : gagal, kunci]);
    if (kunci) {
      await S.logEvent(null, sesi.id, 'pin_terkunci', 'sistem', { ip });
      throw new HttpError(429, `PIN terkunci ${KUNCI_MENIT} menit karena ${MAX_GAGAL} kali salah.`, { terkunci_sampai: kunci });
    }
    throw bad(`PIN salah. Sisa ${MAX_GAGAL - gagal} percobaan.`, { sisa: MAX_GAGAL - gagal });
  }
  await db.q('DELETE FROM pin_attempts WHERE sesi_id=$1 AND ip=$2', [sesi.id, ip]);
  const token = randomToken(32);
  await db.q("INSERT INTO client_sessions(token_hash, sesi_id, kedaluwarsa) VALUES ($1,$2, now() + interval '30 days')", [sha256(token), sesi.id]);
  setCookie(res, req, cookieName(sesi.id), token, { maxAge: 30 * 86400, path: `/g/${req.params.token}` });
  await markOpened(sesi, !sesi.dibuka_pada);
  res.json({ ok: true });
}));

r.get('/state', ah(async (req, res) => {
  const ctx = await context(req);
  ctx.tokenParam = req.params.token;
  gate(ctx);
  const s = ctx.sesi;
  const info = infoOut(ctx);
  const hidden = info.fase === 'sebelum_mulai' || info.fase === 'menyiapkan' || (info.fase === 'kedaluwarsa' && !info.staff);
  const fotos = hidden ? [] : await db.many(`SELECT f.id, f.nomor, f.nama_file, f.path_subfolder, f.nama_kembar, f.thumb_siap,
      p.catatan, p.is_tambahan, (p.foto_id IS NOT NULL) AS dipilih, p.dipilih_pada
    FROM fotos f LEFT JOIN pilihans p ON p.foto_id=f.id AND p.sesi_id=f.sesi_id
    WHERE f.sesi_id=$1 AND (NOT f.dihapus OR p.foto_id IS NOT NULL) ORDER BY f.nomor`, [s.id]);
  const total = (await db.one('SELECT COALESCE(max(nomor),0)::int AS m, count(*) FILTER (WHERE NOT dihapus)::int AS n FROM fotos WHERE sesi_id=$1', [s.id]));
  const showName = info.tampil_nama_file;
  res.json({
    ...info,
    nomor_total: total.m,
    jumlah_foto: total.n,
    progres: s.status === 'menyinkron' ? { selesai: s.sinkron_selesai, total: s.sinkron_total } : null,
    fotos: fotos.map((f) => ({
      nomor: f.nomor,
      nama_file: showName ? f.nama_file : null,
      subfolder: showName ? f.path_subfolder : null,
      nama_kembar: showName ? f.nama_kembar : false,
      dipilih: f.dipilih, catatan: f.catatan, is_tambahan: f.is_tambahan,
      thumb: media.url(s.id, f.id, 'thumb'),
      preview: media.url(s.id, f.id, 'preview'),
    })),
  });
}));

// Kunci baris sesi + validasi boleh mengubah pilihan
async function lockForEdit(c, req) {
  const sesi = await findSesi(req.params.token);
  if (!sesi) throw notFound();
  const ck = parseCookies(req)[cookieName(sesi.id)];
  const ok = ck && (await c.query('SELECT 1 FROM client_sessions WHERE token_hash=$1 AND sesi_id=$2 AND kedaluwarsa>now()', [sha256(ck), sesi.id])).rowCount;
  if (!ok) throw new HttpError(401, 'Masukkan PIN dulu.');
  const s = (await c.query('SELECT * FROM sesis WHERE id=$1 FOR UPDATE', [sesi.id])).rows[0];
  const now = Date.now();
  if (s.status === 'terkirim' || s.status === 'selesai') throw new HttpError(409, 'Pilihan sudah dikirim dan terkunci. Hubungi studio untuk membukanya lagi.');
  if (s.status === 'kedaluwarsa') throw new HttpError(409, 'Galeri sudah kedaluwarsa.');
  if (s.status === 'menyinkron') throw new HttpError(409, 'Galeri masih disiapkan.');
  if (s.status === 'memilih') {
    if (s.berakhir_pada && now > new Date(s.berakhir_pada).getTime() + S.GRACE_MS) throw new HttpError(409, 'Waktu memilih sudah habis.');
    return s;
  }
  // siap / dibuka
  if (S.modeHitungMundur(s)) throw new HttpError(409, 'Tekan "Mulai pilih" dulu.');
  if (s.tenggat_link && now > new Date(s.tenggat_link).getTime()) throw new HttpError(409, 'Galeri sudah kedaluwarsa.');
  // Mode "tenggat saja": pilihan pertama memulai sesi memilih sampai tenggat link
  const u = await c.query("UPDATE sesis SET status='memilih', mulai_pilih_pada=now(), berakhir_pada=tenggat_link WHERE id=$1 RETURNING *", [s.id]);
  await S.logEvent(c, s.id, 'mulai', 'pelanggan', { mode: 'tenggat_saja' });
  return u.rows[0];
}

r.post('/mulai', ah(async (req, res) => {
  const ctx = await context(req);
  if (!ctx.authed) throw new HttpError(401, 'Masukkan PIN dulu.');
  await db.tx(async (c) => {
    const s = (await c.query('SELECT * FROM sesis WHERE id=$1 FOR UPDATE', [ctx.sesi.id])).rows[0];
    if (!['siap', 'dibuka'].includes(s.status)) return; // sudah mulai: idempoten
    if (s.tenggat_link && Date.now() > new Date(s.tenggat_link).getTime()) throw new HttpError(409, 'Galeri sudah kedaluwarsa.');
    const menit = s.durasi_pilih_menit > 0 ? s.durasi_pilih_menit : null;
    // Server mencatat waktu mulai & berakhir; jam server satu-satunya acuan
    await c.query(`UPDATE sesis SET status='memilih', mulai_pilih_pada=now(),
      berakhir_pada = ${menit ? "now() + ($2 || ' minutes')::interval" : 'tenggat_link'} WHERE id=$1`, menit ? [s.id, String(menit)] : [s.id]);
    await S.logEvent(c, s.id, 'mulai', 'pelanggan', { menit });
  });
  res.json({ ok: true });
}));

r.post('/pilih', limit('pilih', 600, 60), ah(async (req, res) => {
  const nomor = int(req.body.nomor, { min: 1, max: 100000, name: 'Nomor' });
  const pilih = req.body.pilih !== false;
  const out = await db.tx(async (c) => {
    const s = await lockForEdit(c, req);
    const f = (await c.query('SELECT id, dihapus FROM fotos WHERE sesi_id=$1 AND nomor=$2', [s.id, nomor])).rows[0];
    if (!f) throw notFound('Foto tidak ditemukan.');
    if (pilih) {
      if (f.dihapus) throw bad('Foto ini sudah dihapus studio.');
      const sudah = (await c.query('SELECT 1 FROM pilihans WHERE sesi_id=$1 AND foto_id=$2', [s.id, f.id])).rowCount;
      if (!sudah) {
        const n = (await c.query('SELECT count(*)::int AS n FROM pilihans WHERE sesi_id=$1', [s.id])).rows[0].n;
        const batas = s.kuota + s.maks_foto_tambahan;
        if (n >= batas) {
          throw new HttpError(409, s.maks_foto_tambahan > 0
            ? `Batas ${batas} foto (kuota ${s.kuota} + ${s.maks_foto_tambahan} tambahan) sudah tercapai.`
            : `Kuota ${s.kuota} foto sudah penuh. Batalkan salah satu untuk mengganti.`, { kuota_penuh: true });
        }
        await c.query('INSERT INTO pilihans(sesi_id, foto_id) VALUES ($1,$2)', [s.id, f.id]);
        await S.logEvent(c, s.id, 'pilih', 'pelanggan', { nomor });
      }
    } else {
      const d = await c.query('DELETE FROM pilihans WHERE sesi_id=$1 AND foto_id=$2', [s.id, f.id]);
      if (d.rowCount) await S.logEvent(c, s.id, 'batal', 'pelanggan', { nomor });
    }
    const t = await S.recomputeTagihan(c, s);
    const ext = await c.query('SELECT f.nomor FROM pilihans p JOIN fotos f ON f.id=p.foto_id WHERE p.sesi_id=$1 AND p.is_tambahan ORDER BY f.nomor', [s.id]);
    return { ok: true, jumlah: t.jumlah, tambahan: t.tambahan, total_rupiah: t.total,
      tambahan_nomor: ext.rows.map((x) => x.nomor), berakhir_pada: s.berakhir_pada, fase: 'memilih' };
  });
  res.json(out);
}));

r.put('/catatan', ah(async (req, res) => {
  const nomor = int(req.body.nomor, { min: 1, max: 100000, name: 'Nomor' });
  const catatan = str(req.body.catatan, { max: 500, name: 'Catatan' }) || null;
  await db.tx(async (c) => {
    const s = await lockForEdit(c, req);
    if (!s.izin_catatan) throw bad('Catatan per foto tidak diaktifkan studio.');
    const u = await c.query(`UPDATE pilihans p SET catatan=$3 FROM fotos f WHERE p.foto_id=f.id AND p.sesi_id=$1 AND f.nomor=$2`, [s.id, nomor, catatan]);
    if (!u.rowCount) throw bad('Pilih fotonya dulu sebelum menulis catatan.');
  });
  res.json({ ok: true });
}));

r.put('/catatan-umum', ah(async (req, res) => {
  const catatan = str(req.body.catatan, { max: 2000, name: 'Catatan' }) || null;
  await db.tx(async (c) => {
    const s = await lockForEdit(c, req);
    await c.query('UPDATE sesis SET catatan_umum=$2 WHERE id=$1', [s.id, catatan]);
  });
  res.json({ ok: true });
}));

r.post('/kirim', ah(async (req, res) => {
  let out = null;
  await db.tx(async (c) => {
    const s = await lockForEdit(c, req);
    out = await S.submit(c, s, { otomatis: false, aktor: 'pelanggan' });
  });
  if (out) await S.afterSubmit(out.sesi, out.jumlah, false);
  res.json({ ok: true, jumlah: out ? out.jumlah : 0 });
}));

r.post('/minta-waktu', limit('minta', 10, 60 * 60), ah(async (req, res) => {
  const ctx = await context(req);
  if (!ctx.authed) throw new HttpError(401, 'Masukkan PIN dulu.');
  const s = ctx.sesi;
  if (s.minta_waktu_pada && Date.now() - new Date(s.minta_waktu_pada) < 5 * 60000) return res.json({ ok: true, sudah: true });
  await db.q('UPDATE sesis SET minta_waktu_pada=now() WHERE id=$1', [s.id]);
  await S.logEvent(null, s.id, 'minta_waktu', 'pelanggan', { fase: phase(s) });
  await notify(s.studio_id, s.id, 'minta_waktu', `${s.judul} minta tambah waktu`);
  res.json({ ok: true });
}));

// F-35: bayar foto tambahan online (QRIS / VA) setelah pilihan terkirim
r.post('/bayar', limit('bayar', 20, 3600), ah(async (req, res) => {
  const ctx = await context(req);
  if (!ctx.authed) throw new HttpError(401, 'Masukkan PIN dulu.');
  const s = ctx.sesi;
  if (!['terkirim', 'selesai'].includes(s.status)) throw bad('Kirim pilihan dulu sebelum membayar.');
  if (!(payment.enabled() && plans.has(ctx.studio, 'bayar_online'))) throw bad('Pembayaran online tidak tersedia. Bayar di kasir atau transfer.');
  const t = await db.one('SELECT * FROM tagihans WHERE sesi_id=$1', [s.id]);
  if (!t || Number(t.total_rupiah) <= 0) throw bad('Tidak ada tagihan foto tambahan.');
  if (t.status_bayar === 'lunas') throw bad('Tagihan sudah lunas.');
  if (t.payment_url && Number(t.payment_total) === Number(t.total_rupiah)) return res.json({ url: t.payment_url });
  const orderId = `GS-T-${s.id}-${Date.now()}`;
  const amount = Number(t.total_rupiah);
  let snap;
  try {
    snap = await payment.createSnap({ orderId, amount,
      items: [{ id: `tambahan-${s.id}`, name: `${t.jumlah_foto} foto tambahan · ${s.judul}`.slice(0, 50), price: amount, quantity: 1 }],
      customer: { first_name: ctx.pel.nama, phone: ctx.pel.no_wa || undefined }, finishUrl: `${config.baseUrl}/g/${decrypt(s.token_enc)}` });
  } catch (e) { throw bad(e.message); }
  await db.q('UPDATE tagihans SET order_id=$2, payment_url=$3, payment_total=$4, diubah_pada=now() WHERE sesi_id=$1', [s.id, orderId, snap.url, amount]);
  await S.logEvent(null, s.id, 'bayar_dibuat', 'pelanggan', { total: amount });
  res.json({ url: snap.url });
}));

module.exports = r;
