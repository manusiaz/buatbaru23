'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');
const drive = require('../drive');
const media = require('../media');
const sync = require('../sync');
const images = require('../images');
const S = require('../sesi');
const F = require('../../public/shared/format');
const { randomToken, sha256, encrypt, decrypt, randomPin } = require('../security');
const { hashPassword, checkPassword, createLogin, destroyLogin, currentUser, requireUser, can } = require('../auth');
const { HttpError, bad, forbidden, notFound, ah, str, int, bool } = require('../http');
const { limit } = require('../ratelimit');

const r = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ZONA = ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'];
const FORMAT_KEYS = Object.keys(F.FORMATS);

function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40) || 'studio';
}
async function uniqueSlug(base, exceptId) {
  let slug = slugify(base); let i = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await db.one('SELECT 1 FROM studios WHERE slug=$1 AND id<>$2', [slug, exceptId || 0])) slug = `${slugify(base)}-${++i}`;
  return slug;
}
function normWa(v) {
  let s = String(v || '').replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('0')) s = '62' + s.slice(1);
  if (!/^\d{8,15}$/.test(s)) throw bad('Nomor WhatsApp tidak valid.');
  return s;
}
function galleryUrl(token) { return `${config.baseUrl}/g/${token}`; }

// ---------- Konfigurasi publik ----------
r.get('/config', (req, res) => {
  res.json({
    appName: config.appName,
    baseUrl: config.baseUrl,
    googleClientId: config.googleClientId || null,
    googleApiKey: config.googleApiKey || null,
    googleAppId: config.googleAppId || null,
    serviceAccountEmail: drive.serviceAccountEmail(),
    demoSource: config.allowDemoSource,
    formats: F.FORMATS,
  });
});

// ---------- Auth ----------
r.post('/auth/register', limit('auth', 10, 15 * 60), ah(async (req, res) => {
  const studioNama = str(req.body.studio_nama, { required: true, max: 80, name: 'Nama studio' });
  const nama = str(req.body.nama, { required: true, max: 80, name: 'Nama' });
  const email = str(req.body.email, { required: true, max: 160, name: 'Email' }).toLowerCase();
  const password = String(req.body.password || '');
  if (!EMAIL_RE.test(email)) throw bad('Email tidak valid.');
  if (password.length < 8) throw bad('Kata sandi minimal 8 karakter.');
  if (await db.one('SELECT 1 FROM users WHERE email=$1', [email])) throw bad('Email sudah terdaftar. Silakan masuk.');
  const hash = await hashPassword(password);
  const user = await db.tx(async (c) => {
    const slug = await uniqueSlug(studioNama);
    const st = (await c.query('INSERT INTO studios(nama, slug, no_wa) VALUES ($1,$2,$3) RETURNING id',
      [studioNama, slug, req.body.no_wa ? normWa(req.body.no_wa) : null])).rows[0];
    await seedPakets(c, st.id);
    return (await c.query("INSERT INTO users(studio_id, nama, email, password_hash, peran) VALUES ($1,$2,$3,$4,'owner') RETURNING id",
      [st.id, nama, email, hash])).rows[0];
  });
  await createLogin(req, res, user.id);
  res.json({ ok: true });
}));

async function seedPakets(c, studioId) {
  const def = [
    ['Wisuda', 5, 30, 24, 25000, 10],
    ['Self-photo', 3, 15, 6, 15000, 10],
    ['Prewedding', 20, 0, 168, 35000, 20],
  ];
  for (const p of def) {
    await c.query(`INSERT INTO pakets(studio_id, nama, kuota, durasi_pilih_menit, masa_aktif_jam, harga_foto_tambahan, maks_foto_tambahan)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [studioId, ...p]);
  }
}

r.post('/auth/login', limit('auth', 20, 15 * 60), ah(async (req, res) => {
  const email = str(req.body.email, { required: true, max: 160, name: 'Email' }).toLowerCase();
  const u = await db.one('SELECT id, password_hash, aktif FROM users WHERE email=$1', [email]);
  if (!u || !u.aktif || !(await checkPassword(String(req.body.password || ''), u.password_hash))) {
    throw bad('Email atau kata sandi salah.');
  }
  await createLogin(req, res, u.id);
  res.json({ ok: true });
}));

// Masuk/daftar dengan Google (ID token dari Google Identity Services)
r.post('/auth/google', limit('auth', 20, 15 * 60), ah(async (req, res) => {
  if (!config.googleClientId) throw bad('Login Google belum dikonfigurasi.');
  const credential = str(req.body.credential, { required: true, max: 4096, name: 'Credential' });
  const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
  const info = await resp.json().catch(() => ({}));
  if (!resp.ok || info.aud !== config.googleClientId || info.email_verified !== 'true') throw bad('Login Google gagal.');
  const email = String(info.email).toLowerCase();
  let u = await db.one('SELECT id, aktif FROM users WHERE google_sub=$1 OR email=$2 ORDER BY (google_sub=$1) DESC LIMIT 1', [info.sub, email]);
  if (u && !u.aktif) throw forbidden('Akun dinonaktifkan.');
  if (u) {
    await db.q('UPDATE users SET google_sub=$2 WHERE id=$1 AND google_sub IS NULL', [u.id, info.sub]);
  } else {
    const studioNama = str(req.body.studio_nama, { max: 80 }) || `Studio ${info.name || email.split('@')[0]}`;
    u = await db.tx(async (c) => {
      const st = (await c.query('INSERT INTO studios(nama, slug) VALUES ($1,$2) RETURNING id', [studioNama, await uniqueSlug(studioNama)])).rows[0];
      await seedPakets(c, st.id);
      return (await c.query("INSERT INTO users(studio_id, nama, email, google_sub, peran) VALUES ($1,$2,$3,$4,'owner') RETURNING id",
        [st.id, info.name || email, email, info.sub])).rows[0];
    });
  }
  await createLogin(req, res, u.id);
  res.json({ ok: true });
}));

r.post('/auth/logout', ah(async (req, res) => { await destroyLogin(req, res); res.json({ ok: true }); }));

r.get('/auth/invite/:token', ah(async (req, res) => {
  const inv = await db.one(`SELECT i.email, i.peran, s.nama AS studio_nama FROM invites i JOIN studios s ON s.id=i.studio_id
    WHERE i.token_hash=$1 AND i.dipakai_pada IS NULL AND i.kedaluwarsa > now()`, [sha256(req.params.token)]);
  if (!inv) throw notFound('Undangan tidak berlaku atau sudah dipakai.');
  res.json(inv);
}));
r.post('/auth/invite/accept', limit('auth', 20, 15 * 60), ah(async (req, res) => {
  const token = str(req.body.token, { required: true, max: 100, name: 'Token' });
  const nama = str(req.body.nama, { required: true, max: 80, name: 'Nama' });
  const password = String(req.body.password || '');
  if (password.length < 8) throw bad('Kata sandi minimal 8 karakter.');
  const hash = await hashPassword(password);
  const user = await db.tx(async (c) => {
    const inv = (await c.query(`SELECT * FROM invites WHERE token_hash=$1 AND dipakai_pada IS NULL AND kedaluwarsa > now() FOR UPDATE`, [sha256(token)])).rows[0];
    if (!inv) throw notFound('Undangan tidak berlaku atau sudah dipakai.');
    const ex = (await c.query('SELECT id FROM users WHERE email=$1', [inv.email])).rows[0];
    if (ex) throw bad('Email undangan sudah punya akun.');
    await c.query('UPDATE invites SET dipakai_pada=now() WHERE id=$1', [inv.id]);
    return (await c.query('INSERT INTO users(studio_id, nama, email, password_hash, peran) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [inv.studio_id, nama, inv.email, hash, inv.peran])).rows[0];
  });
  await createLogin(req, res, user.id);
  res.json({ ok: true });
}));

// ---------- Semua di bawah ini butuh login ----------
r.use(requireUser());

r.get('/me', ah(async (req, res) => {
  const st = await db.one('SELECT * FROM studios WHERE id=$1', [req.user.studio_id]);
  const unread = await db.one('SELECT count(*)::int AS n FROM notifikasis WHERE studio_id=$1 AND NOT dibaca', [req.user.studio_id]);
  const masuk = await db.one(`SELECT count(*)::int AS n FROM sesis WHERE studio_id=$1 AND status='terkirim' AND editor_status='antre'`, [req.user.studio_id]);
  res.json({
    user: { id: req.user.id, nama: req.user.nama, email: req.user.email, peran: req.user.peran, google_terhubung: req.user.google_terhubung },
    studio: studioOut(st),
    izin: Object.fromEntries(['studio.edit', 'tim.kelola', 'paket.kelola', 'paket.lihat', 'sesi.kelola', 'sesi.hapus', 'tagihan.kelola', 'editor.kerja'].map((p) => [p, can(req.user, p)])),
    notif_belum_dibaca: unread.n,
    pilihan_baru: masuk.n,
  });
}));

function studioOut(st) {
  return {
    id: st.id, nama: st.nama, slug: st.slug, warna: st.warna, no_wa: st.no_wa, zona_waktu: st.zona_waktu,
    watermark: st.watermark, retensi_hari: st.retensi_hari, format_salin: st.format_salin, template_wa: st.template_wa,
    logo_url: st.logo_path ? `/logo/${st.id}?v=${encodeURIComponent(path.basename(st.logo_path))}` : null,
  };
}

r.put('/me', ah(async (req, res) => {
  const nama = str(req.body.nama, { required: true, max: 80, name: 'Nama' });
  await db.q('UPDATE users SET nama=$2 WHERE id=$1', [req.user.id, nama]);
  if (req.body.password_baru) {
    const u = await db.one('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    if (u.password_hash && !(await checkPassword(String(req.body.password_lama || ''), u.password_hash))) throw bad('Kata sandi lama salah.');
    if (String(req.body.password_baru).length < 8) throw bad('Kata sandi minimal 8 karakter.');
    await db.q('UPDATE users SET password_hash=$2 WHERE id=$1', [req.user.id, await hashPassword(String(req.body.password_baru))]);
    await db.q('DELETE FROM user_sessions WHERE user_id=$1 AND token_hash<>$2', [req.user.id, req.user.sid]);
  }
  res.json({ ok: true });
}));

r.get('/me/devices', ah(async (req, res) => {
  const rows = await db.many('SELECT token_hash, user_agent, dibuat_pada FROM user_sessions WHERE user_id=$1 AND kedaluwarsa>now() ORDER BY dibuat_pada DESC', [req.user.id]);
  res.json(rows.map((x) => ({ id: x.token_hash.slice(0, 16), user_agent: x.user_agent, dibuat_pada: x.dibuat_pada, ini: x.token_hash === req.user.sid })));
}));
r.delete('/me/devices/:id', ah(async (req, res) => {
  await db.q("DELETE FROM user_sessions WHERE user_id=$1 AND left(token_hash,16)=$2 AND token_hash<>$3", [req.user.id, req.params.id, req.user.sid]);
  res.json({ ok: true });
}));

// ---------- Studio ----------
r.get('/studio', ah(async (req, res) => {
  res.json(studioOut(await db.one('SELECT * FROM studios WHERE id=$1', [req.user.studio_id])));
}));
r.put('/studio', requireUser('studio.edit'), ah(async (req, res) => {
  const b = req.body;
  const nama = str(b.nama, { required: true, max: 80, name: 'Nama studio' });
  const warna = /^#[0-9a-fA-F]{6}$/.test(b.warna || '') ? b.warna : '#005F73';
  const zona = ZONA.includes(b.zona_waktu) ? b.zona_waktu : 'Asia/Jakarta';
  const fmt = FORMAT_KEYS.includes(b.format_salin) ? b.format_salin : 'lightroom';
  const slug = b.slug ? slugify(b.slug) : null;
  if (slug && await db.one('SELECT 1 FROM studios WHERE slug=$1 AND id<>$2', [slug, req.user.studio_id])) throw bad('Alamat galeri sudah dipakai studio lain.');
  await db.q(`UPDATE studios SET nama=$2, warna=$3, no_wa=$4, zona_waktu=$5, watermark=$6, retensi_hari=$7, format_salin=$8,
    template_wa=$9, slug=COALESCE($10, slug) WHERE id=$1`, [req.user.studio_id, nama, warna, b.no_wa ? normWa(b.no_wa) : null, zona,
    str(b.watermark, { max: 60 }) || null, int(b.retensi_hari, { min: 1, max: 365, def: 30, name: 'Retensi' }), fmt,
    str(b.template_wa, { max: 1000 }) || null, slug]);
  res.json({ ok: true });
}));
r.post('/studio/logo', requireUser('studio.edit'), ah(async (req, res) => {
  const m = String(req.body.data_url || '').match(/^data:image\/(png|jpeg|webp|svg\+xml);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw bad('Format logo harus PNG, JPG, WEBP, atau SVG.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2 * 1024 * 1024) throw bad('Logo maksimal 2 MB.');
  const sharp = require('sharp');
  const out = await sharp(buf).resize(400, 400, { fit: 'inside' }).png().toBuffer().catch(() => { throw bad('Gambar logo tidak bisa dibaca.'); });
  const dir = path.join(config.dataDir, 'logos');
  await fs.promises.mkdir(dir, { recursive: true });
  const name = `${req.user.studio_id}-${Date.now()}.png`;
  await fs.promises.writeFile(path.join(dir, name), out);
  const old = await db.one('SELECT logo_path FROM studios WHERE id=$1', [req.user.studio_id]);
  await db.q('UPDATE studios SET logo_path=$2 WHERE id=$1', [req.user.studio_id, name]);
  if (old && old.logo_path) fs.promises.rm(path.join(dir, path.basename(old.logo_path)), { force: true }).catch(() => {});
  res.json({ ok: true });
}));

// ---------- Tim ----------
r.get('/tim', requireUser('sesi.lihat'), ah(async (req, res) => {
  const users = await db.many('SELECT id, nama, email, peran, aktif, dibuat_pada FROM users WHERE studio_id=$1 ORDER BY id', [req.user.studio_id]);
  const invites = can(req.user, 'tim.kelola')
    ? await db.many('SELECT id, email, peran, kedaluwarsa FROM invites WHERE studio_id=$1 AND dipakai_pada IS NULL AND kedaluwarsa>now() ORDER BY id DESC', [req.user.studio_id])
    : [];
  res.json({ users, invites });
}));
r.post('/tim/undang', requireUser('tim.kelola'), ah(async (req, res) => {
  const email = str(req.body.email, { required: true, max: 160, name: 'Email' }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw bad('Email tidak valid.');
  const peran = ['admin', 'editor'].includes(req.body.peran) ? req.body.peran : 'admin';
  if (await db.one('SELECT 1 FROM users WHERE email=$1', [email])) throw bad('Email ini sudah punya akun.');
  const token = randomToken(24);
  await db.q(`INSERT INTO invites(studio_id, email, peran, token_hash, kedaluwarsa) VALUES ($1,$2,$3,$4, now()+interval '7 days')`,
    [req.user.studio_id, email, peran, sha256(token)]);
  res.json({ ok: true, link: `${config.baseUrl}/undangan/${token}` });
}));
r.delete('/tim/undang/:id', requireUser('tim.kelola'), ah(async (req, res) => {
  await db.q('DELETE FROM invites WHERE id=$1 AND studio_id=$2', [req.params.id, req.user.studio_id]);
  res.json({ ok: true });
}));
r.put('/tim/:id', requireUser('tim.kelola'), ah(async (req, res) => {
  const u = await db.one('SELECT * FROM users WHERE id=$1 AND studio_id=$2', [req.params.id, req.user.studio_id]);
  if (!u) throw notFound();
  if (u.peran === 'owner') throw bad('Peran owner tidak bisa diubah di sini.');
  const peran = ['admin', 'editor'].includes(req.body.peran) ? req.body.peran : u.peran;
  const aktif = req.body.aktif === undefined ? u.aktif : bool(req.body.aktif);
  await db.q('UPDATE users SET peran=$2, aktif=$3 WHERE id=$1', [u.id, peran, aktif]);
  if (!aktif) await db.q('DELETE FROM user_sessions WHERE user_id=$1', [u.id]);
  res.json({ ok: true });
}));

// ---------- Paket ----------
function paketIn(b) {
  return {
    nama: str(b.nama, { required: true, max: 80, name: 'Nama paket' }),
    kuota: int(b.kuota, { min: 1, max: 5000, name: 'Kuota' }),
    durasi_pilih_menit: int(b.durasi_pilih_menit, { min: 0, max: 7 * 24 * 60, def: 0, name: 'Durasi pilih' }),
    masa_aktif_jam: int(b.masa_aktif_jam, { min: 1, max: 24 * 365, def: 168, name: 'Masa aktif' }),
    harga_foto_tambahan: int(b.harga_foto_tambahan, { min: 0, max: 100000000, def: 0, name: 'Harga foto tambahan' }),
    maks_foto_tambahan: int(b.maks_foto_tambahan, { min: 0, max: 5000, def: 0, name: 'Batas foto tambahan' }),
  };
}
r.get('/pakets', requireUser('sesi.lihat'), ah(async (req, res) => {
  res.json(await db.many('SELECT * FROM pakets WHERE studio_id=$1 AND NOT arsip ORDER BY nama', [req.user.studio_id]));
}));
r.post('/pakets', requireUser('paket.kelola'), ah(async (req, res) => {
  const p = paketIn(req.body);
  const row = await db.one(`INSERT INTO pakets(studio_id, nama, kuota, durasi_pilih_menit, masa_aktif_jam, harga_foto_tambahan, maks_foto_tambahan)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [req.user.studio_id, p.nama, p.kuota, p.durasi_pilih_menit, p.masa_aktif_jam, p.harga_foto_tambahan, p.maks_foto_tambahan]);
  res.json(row);
}));
r.put('/pakets/:id', requireUser('paket.kelola'), ah(async (req, res) => {
  const p = paketIn(req.body);
  const row = await db.one(`UPDATE pakets SET nama=$3, kuota=$4, durasi_pilih_menit=$5, masa_aktif_jam=$6, harga_foto_tambahan=$7, maks_foto_tambahan=$8
    WHERE id=$1 AND studio_id=$2 RETURNING *`, [req.params.id, req.user.studio_id, p.nama, p.kuota, p.durasi_pilih_menit, p.masa_aktif_jam, p.harga_foto_tambahan, p.maks_foto_tambahan]);
  if (!row) throw notFound();
  res.json(row);
}));
r.delete('/pakets/:id', requireUser('paket.kelola'), ah(async (req, res) => {
  await db.q('UPDATE pakets SET arsip=true WHERE id=$1 AND studio_id=$2', [req.params.id, req.user.studio_id]);
  res.json({ ok: true });
}));

// ---------- Drive ----------
function sourceFromBody(b) {
  const sumber = b.sumber;
  if (sumber === 'contoh') {
    if (!config.allowDemoSource) throw bad('Sumber contoh dinonaktifkan.');
    const n = int(b.jumlah_contoh, { min: 1, max: 500, def: 48, name: 'Jumlah foto contoh' });
    return { sumber, folderId: `contoh:${n}`, resourceKey: null };
  }
  if (!['service_account', 'link_publik'].includes(sumber)) throw bad('Metode akses folder tidak dikenal.');
  const parsed = b.folder_id ? { folderId: String(b.folder_id), resourceKey: b.resource_key || null } : drive.parseFolderLink(b.link);
  if (!parsed || !/^[A-Za-z0-9_-]{5,}$/.test(parsed.folderId)) throw bad('Link folder Google Drive tidak dikenali.');
  return { sumber, ...parsed };
}

r.post('/drive/cek', requireUser('sesi.kelola'), limit('drive', 60, 60), ah(async (req, res) => {
  const ctx = sourceFromBody(req.body);
  if (ctx.sumber === 'contoh') {
    const n = parseInt(ctx.folderId.split(':')[1], 10);
    return res.json({ ok: true, nama: 'Folder contoh', jumlah: n + (n >= 4 ? 1 : 0), contoh: true });
  }
  const out = await drive.checkAccess(ctx);
  if (!out.ok) return res.json(out);
  // Hitung isi folder untuk pratinjau penomoran
  try {
    const files = sync.sortFiles(await drive.listImages(ctx), req.body.urutan === 'waktu' ? 'waktu' : 'nama');
    const total = files.reduce((a, f) => a + (f.size || 0), 0);
    res.json({ ok: true, nama: out.nama, jumlah: files.length, pertama: files[0] && files[0].name, terakhir: files.length ? files[files.length - 1].name : null,
      ukuran: total, contoh_nama: files.slice(0, 6).map((f) => f.name) });
  } catch (e) {
    res.json({ ok: false, error: e.message, langkah: ['Coba lagi beberapa saat lagi.'] });
  }
}));

// F-51: setelah studio memilih folder di Google Picker, bagikan folder ke service account memakai token drive.file
r.post('/drive/bagikan', requireUser('sesi.kelola'), ah(async (req, res) => {
  const token = str(req.body.access_token, { required: true, max: 4096, name: 'Token' });
  const folderId = str(req.body.folder_id, { required: true, max: 200, name: 'Folder' });
  try {
    await drive.shareFolderWithServiceAccount(token, folderId);
  } catch (e) {
    throw bad(`Gagal membagikan folder otomatis: ${e.message}. Bagikan manual ke ${drive.serviceAccountEmail()} sebagai Viewer.`);
  }
  res.json({ ok: true });
}));

// ---------- Sesi ----------
function statusTampil(s) {
  if (s.status === 'terkirim' && s.dikirim_otomatis) return 'waktu_habis';
  return s.status;
}

async function loadSesi(req, id) {
  const sesiId = parseInt(id, 10);
  if (!Number.isInteger(sesiId)) throw notFound();
  await S.enforce(sesiId);
  const extra = req.user.peran === 'editor' ? ' AND (s.editor_id = $3 OR s.editor_id IS NULL)' : '';
  const params = [sesiId, req.user.studio_id];
  if (extra) params.push(req.user.id);
  const s = await db.one(`SELECT s.*, p.nama AS pelanggan_nama, p.no_wa AS pelanggan_wa, pk.nama AS paket_nama
    FROM sesis s JOIN pelanggans p ON p.id=s.pelanggan_id LEFT JOIN pakets pk ON pk.id=s.paket_id
    WHERE s.id=$1 AND s.studio_id=$2${extra}`, params);
  if (!s) throw notFound('Sesi tidak ditemukan.');
  return s;
}

function sesiRow(s) {
  return {
    id: s.id, judul: s.judul, jenis: s.jenis, tanggal_sesi: s.tanggal_sesi, status: statusTampil(s), status_db: s.status,
    pelanggan_nama: s.pelanggan_nama, pelanggan_wa: s.pelanggan_wa, paket_nama: s.paket_nama, paket_id: s.paket_id,
    kuota: s.kuota, durasi_pilih_menit: s.durasi_pilih_menit, masa_aktif_jam: s.masa_aktif_jam,
    harga_foto_tambahan: s.harga_foto_tambahan, maks_foto_tambahan: s.maks_foto_tambahan,
    tampil_nama_file: s.tampil_nama_file, izin_catatan: s.izin_catatan,
    sumber: s.sumber, urutan: s.urutan, sinkron_status: s.sinkron_status, sinkron_total: s.sinkron_total,
    sinkron_selesai: s.sinkron_selesai, sinkron_error: s.sinkron_error, sinkron_pada: s.sinkron_pada,
    tenggat_link: s.tenggat_link, link_dikirim_pada: s.link_dikirim_pada, dibuka_pada: s.dibuka_pada, jumlah_dibuka: s.jumlah_dibuka,
    mulai_pilih_pada: s.mulai_pilih_pada, berakhir_pada: s.berakhir_pada, dikirim_pada: s.dikirim_pada, dikirim_otomatis: s.dikirim_otomatis,
    minta_waktu_pada: s.minta_waktu_pada, catatan_umum: s.catatan_umum, editor_id: s.editor_id, editor_status: s.editor_status,
    dibuat_pada: s.dibuat_pada, jumlah_foto: s.jumlah_foto, jumlah_pilihan: s.jumlah_pilihan, cover: s.cover,
  };
}

r.get('/sesis', requireUser('sesi.lihat'), ah(async (req, res) => {
  const params = [req.user.studio_id];
  let where = 's.studio_id=$1';
  if (req.user.peran === 'editor') { params.push(req.user.id); where += ` AND (s.editor_id=$${params.length} OR s.editor_id IS NULL)`; }
  if (req.query.q) { params.push(`%${String(req.query.q).slice(0, 80)}%`); where += ` AND (s.judul ILIKE $${params.length} OR p.nama ILIKE $${params.length} OR p.no_wa ILIKE $${params.length})`; }
  const st = String(req.query.status || '');
  if (st === 'waktu_habis') where += " AND s.status='terkirim' AND s.dikirim_otomatis";
  else if (st === 'aktif') where += " AND s.status IN ('siap','dibuka','memilih')";
  else if (st === 'masuk') where += " AND s.status='terkirim'";
  else if (st === 'segera') where += " AND s.status IN ('siap','dibuka') AND s.tenggat_link < now() + interval '48 hours'";
  else if (st) { params.push(st); where += ` AND s.status=$${params.length}`; }
  const order = { tenggat: 's.tenggat_link ASC NULLS LAST', nama: 's.judul ASC' }[req.query.urut] || 's.dibuat_pada DESC';
  const lim = int(req.query.limit, { min: 1, max: 500, def: 200 });
  const rows = await db.many(`SELECT s.*, p.nama AS pelanggan_nama, p.no_wa AS pelanggan_wa, pk.nama AS paket_nama,
      (SELECT count(*)::int FROM fotos f WHERE f.sesi_id=s.id AND NOT f.dihapus) AS jumlah_foto,
      (SELECT count(*)::int FROM pilihans x WHERE x.sesi_id=s.id) AS jumlah_pilihan,
      (SELECT f.id FROM fotos f WHERE f.sesi_id=s.id AND NOT f.dihapus AND f.thumb_siap ORDER BY f.nomor LIMIT 1) AS cover_id
    FROM sesis s JOIN pelanggans p ON p.id=s.pelanggan_id LEFT JOIN pakets pk ON pk.id=s.paket_id
    WHERE ${where} ORDER BY ${order} LIMIT ${lim}`, params);
  // Terapkan aturan waktu secara malas untuk baris yang kedaluwarsa
  const stale = rows.filter((s) => (s.status === 'memilih' && s.berakhir_pada && new Date(s.berakhir_pada) < Date.now() - S.GRACE_MS)
    || (['siap', 'dibuka'].includes(s.status) && s.tenggat_link && new Date(s.tenggat_link) < Date.now()));
  if (stale.length) {
    await Promise.all(stale.map((s) => S.enforce(s.id)));
    const fresh = await db.many('SELECT id, status, dikirim_otomatis, dikirim_pada FROM sesis WHERE id = ANY($1)', [stale.map((s) => s.id)]);
    fresh.forEach((f) => Object.assign(rows.find((x) => x.id === f.id), f));
  }
  res.json(rows.map((s) => ({ ...sesiRow(s), cover: s.cover_id ? media.url(s.id, s.cover_id, 'thumb') : null })));
}));

function waText(studio, s, link, pin) {
  const tz = studio.zona_waktu || 'Asia/Jakarta';
  const tenggat = s.tenggat_link ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'full', timeStyle: 'short', timeZone: tz }).format(new Date(s.tenggat_link)) : '-';
  const zona = { 'Asia/Jakarta': 'WIB', 'Asia/Makassar': 'WITA', 'Asia/Jayapura': 'WIT' }[tz] || '';
  const durasi = s.durasi_pilih_menit > 0 ? `Waktu memilih: ${s.durasi_pilih_menit} menit sejak menekan "Mulai pilih".` : '';
  const tambahan = s.maks_foto_tambahan > 0 && s.harga_foto_tambahan > 0
    ? `Foto tambahan: ${F.rupiah(s.harga_foto_tambahan)}/foto (maks ${s.maks_foto_tambahan}).` : '';
  const tpl = studio.template_wa || 'Halo Kak {nama}, foto sesi {judul} dari {studio} sudah siap dipilih.\n\nLink: {link}\nPIN: {pin}\nPilih {kuota} foto favorit.\n{durasi}\n{tambahan}\nBatas waktu: {tenggat} {zona}\n\nTerima kasih!';
  return tpl.replace(/\{(\w+)\}/g, (m, k) => ({
    nama: s.pelanggan_nama, judul: s.judul, studio: studio.nama, link, pin, kuota: s.kuota, durasi, tambahan, tenggat, zona,
  }[k] ?? m)).replace(/\n{3,}/g, '\n\n').trim();
}

r.post('/sesis', requireUser('sesi.kelola'), ah(async (req, res) => {
  const b = req.body;
  const pelangganNama = str(b.pelanggan_nama, { required: true, max: 80, name: 'Nama pelanggan' });
  const wa = b.pelanggan_wa ? normWa(b.pelanggan_wa) : null;
  let paket = null;
  if (b.paket_id) {
    paket = await db.one('SELECT * FROM pakets WHERE id=$1 AND studio_id=$2', [b.paket_id, req.user.studio_id]);
    if (!paket) throw bad('Paket tidak ditemukan.');
  }
  // F-04: nilai paket disalin ke sesi dan boleh diubah per sesi
  const v = paketIn({ ...(paket || {}), nama: (paket && paket.nama) || 'Kustom', ...pick(b, ['kuota', 'durasi_pilih_menit', 'masa_aktif_jam', 'harga_foto_tambahan', 'maks_foto_tambahan']) });
  const src = sourceFromBody(b);
  const pin = b.pin ? String(b.pin) : randomPin(6);
  if (!/^\d{4,6}$/.test(pin)) throw bad('PIN harus 4–6 digit angka.');
  const token = randomToken(16); // 128 bit
  const judul = str(b.judul, { max: 120 }) || pelangganNama;
  const row = await db.tx(async (c) => {
    let pel = wa ? (await c.query('SELECT id FROM pelanggans WHERE studio_id=$1 AND no_wa=$2 AND nama=$3', [req.user.studio_id, wa, pelangganNama])).rows[0] : null;
    if (!pel) pel = (await c.query('INSERT INTO pelanggans(studio_id, nama, no_wa) VALUES ($1,$2,$3) RETURNING id', [req.user.studio_id, pelangganNama, wa])).rows[0];
    const s = (await c.query(`INSERT INTO sesis(studio_id, pelanggan_id, paket_id, judul, jenis, tanggal_sesi, kuota, durasi_pilih_menit, masa_aktif_jam,
        harga_foto_tambahan, maks_foto_tambahan, tampil_nama_file, izin_catatan, sumber, drive_folder_id, resource_key, urutan,
        token_hash, token_enc, pin_hash, pin_enc, tenggat_link, dibuat_oleh, sinkron_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21, now() + ($22 || ' hours')::interval, $23, 'menunggu') RETURNING *`,
    [req.user.studio_id, pel.id, paket ? paket.id : null, judul, str(b.jenis, { max: 60 }) || (paket && paket.nama) || null,
      /^\d{4}-\d{2}-\d{2}$/.test(b.tanggal_sesi || '') ? b.tanggal_sesi : null,
      v.kuota, v.durasi_pilih_menit, v.masa_aktif_jam, v.harga_foto_tambahan, v.maks_foto_tambahan,
      b.tampil_nama_file === undefined ? true : bool(b.tampil_nama_file), b.izin_catatan === undefined ? true : bool(b.izin_catatan),
      src.sumber, src.folderId, src.resourceKey, b.urutan === 'waktu' ? 'waktu' : 'nama',
      sha256(token), encrypt(token), sha256(`pin:${pin}`), encrypt(pin), String(v.masa_aktif_jam), req.user.id])).rows[0];
    await c.query('INSERT INTO tagihans(sesi_id) VALUES ($1)', [s.id]);
    await S.logEvent(c, s.id, 'dibuat', req.user.nama, { sumber: src.sumber });
    return s;
  });
  sync.startSync(row.id, req.user.nama);
  res.json({ id: row.id, link: galleryUrl(token), pin });
}));

function pick(o, keys) {
  const out = {};
  keys.forEach((k) => { if (o[k] !== undefined && o[k] !== '' && o[k] !== null) out[k] = o[k]; });
  return out;
}

r.get('/sesis/:id', requireUser('sesi.lihat'), ah(async (req, res) => {
  const s = await loadSesi(req, req.params.id);
  const studio = await db.one('SELECT * FROM studios WHERE id=$1', [s.studio_id]);
  const fotos = await db.many(`SELECT f.id, f.nomor, f.nama_file, f.path_subfolder, f.nama_kembar, f.dihapus, f.thumb_siap, f.thumb_error,
      p.catatan, p.is_tambahan, p.dipilih_pada, (p.foto_id IS NOT NULL) AS dipilih
    FROM fotos f LEFT JOIN pilihans p ON p.foto_id=f.id AND p.sesi_id=f.sesi_id WHERE f.sesi_id=$1 ORDER BY f.nomor`, [s.id]);
  const events = await db.many('SELECT jenis, aktor, detail, waktu FROM events WHERE sesi_id=$1 ORDER BY waktu DESC, id DESC LIMIT 200', [s.id]);
  const tagihan = await db.one('SELECT * FROM tagihans WHERE sesi_id=$1', [s.id]);
  const editors = await db.many("SELECT id, nama, peran FROM users WHERE studio_id=$1 AND aktif AND peran IN ('editor','owner','admin') ORDER BY nama", [s.studio_id]);
  const total = fotos.length ? fotos[fotos.length - 1].nomor : 0;
  const out = sesiRow({ ...s, jumlah_foto: fotos.filter((f) => !f.dihapus).length, jumlah_pilihan: fotos.filter((f) => f.dipilih).length });
  let link = null; let pin = null;
  if (can(req.user, 'sesi.kelola')) {
    const token = decrypt(s.token_enc);
    link = galleryUrl(token);
    pin = decrypt(s.pin_enc);
    out.wa_text = waText(studio, s, link, pin);
    out.wa_url = s.pelanggan_wa ? `https://wa.me/${s.pelanggan_wa}?text=${encodeURIComponent(out.wa_text)}` : `https://wa.me/?text=${encodeURIComponent(out.wa_text)}`;
  }
  out.link = link; out.pin = pin;
  out.nomor_total = total;
  out.drive_folder_url = s.sumber === 'contoh' ? null : `https://drive.google.com/drive/folders/${s.drive_folder_id}${s.resource_key ? `?resourcekey=${s.resource_key}` : ''}`;
  out.fotos = fotos.map((f) => ({ ...f, thumb: media.url(s.id, f.id, 'thumb'), preview: media.url(s.id, f.id, 'preview') }));
  out.events = events;
  out.tagihan = tagihan;
  out.editors = editors;
  out.server_now = new Date().toISOString();
  res.json(out);
}));

r.put('/sesis/:id', requireUser('sesi.kelola'), ah(async (req, res) => {
  const s = await loadSesi(req, req.params.id);
  const b = req.body;
  const v = paketIn({ nama: 'x', ...pick(s, ['kuota', 'durasi_pilih_menit', 'masa_aktif_jam', 'harga_foto_tambahan', 'maks_foto_tambahan']),
    ...pick(b, ['kuota', 'durasi_pilih_menit', 'harga_foto_tambahan', 'maks_foto_tambahan']) });
  const judul = str(b.judul ?? s.judul, { required: true, max: 120, name: 'Judul' });
  await db.tx(async (c) => {
    await c.query(`UPDATE sesis SET judul=$2, jenis=$3, kuota=$4, durasi_pilih_menit=$5, harga_foto_tambahan=$6, maks_foto_tambahan=$7,
      tampil_nama_file=$8, izin_catatan=$9 WHERE id=$1`,
    [s.id, judul, str(b.jenis ?? s.jenis, { max: 60 }) || null, v.kuota, v.durasi_pilih_menit, v.harga_foto_tambahan, v.maks_foto_tambahan,
      b.tampil_nama_file === undefined ? s.tampil_nama_file : bool(b.tampil_nama_file), b.izin_catatan === undefined ? s.izin_catatan : bool(b.izin_catatan)]);
    if (b.pelanggan_nama || b.pelanggan_wa !== undefined) {
      await c.query('UPDATE pelanggans SET nama=COALESCE($2,nama), no_wa=$3 WHERE id=$1',
        [s.pelanggan_id, str(b.pelanggan_nama, { max: 80 }) || null, b.pelanggan_wa ? normWa(b.pelanggan_wa) : null]);
    }
    await S.recomputeTagihan(c, { ...s, kuota: v.kuota, harga_foto_tambahan: v.harga_foto_tambahan });
    await S.logEvent(c, s.id, 'ubah', req.user.nama, null);
  });
  res.json({ ok: true });
}));

r.post('/sesis/:id/sinkron', requireUser('sesi.kelola'), ah(async (req, res) => {
  const s = await loadSesi(req, req.params.id);
  if (!sync.isRunning(s.id)) {
    await db.q("UPDATE sesis SET sinkron_status='menunggu' WHERE id=$1", [s.id]);
    sync.startSync(s.id, req.user.nama);
  }
  res.json({ ok: true });
}));

r.post('/sesis/:id/pin', requireUser('sesi.kelola'), ah(async (req, res) => {
  const s = await loadSesi(req, req.params.id);
  const pin = req.body.pin ? String(req.body.pin) : randomPin(6);
  if (!/^\d{4,6}$/.test(pin)) throw bad('PIN harus 4–6 digit angka.');
  await db.q('UPDATE sesis SET pin_hash=$2, pin_enc=$3 WHERE id=$1', [s.id, sha256(`pin:${pin}`), encrypt(pin)]);
  await db.q('DELETE FROM pin_attempts WHERE sesi_id=$1', [s.id]);
  await db.q('DELETE FROM client_sessions WHERE sesi_id=$1', [s.id]);
  await S.logEvent(null, s.id, 'ganti_pin', req.user.nama, null);
  res.json({ ok: true, pin });
}));

// Aksi admin pada timer & status (F-32, F-25, F-27)
r.post('/sesis/:id/aksi', requireUser('sesi.kelola'), ah(async (req, res) => {
  const sesiId = (await loadSesi(req, req.params.id)).id;
  const aksi = String(req.body.aksi || '');
  const menit = int(req.body.menit, { min: 1, max: 24 * 60, def: 15, name: 'Menit' });
  const jam = int(req.body.jam, { min: 1, max: 24 * 90, def: 24, name: 'Jam' });
  const nama = req.user.nama;
  await db.tx(async (c) => {
    const s = (await c.query('SELECT * FROM sesis WHERE id=$1 FOR UPDATE', [sesiId])).rows[0];
    switch (aksi) {
      case 'tambah_waktu': {
        if (s.status !== 'memilih') throw bad('Timer tidak sedang berjalan. Gunakan "Buka ulang" untuk sesi yang sudah terkirim.');
        await c.query("UPDATE sesis SET berakhir_pada = GREATEST(berakhir_pada, now()) + ($2 || ' minutes')::interval, minta_waktu_pada=NULL WHERE id=$1", [s.id, String(menit)]);
        await S.logEvent(c, s.id, 'perpanjang', nama, { menit });
        break;
      }
      case 'perpanjang_link': {
        await c.query(`UPDATE sesis SET tenggat_link = GREATEST(COALESCE(tenggat_link, now()), now()) + ($2 || ' hours')::interval,
          status = CASE WHEN status='kedaluwarsa' THEN (CASE WHEN dibuka_pada IS NULL THEN 'siap' ELSE 'dibuka' END) ELSE status END WHERE id=$1`, [s.id, String(jam)]);
        await S.logEvent(c, s.id, 'perpanjang_link', nama, { jam });
        break;
      }
      case 'buka_ulang': {
        if (!['terkirim', 'selesai', 'kedaluwarsa'].includes(s.status)) throw bad('Sesi belum terkirim/kedaluwarsa.');
        const berakhir = s.durasi_pilih_menit > 0 ? `now() + interval '${menit} minutes'` : `GREATEST(tenggat_link, now() + interval '${jam} hours')`;
        await c.query(`UPDATE sesis SET status='memilih', dikirim_pada=NULL, dikirim_otomatis=false, mulai_pilih_pada=COALESCE(mulai_pilih_pada, now()),
          berakhir_pada=${berakhir}, tenggat_link=GREATEST(tenggat_link, ${berakhir}), editor_status='antre', minta_waktu_pada=NULL WHERE id=$1`, [s.id]);
        await S.logEvent(c, s.id, 'buka_ulang', nama, s.durasi_pilih_menit > 0 ? { menit } : { jam });
        break;
      }
      case 'reset_timer': {
        if (!['memilih', 'terkirim', 'kedaluwarsa', 'dibuka'].includes(s.status)) throw bad('Tidak ada timer untuk di-reset.');
        await c.query(`UPDATE sesis SET status=CASE WHEN dibuka_pada IS NULL THEN 'siap' ELSE 'dibuka' END, mulai_pilih_pada=NULL, berakhir_pada=NULL,
          dikirim_pada=NULL, dikirim_otomatis=false, minta_waktu_pada=NULL,
          tenggat_link=GREATEST(tenggat_link, now() + interval '1 hour') WHERE id=$1`, [s.id]);
        await S.logEvent(c, s.id, 'reset_timer', nama, null);
        break;
      }
      case 'link_dikirim': {
        await c.query('UPDATE sesis SET link_dikirim_pada=COALESCE(link_dikirim_pada, now()) WHERE id=$1', [s.id]);
        await S.logEvent(c, s.id, 'link_dikirim', nama, { lewat: 'whatsapp' });
        break;
      }
      case 'tolak_minta_waktu': {
        await c.query('UPDATE sesis SET minta_waktu_pada=NULL WHERE id=$1', [s.id]);
        await S.logEvent(c, s.id, 'tolak_minta_waktu', nama, null);
        break;
      }
      default: throw bad('Aksi tidak dikenal.');
    }
  });
  res.json({ ok: true });
}));

r.put('/sesis/:id/tagihan', requireUser('tagihan.kelola'), ah(async (req, res) => {
  const s = await loadSesi(req, req.params.id);
  const status = req.body.status_bayar === 'lunas' ? 'lunas' : 'belum_bayar';
  await db.q(`UPDATE tagihans SET status_bayar=$2, metode=$3, diubah_pada=now() WHERE sesi_id=$1`, [s.id, status, str(req.body.metode, { max: 40 }) || null]);
  await S.logEvent(null, s.id, 'bayar', req.user.nama, { status_bayar: status, metode: req.body.metode || null });
  res.json({ ok: true });
}));

r.put('/sesis/:id/editor', requireUser('editor.kerja'), ah(async (req, res) => {
  const s = await loadSesi(req, req.params.id);
  const st = ['antre', 'dikerjakan', 'selesai'].includes(req.body.editor_status) ? req.body.editor_status : s.editor_status;
  let editorId = s.editor_id;
  if (req.body.editor_id !== undefined && can(req.user, 'sesi.kelola')) {
    editorId = req.body.editor_id ? parseInt(req.body.editor_id, 10) : null;
    if (editorId && !(await db.one('SELECT 1 FROM users WHERE id=$1 AND studio_id=$2', [editorId, req.user.studio_id]))) throw bad('Editor tidak ditemukan.');
  } else if (req.user.peran === 'editor' && !s.editor_id) {
    editorId = req.user.id; // editor mengambil sesi
  }
  const status = st === 'selesai' && s.status === 'terkirim' ? 'selesai' : (st !== 'selesai' && s.status === 'selesai' ? 'terkirim' : s.status);
  await db.q('UPDATE sesis SET editor_status=$2, editor_id=$3, status=$4 WHERE id=$1', [s.id, st, editorId, status]);
  await S.logEvent(null, s.id, 'editor', req.user.nama, { editor_status: st });
  res.json({ ok: true });
}));

r.delete('/sesis/:id', requireUser('sesi.hapus'), ah(async (req, res) => {
  const s = await loadSesi(req, req.params.id);
  await db.q('DELETE FROM sesis WHERE id=$1', [s.id]);
  await images.removeSesi(s.id);
  // Hapus pelanggan bila tidak punya sesi lain (UU PDP: hapus data atas permintaan)
  await db.q('DELETE FROM pelanggans p WHERE p.id=$1 AND NOT EXISTS (SELECT 1 FROM sesis WHERE pelanggan_id=p.id)', [s.pelanggan_id]);
  res.json({ ok: true });
}));

// Ekspor nama file (F-39)
async function selectedItems(sesiId) {
  return db.many(`SELECT f.nomor, f.nama_file, f.path_subfolder, f.nama_kembar, p.catatan, p.is_tambahan
    FROM pilihans p JOIN fotos f ON f.id=p.foto_id WHERE p.sesi_id=$1 ORDER BY f.nomor`, [sesiId]);
}
r.get('/sesis/:id/ekspor.:ext', requireUser('sesi.lihat'), ah(async (req, res) => {
  const s = await loadSesi(req, req.params.id);
  const items = await selectedItems(s.id);
  const total = (await db.one('SELECT COALESCE(max(nomor),0)::int AS m FROM fotos WHERE sesi_id=$1', [s.id])).m;
  const base = `pilihan-${slugify(s.judul)}-${s.id}`;
  if (req.params.ext === 'csv') {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${base}.csv"`);
    return res.send('﻿' + F.csv(items, total));
  }
  if (req.params.ext === 'txt') {
    const fmt = FORMAT_KEYS.includes(req.query.format) ? req.query.format : 'baris';
    let body = F.fileList(items, fmt, { total, ext: req.query.ext !== '0' });
    if (req.query.path === '1') body = items.map((i) => (i.path_subfolder ? `${i.path_subfolder}/` : '') + i.nama_file).join('\n');
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${base}.txt"`);
    return res.send(body + '\n');
  }
  throw notFound();
}));

// ---------- Dasbor, notifikasi ----------
r.get('/dasbor', requireUser('sesi.lihat'), ah(async (req, res) => {
  await S.sweep().catch(() => {});
  const id = req.user.studio_id;
  const c = await db.one(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE status IN ('siap','dibuka','memilih'))::int AS aktif,
      count(*) FILTER (WHERE status IN ('siap','dibuka') AND tenggat_link < now() + interval '48 hours')::int AS segera,
      count(*) FILTER (WHERE status='kedaluwarsa')::int AS kedaluwarsa,
      count(*) FILTER (WHERE status='terkirim')::int AS masuk,
      count(*) FILTER (WHERE status='terkirim' AND editor_status='antre')::int AS masuk_baru,
      count(*) FILTER (WHERE minta_waktu_pada IS NOT NULL AND status='memilih')::int AS minta_waktu
    FROM sesis WHERE studio_id=$1`, [id]);
  // Metrik PRD (30 hari terakhir)
  const m = await db.one(`SELECT
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM dikirim_pada - COALESCE(link_dikirim_pada, dibuat_pada))) AS median_detik,
      count(*) FILTER (WHERE dikirim_pada IS NOT NULL)::int AS terkirim,
      count(*) FILTER (WHERE dikirim_pada IS NOT NULL AND NOT dikirim_otomatis)::int AS tepat_waktu,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM events e WHERE e.sesi_id=s.id AND e.jenis='minta_waktu'))::int AS minta_waktu,
      count(*)::int AS semua
    FROM sesis s WHERE studio_id=$1 AND dibuat_pada > now() - interval '30 days'`, [id]);
  const t = await db.one(`SELECT count(*) FILTER (WHERE t.jumlah_foto > 0)::int AS dengan_tambahan,
      COALESCE(sum(t.total_rupiah) FILTER (WHERE t.status_bayar='lunas'),0)::bigint AS lunas,
      COALESCE(sum(t.total_rupiah) FILTER (WHERE t.status_bayar='belum_bayar' AND s.status IN ('terkirim','selesai')),0)::bigint AS belum
    FROM tagihans t JOIN sesis s ON s.id=t.sesi_id WHERE s.studio_id=$1 AND s.dibuat_pada > now() - interval '30 days'`, [id]);
  const aktivitas = await db.many(`SELECT n.id, n.jenis, n.pesan, n.dibuat_pada, n.sesi_id, n.dibaca FROM notifikasis n WHERE n.studio_id=$1
    ORDER BY n.dibuat_pada DESC LIMIT 8`, [id]);
  res.json({ ...c, metrik: { ...m, ...t }, aktivitas });
}));

r.get('/notifikasi', ah(async (req, res) => {
  res.json(await db.many('SELECT id, sesi_id, jenis, pesan, dibaca, dibuat_pada FROM notifikasis WHERE studio_id=$1 ORDER BY dibuat_pada DESC LIMIT 50', [req.user.studio_id]));
}));
r.post('/notifikasi/baca', ah(async (req, res) => {
  await db.q('UPDATE notifikasis SET dibaca=true WHERE studio_id=$1 AND NOT dibaca', [req.user.studio_id]);
  res.json({ ok: true });
}));

r.use((req, res, next) => next(new HttpError(404, 'Endpoint tidak ditemukan.')));

module.exports = r;
