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
const { hashPassword, checkPassword, createLogin, destroyLogin, currentUser, requireUser, requireSuperadmin, can } = require('../auth');
const QRCode = require('qrcode');
const { HttpError, bad, forbidden, notFound, ah, str, int, bool, setCookie } = require('../http');
const { limit } = require('../ratelimit');
const plans = require('../plans');
const wa = require('../wa');
const payment = require('../payment');

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
    superadmin: !!req.user.superadmin,
    cabang_id: req.user.cabang_id,
    cabangs: await db.many('SELECT id, nama FROM cabangs WHERE studio_id=$1 AND NOT arsip ORDER BY nama', [req.user.studio_id]),
    langganan: plans.summary(st),
    integrasi: { wa_api: wa.configured(st), payment: payment.enabled(), drive_sa: !!drive.serviceAccountEmail() },
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
  if (b.wa_otomatis !== undefined || b.template_hasil !== undefined) {
    await db.q('UPDATE studios SET wa_otomatis=COALESCE($2, wa_otomatis), template_hasil=$3 WHERE id=$1',
      [req.user.studio_id, b.wa_otomatis === undefined ? null : bool(b.wa_otomatis), str(b.template_hasil, { max: 1000 }) || null]);
  }
  if (b.wa_phone_number_id !== undefined) {
    const pid = str(b.wa_phone_number_id, { max: 40 });
    if (pid && !/^\d+$/.test(pid)) throw bad('Phone number ID WhatsApp harus angka.');
    await db.q('UPDATE studios SET wa_phone_number_id=$2 WHERE id=$1', [req.user.studio_id, pid || null]);
    if (b.wa_token) await db.q('UPDATE studios SET wa_token_enc=$2 WHERE id=$1', [req.user.studio_id, encrypt(String(b.wa_token).trim())]);
    if (!pid) await db.q('UPDATE studios SET wa_token_enc=NULL WHERE id=$1', [req.user.studio_id]);
  }
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
  const users = await db.many('SELECT id, nama, email, peran, aktif, cabang_id, dibuat_pada FROM users WHERE studio_id=$1 ORDER BY id', [req.user.studio_id]);
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
  await plans.checkUserLimit(await db.one('SELECT * FROM studios WHERE id=$1', [req.user.studio_id]));
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
  let cabangId = u.cabang_id;
  if (req.body.cabang_id !== undefined) {
    cabangId = req.body.cabang_id ? parseInt(req.body.cabang_id, 10) : null;
    if (cabangId && !(await db.one('SELECT 1 FROM cabangs WHERE id=$1 AND studio_id=$2', [cabangId, req.user.studio_id]))) throw bad('Cabang tidak ditemukan.');
  }
  await db.q('UPDATE users SET peran=$2, aktif=$3, cabang_id=$4 WHERE id=$1', [u.id, peran, aktif, cabangId]);
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
    harga_bertingkat: tiersIn(b.harga_bertingkat),
  };
}
// F-36: [{jumlah, harga}] atau teks "5=100000, 10=180000"
function tiersIn(v) {
  const arr = typeof v === 'string' ? F.parseTiers(v) : Array.isArray(v) ? v : [];
  return arr.slice(0, 10).map((t) => ({ jumlah: int(t.jumlah, { min: 1, max: 5000, name: 'Jumlah paket tambahan' }), harga: int(t.harga, { min: 0, max: 1e9, name: 'Harga paket tambahan' }) }))
    .sort((a, b) => a.jumlah - b.jumlah);
}
r.get('/pakets', requireUser('sesi.lihat'), ah(async (req, res) => {
  res.json(await db.many('SELECT * FROM pakets WHERE studio_id=$1 AND NOT arsip ORDER BY nama', [req.user.studio_id]));
}));
r.post('/pakets', requireUser('paket.kelola'), ah(async (req, res) => {
  const p = paketIn(req.body);
  const row = await db.one(`INSERT INTO pakets(studio_id, nama, kuota, durasi_pilih_menit, masa_aktif_jam, harga_foto_tambahan, maks_foto_tambahan, harga_bertingkat)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [req.user.studio_id, p.nama, p.kuota, p.durasi_pilih_menit, p.masa_aktif_jam, p.harga_foto_tambahan, p.maks_foto_tambahan, JSON.stringify(p.harga_bertingkat)]);
  res.json(row);
}));
r.put('/pakets/:id', requireUser('paket.kelola'), ah(async (req, res) => {
  const p = paketIn(req.body);
  const row = await db.one(`UPDATE pakets SET nama=$3, kuota=$4, durasi_pilih_menit=$5, masa_aktif_jam=$6, harga_foto_tambahan=$7, maks_foto_tambahan=$8, harga_bertingkat=$9
    WHERE id=$1 AND studio_id=$2 RETURNING *`, [req.params.id, req.user.studio_id, p.nama, p.kuota, p.durasi_pilih_menit, p.masa_aktif_jam, p.harga_foto_tambahan, p.maks_foto_tambahan, JSON.stringify(p.harga_bertingkat)]);
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
  const params = [sesiId, req.user.studio_id];
  let extra = '';
  if (req.user.peran === 'editor') { params.push(req.user.id); extra += ` AND (s.editor_id = $${params.length} OR s.editor_id IS NULL)`; }
  if (req.user.cabang_id) { params.push(req.user.cabang_id); extra += ` AND s.cabang_id = $${params.length}`; }
  const s = await db.one(`SELECT s.*, p.nama AS pelanggan_nama, p.no_wa AS pelanggan_wa, pk.nama AS paket_nama, cb.nama AS cabang_nama
    FROM sesis s JOIN pelanggans p ON p.id=s.pelanggan_id LEFT JOIN pakets pk ON pk.id=s.paket_id LEFT JOIN cabangs cb ON cb.id=s.cabang_id
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
    cabang_id: s.cabang_id, cabang_nama: s.cabang_nama, harga_bertingkat: s.harga_bertingkat || [],
    hasil_link: s.hasil_link, hasil_dikirim_pada: s.hasil_dikirim_pada, terpilih_status: s.terpilih_status, terpilih_info: s.terpilih_info,
  };
}

r.get('/sesis', requireUser('sesi.lihat'), ah(async (req, res) => {
  const params = [req.user.studio_id];
  let where = 's.studio_id=$1';
  if (req.user.peran === 'editor') { params.push(req.user.id); where += ` AND (s.editor_id=$${params.length} OR s.editor_id IS NULL)`; }
  if (req.user.cabang_id) { params.push(req.user.cabang_id); where += ` AND s.cabang_id=$${params.length}`; }
  else if (req.query.cabang) { params.push(parseInt(req.query.cabang, 10) || 0); where += ` AND s.cabang_id=$${params.length}`; }
  if (req.query.hari_ini === '1') where += " AND (s.tanggal_sesi = (now() AT TIME ZONE 'Asia/Jakarta')::date OR s.dibuat_pada > now() - interval '18 hours') AND s.status IN ('siap','dibuka','memilih')";
  if (req.query.q) { params.push(`%${String(req.query.q).slice(0, 80)}%`); where += ` AND (s.judul ILIKE $${params.length} OR p.nama ILIKE $${params.length} OR p.no_wa ILIKE $${params.length})`; }
  const st = String(req.query.status || '');
  if (st === 'waktu_habis') where += " AND s.status='terkirim' AND s.dikirim_otomatis";
  else if (st === 'aktif') where += " AND s.status IN ('siap','dibuka','memilih')";
  else if (st === 'masuk') where += " AND s.status='terkirim'";
  else if (st === 'segera') where += " AND s.status IN ('siap','dibuka') AND s.tenggat_link < now() + interval '48 hours'";
  else if (st) { params.push(st); where += ` AND s.status=$${params.length}`; }
  const order = { tenggat: 's.tenggat_link ASC NULLS LAST', nama: 's.judul ASC' }[req.query.urut] || 's.dibuat_pada DESC';
  const lim = int(req.query.limit, { min: 1, max: 500, def: 200 });
  const rows = await db.many(`SELECT s.*, p.nama AS pelanggan_nama, p.no_wa AS pelanggan_wa, pk.nama AS paket_nama, cb.nama AS cabang_nama,
      (SELECT count(*)::int FROM fotos f WHERE f.sesi_id=s.id AND NOT f.dihapus) AS jumlah_foto,
      (SELECT count(*)::int FROM pilihans x WHERE x.sesi_id=s.id) AS jumlah_pilihan,
      (SELECT f.id FROM fotos f WHERE f.sesi_id=s.id AND NOT f.dihapus AND f.thumb_siap ORDER BY f.nomor LIMIT 1) AS cover_id
    FROM sesis s JOIN pelanggans p ON p.id=s.pelanggan_id LEFT JOIN pakets pk ON pk.id=s.paket_id LEFT JOIN cabangs cb ON cb.id=s.cabang_id
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

// Buat satu sesi di dalam transaksi (dipakai form & CSV massal)
async function createSesiIn(c, user, studio, b) {
  const pelangganNama = str(b.pelanggan_nama, { required: true, max: 80, name: 'Nama pelanggan' });
  const wa = b.pelanggan_wa ? normWa(b.pelanggan_wa) : null;
  let paket = null;
  if (b.paket_id) {
    paket = (await c.query('SELECT * FROM pakets WHERE id=$1 AND studio_id=$2', [b.paket_id, studio.id])).rows[0];
    if (!paket) throw bad('Paket tidak ditemukan.');
  }
  // F-04: nilai paket disalin ke sesi dan boleh diubah per sesi
  const v = paketIn({ kuota: 10, ...(paket || {}), nama: (paket && paket.nama) || 'Kustom', ...pick(b, ['kuota', 'durasi_pilih_menit', 'masa_aktif_jam', 'harga_foto_tambahan', 'maks_foto_tambahan', 'harga_bertingkat']) });
  const src = sourceFromBody(b);
  const pin = b.pin ? String(b.pin) : randomPin(6);
  if (!/^\d{4,6}$/.test(pin)) throw bad('PIN harus 4–6 digit angka.');
  let cabangId = b.cabang_id ? parseInt(b.cabang_id, 10) : (user.cabang_id || null);
  if (user.cabang_id && cabangId !== user.cabang_id) throw forbidden('Kamu hanya bisa membuat sesi untuk cabangmu.');
  if (cabangId && !(await c.query('SELECT 1 FROM cabangs WHERE id=$1 AND studio_id=$2', [cabangId, studio.id])).rowCount) throw bad('Cabang tidak ditemukan.');
  await plans.consumeSession(c, studio, 1);
  const token = randomToken(16); // 128 bit
  const judul = str(b.judul, { max: 120 }) || pelangganNama;
  let pel = wa ? (await c.query('SELECT id FROM pelanggans WHERE studio_id=$1 AND no_wa=$2 AND nama=$3', [studio.id, wa, pelangganNama])).rows[0] : null;
  if (!pel) pel = (await c.query('INSERT INTO pelanggans(studio_id, nama, no_wa) VALUES ($1,$2,$3) RETURNING id', [studio.id, pelangganNama, wa])).rows[0];
  const row = (await c.query(`INSERT INTO sesis(studio_id, pelanggan_id, paket_id, judul, jenis, tanggal_sesi, kuota, durasi_pilih_menit, masa_aktif_jam,
      harga_foto_tambahan, maks_foto_tambahan, tampil_nama_file, izin_catatan, sumber, drive_folder_id, resource_key, urutan,
      token_hash, token_enc, pin_hash, pin_enc, tenggat_link, dibuat_oleh, sinkron_status, cabang_id, harga_bertingkat)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21, now() + ($22 || ' hours')::interval, $23, 'menunggu', $24, $25) RETURNING *`,
  [studio.id, pel.id, paket ? paket.id : null, judul, str(b.jenis, { max: 60 }) || (paket && paket.nama) || null,
    /^\d{4}-\d{2}-\d{2}$/.test(b.tanggal_sesi || '') ? b.tanggal_sesi : null,
    v.kuota, v.durasi_pilih_menit, v.masa_aktif_jam, v.harga_foto_tambahan, v.maks_foto_tambahan,
    b.tampil_nama_file === undefined ? true : bool(b.tampil_nama_file), b.izin_catatan === undefined ? true : bool(b.izin_catatan),
    src.sumber, src.folderId, src.resourceKey, b.urutan === 'waktu' ? 'waktu' : 'nama',
    sha256(token), encrypt(token), sha256(`pin:${pin}`), encrypt(pin), String(v.masa_aktif_jam), user.id, cabangId,
    JSON.stringify(v.harga_bertingkat)])).rows[0];
  await c.query('INSERT INTO tagihans(sesi_id) VALUES ($1)', [row.id]);
  await S.logEvent(c, row.id, 'dibuat', user.nama, { sumber: src.sumber });
  return { row, token, pin, pelangganNama, wa };
}

// F-16: kirim link otomatis lewat WhatsApp Business API bila diaktifkan
async function autoSendWa(studio, row, token, pin, aktor) {
  if (!studio.wa_otomatis || !plans.has(studio, 'wa_api') || !wa.configured(studio)) return null;
  const s = await db.one('SELECT s.*, p.nama AS pelanggan_nama, p.no_wa AS pelanggan_wa FROM sesis s JOIN pelanggans p ON p.id=s.pelanggan_id WHERE s.id=$1', [row.id]);
  if (!s.pelanggan_wa) return null;
  return sendLinkWa(studio, s, token, pin, aktor).catch((e) => ({ error: e.message }));
}
async function sendLinkWa(studio, s, token, pin, aktor) {
  const link = galleryUrl(token);
  const text = waText(studio, s, link, pin);
  const tz = studio.zona_waktu || 'Asia/Jakarta';
  const tenggat = s.tenggat_link ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(s.tenggat_link)) : '-';
  const out = await wa.send(studio, { sesiId: s.id, to: s.pelanggan_wa, jenis: 'link',
    template: config.waTemplateLink ? { name: config.waTemplateLink, params: [s.pelanggan_nama, studio.nama, link, pin, String(s.kuota), tenggat] } : null, text });
  await db.q('UPDATE sesis SET link_dikirim_pada=COALESCE(link_dikirim_pada, now()) WHERE id=$1', [s.id]);
  await S.logEvent(null, s.id, 'link_dikirim', aktor, { lewat: 'whatsapp_api' });
  return out;
}

r.post('/sesis', requireUser('sesi.kelola'), ah(async (req, res) => {
  const studio = await db.one('SELECT * FROM studios WHERE id=$1', [req.user.studio_id]);
  const out = await db.tx((c) => createSesiIn(c, req.user, studio, req.body));
  sync.startSync(out.row.id, req.user.nama);
  const waRes = await autoSendWa(studio, out.row, out.token, out.pin, req.user.nama);
  res.json({ id: out.row.id, link: galleryUrl(out.token), pin: out.pin, wa: waRes });
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
    harga_bertingkat: s.harga_bertingkat, ...pick(b, ['kuota', 'durasi_pilih_menit', 'harga_foto_tambahan', 'maks_foto_tambahan', 'harga_bertingkat']) });
  const judul = str(b.judul ?? s.judul, { required: true, max: 120, name: 'Judul' });
  await db.tx(async (c) => {
    await c.query(`UPDATE sesis SET judul=$2, jenis=$3, kuota=$4, durasi_pilih_menit=$5, harga_foto_tambahan=$6, maks_foto_tambahan=$7,
      tampil_nama_file=$8, izin_catatan=$9, harga_bertingkat=$10 WHERE id=$1`,
    [s.id, judul, str(b.jenis ?? s.jenis, { max: 60 }) || null, v.kuota, v.durasi_pilih_menit, v.harga_foto_tambahan, v.maks_foto_tambahan,
      b.tampil_nama_file === undefined ? s.tampil_nama_file : bool(b.tampil_nama_file), b.izin_catatan === undefined ? s.izin_catatan : bool(b.izin_catatan),
      JSON.stringify(v.harga_bertingkat)]);
    if (b.pelanggan_nama || b.pelanggan_wa !== undefined) {
      await c.query('UPDATE pelanggans SET nama=COALESCE($2,nama), no_wa=$3 WHERE id=$1',
        [s.pelanggan_id, str(b.pelanggan_nama, { max: 80 }) || null, b.pelanggan_wa ? normWa(b.pelanggan_wa) : null]);
    }
    await S.recomputeTagihan(c, { ...s, kuota: v.kuota, harga_foto_tambahan: v.harga_foto_tambahan, harga_bertingkat: v.harga_bertingkat });
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

// ======================= V1 / V2 =======================

// ---------- Cabang (F-05) ----------
r.get('/cabangs', ah(async (req, res) => {
  res.json(await db.many('SELECT id, nama, alamat, no_wa FROM cabangs WHERE studio_id=$1 AND NOT arsip ORDER BY nama', [req.user.studio_id]));
}));
r.post('/cabangs', requireUser('studio.edit'), ah(async (req, res) => {
  const studio = await db.one('SELECT * FROM studios WHERE id=$1', [req.user.studio_id]);
  plans.requireFeature(studio, 'multi_cabang');
  const row = await db.one('INSERT INTO cabangs(studio_id, nama, alamat, no_wa) VALUES ($1,$2,$3,$4) RETURNING *',
    [studio.id, str(req.body.nama, { required: true, max: 80, name: 'Nama cabang' }), str(req.body.alamat, { max: 200 }) || null, req.body.no_wa ? normWa(req.body.no_wa) : null]);
  res.json(row);
}));
r.put('/cabangs/:id', requireUser('studio.edit'), ah(async (req, res) => {
  const row = await db.one('UPDATE cabangs SET nama=$3, alamat=$4, no_wa=$5 WHERE id=$1 AND studio_id=$2 RETURNING *',
    [req.params.id, req.user.studio_id, str(req.body.nama, { required: true, max: 80, name: 'Nama cabang' }), str(req.body.alamat, { max: 200 }) || null, req.body.no_wa ? normWa(req.body.no_wa) : null]);
  if (!row) throw notFound();
  res.json(row);
}));
r.delete('/cabangs/:id', requireUser('studio.edit'), ah(async (req, res) => {
  await db.q('UPDATE cabangs SET arsip=true WHERE id=$1 AND studio_id=$2', [req.params.id, req.user.studio_id]);
  await db.q('UPDATE users SET cabang_id=NULL WHERE cabang_id=$1 AND studio_id=$2', [req.params.id, req.user.studio_id]);
  res.json({ ok: true });
}));

// ---------- QR code sesi (F-17) ----------
r.get('/sesis/:id/qr.svg', requireUser('sesi.kelola'), ah(async (req, res) => {
  const s = await loadSesi(req, req.params.id);
  const svg = await QRCode.toString(galleryUrl(decrypt(s.token_enc)), { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#001219', light: '#ffffff' } });
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'private, no-store');
  if (req.query.unduh) res.set('Content-Disposition', `attachment; filename="qr-${slugify(s.judul)}.svg"`);
  res.send(svg);
}));

// ---------- WhatsApp API (F-16) ----------
r.post('/sesis/:id/wa', requireUser('sesi.kelola'), ah(async (req, res) => {
  const s = await loadSesi(req, req.params.id);
  const studio = await db.one('SELECT * FROM studios WHERE id=$1', [s.studio_id]);
  plans.requireFeature(studio, 'wa_api');
  if (!wa.configured(studio)) throw bad('WhatsApp API belum dikonfigurasi. Isi di Pengaturan › WhatsApp.');
  try { await sendLinkWa(studio, s, decrypt(s.token_enc), decrypt(s.pin_enc), req.user.nama); } catch (e) { throw bad(e.message); }
  res.json({ ok: true });
}));

// ---------- Hasil akhir (F-43) ----------
function hasilText(studio, s) {
  const tpl = studio.template_hasil || 'Halo Kak {nama}, hasil edit foto {judul} dari {studio} sudah siap 🎉\n\n{link}\n\nTerima kasih sudah memotret bersama kami!';
  return tpl.replace(/\{(\w+)\}/g, (m, k) => ({ nama: s.pelanggan_nama, judul: s.judul, studio: studio.nama, link: s.hasil_link }[k] ?? m));
}
r.put('/sesis/:id/hasil', requireUser('editor.kerja'), ah(async (req, res) => {
  const s = await loadSesi(req, req.params.id);
  const link = str(req.body.hasil_link, { max: 1000, name: 'Link hasil' });
  if (link && !/^https?:\/\//i.test(link)) throw bad('Link hasil harus diawali http:// atau https://');
  await db.q('UPDATE sesis SET hasil_link=$2 WHERE id=$1', [s.id, link || null]);
  await S.logEvent(null, s.id, 'hasil', req.user.nama, { link: !!link });
  res.json({ ok: true });
}));
r.post('/sesis/:id/hasil/kirim', requireUser('editor.kerja'), ah(async (req, res) => {
  const s = await loadSesi(req, req.params.id);
  if (!s.hasil_link) throw bad('Isi link hasil akhir dulu.');
  const studio = await db.one('SELECT * FROM studios WHERE id=$1', [s.studio_id]);
  const text = hasilText(studio, s);
  if (req.body.lewat === 'api') {
    plans.requireFeature(studio, 'wa_api');
    if (!wa.configured(studio)) throw bad('WhatsApp API belum dikonfigurasi.');
    try {
      await wa.send(studio, { sesiId: s.id, to: s.pelanggan_wa, jenis: 'hasil',
        template: config.waTemplateHasil ? { name: config.waTemplateHasil, params: [s.pelanggan_nama, s.judul, s.hasil_link] } : null, text });
    } catch (e) { throw bad(e.message); }
  }
  await db.q('UPDATE sesis SET hasil_dikirim_pada=now() WHERE id=$1', [s.id]);
  await S.logEvent(null, s.id, 'hasil_dikirim', req.user.nama, { lewat: req.body.lewat === 'api' ? 'whatsapp_api' : 'whatsapp' });
  res.json({ ok: true, text, wa_url: `https://wa.me/${s.pelanggan_wa || ''}?text=${encodeURIComponent(text)}` });
}));

// ---------- Salin ke folder "Terpilih" di Drive (F-42) ----------
r.post('/sesis/:id/terpilih', requireUser('sesi.kelola'), ah(async (req, res) => {
  const s = await loadSesi(req, req.params.id);
  const studio = await db.one('SELECT * FROM studios WHERE id=$1', [s.studio_id]);
  plans.requireFeature(studio, 'drive_terpilih');
  if (s.sumber !== 'service_account') throw bad('Fitur ini butuh folder yang dibagikan ke email layanan (bukan link publik/contoh).');
  if (s.terpilih_status === 'berjalan') return res.json({ ok: true });
  const items = await db.many(`SELECT f.drive_file_id, f.nama_file, f.nomor FROM pilihans p JOIN fotos f ON f.id=p.foto_id WHERE p.sesi_id=$1 ORDER BY f.nomor`, [s.id]);
  if (!items.length) throw bad('Belum ada foto dipilih.');
  await db.q("UPDATE sesis SET terpilih_status='berjalan', terpilih_info=NULL WHERE id=$1", [s.id]);
  const nama = req.user.nama;
  (async () => {
    try {
      const folder = await drive.ensureSubfolder(s.drive_folder_id, str(req.body.nama_folder, { max: 80 }) || 'Terpilih');
      let ok = 0;
      for (const it of items) {
        await drive.copyFile(it.drive_file_id, folder, `${F.pad(it.nomor, 0)}_${it.nama_file}`);
        ok += 1;
        if (ok % 5 === 0) await db.q('UPDATE sesis SET terpilih_info=$2 WHERE id=$1', [s.id, `${ok}/${items.length}`]);
      }
      await db.q("UPDATE sesis SET terpilih_status='selesai', terpilih_folder_id=$2, terpilih_info=$3 WHERE id=$1", [s.id, folder, `${ok} file disalin`]);
      await S.logEvent(null, s.id, 'drive_terpilih', nama, { jumlah: ok });
    } catch (e) {
      const hint = e.status === 403 || e.status === 404 ? ' Pastikan email layanan menjadi Editor folder (bukan Pelihat).' : '';
      await db.q("UPDATE sesis SET terpilih_status='gagal', terpilih_info=$2 WHERE id=$1", [s.id, String(e.message + hint).slice(0, 400)]);
    }
  })();
  res.json({ ok: true });
}));

// ---------- Link bayar online foto tambahan (F-35), dari sisi admin ----------
async function createTagihanPayment(s, studio) {
  plans.requireFeature(studio, 'bayar_online');
  if (!payment.enabled()) throw bad('Payment gateway belum dikonfigurasi (MIDTRANS_SERVER_KEY).');
  const t = await db.one('SELECT * FROM tagihans WHERE sesi_id=$1', [s.id]);
  if (!t || Number(t.total_rupiah) <= 0) throw bad('Tidak ada tagihan foto tambahan.');
  if (t.status_bayar === 'lunas') throw bad('Tagihan sudah lunas.');
  if (t.payment_url && Number(t.payment_total) === Number(t.total_rupiah)) return t.payment_url;
  const pel = await db.one('SELECT nama, no_wa FROM pelanggans WHERE id=$1', [s.pelanggan_id]);
  const orderId = `GS-T-${s.id}-${Date.now()}`;
  const amount = Number(t.total_rupiah);
  const tokenPlain = decrypt(s.token_enc);
  let snap;
  try {
    snap = await payment.createSnap({ orderId, amount,
      items: [{ id: `tambahan-${s.id}`, name: `${t.jumlah_foto} foto tambahan · ${s.judul}`.slice(0, 50), price: amount, quantity: 1 }],
      customer: { first_name: pel.nama, phone: pel.no_wa || undefined }, finishUrl: galleryUrl(tokenPlain) });
  } catch (e) { throw bad(e.message); }
  await db.q('UPDATE tagihans SET order_id=$2, payment_url=$3, payment_total=$4, diubah_pada=now() WHERE sesi_id=$1', [s.id, orderId, snap.url, amount]);
  return snap.url;
}
r.post('/sesis/:id/bayar-link', requireUser('tagihan.kelola'), ah(async (req, res) => {
  const s = await loadSesi(req, req.params.id);
  const studio = await db.one('SELECT * FROM studios WHERE id=$1', [s.studio_id]);
  const url = await createTagihanPayment(s, studio);
  res.json({ ok: true, url, wa_url: s.pelanggan_wa ? `https://wa.me/${s.pelanggan_wa}?text=${encodeURIComponent(`Halo Kak ${s.pelanggan_nama}, berikut link pembayaran foto tambahan ${s.judul}: ${url}`)}` : null });
}));

// ---------- Mode kiosk (F-45) ----------
r.post('/sesis/:id/kiosk', requireUser('sesi.kelola'), ah(async (req, res) => {
  const s = await loadSesi(req, req.params.id);
  const studio = await db.one('SELECT * FROM studios WHERE id=$1', [s.studio_id]);
  plans.requireFeature(studio, 'kiosk');
  if (!['siap', 'dibuka', 'memilih'].includes(s.status)) throw bad('Sesi ini tidak bisa dibuka di kiosk (status: ' + s.status + ').');
  const tokenPlain = decrypt(s.token_enc);
  const ct = randomToken(32);
  await db.tx(async (c) => {
    await c.query("INSERT INTO client_sessions(token_hash, sesi_id, kedaluwarsa) VALUES ($1,$2, now() + interval '12 hours')", [sha256(ct), s.id]);
    const cur = (await c.query('SELECT * FROM sesis WHERE id=$1 FOR UPDATE', [s.id])).rows[0];
    await c.query(`UPDATE sesis SET kiosk=true, jumlah_dibuka=jumlah_dibuka+1, dibuka_pada=COALESCE(dibuka_pada, now()) WHERE id=$1`, [s.id]);
    if (['siap', 'dibuka'].includes(cur.status)) {
      // Timer mulai otomatis di kiosk
      const menit = cur.durasi_pilih_menit > 0 ? cur.durasi_pilih_menit : null;
      await c.query(`UPDATE sesis SET status='memilih', mulai_pilih_pada=now(), berakhir_pada=${menit ? "now() + ($2 || ' minutes')::interval" : 'GREATEST(tenggat_link, now())'},
        tenggat_link=GREATEST(tenggat_link, now() + interval '1 hour') WHERE id=$1`, menit ? [s.id, String(menit)] : [s.id]);
      await S.logEvent(c, s.id, 'mulai', req.user.nama, { mode: 'kiosk', menit });
    }
  });
  setCookie(res, req, `gs_c${s.id}`, ct, { maxAge: 12 * 3600, path: `/g/${tokenPlain}` });
  res.json({ ok: true, url: `/g/${tokenPlain}?kiosk=1` });
}));

// ---------- Buat sesi massal dari CSV (F-12) ----------
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  const t = String(text || '').replace(/^﻿/, '');
  const delim = (t.split('\n')[0].match(/;/g) || []).length > (t.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      row.push(cell); cell = ''; if (row.some((x) => x.trim())) rows.push(row); row = [];
    } else cell += ch;
  }
  row.push(cell); if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}
r.post('/sesis/massal', requireUser('sesi.kelola'), limit('massal', 20, 3600), ah(async (req, res) => {
  const studio = await db.one('SELECT * FROM studios WHERE id=$1', [req.user.studio_id]);
  plans.requireFeature(studio, 'csv_massal');
  const rows = parseCsv(req.body.csv);
  if (rows.length < 2) throw bad('CSV kosong. Baris pertama harus header: nama,no_wa,link_folder,paket,judul,tanggal,pin');
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const col = (r0, ...names) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return (r0[i] || '').trim(); } return ''; };
  if (rows.length - 1 > 500) throw bad('Maksimal 500 baris per unggahan.');
  const pakets = await db.many('SELECT id, nama FROM pakets WHERE studio_id=$1 AND NOT arsip', [studio.id]);
  const def = req.body.default || {};
  const hasil = [];
  for (let i = 1; i < rows.length; i++) {
    const r0 = rows[i];
    const paketNama = col(r0, 'paket');
    const paket = paketNama ? pakets.find((p) => p.nama.toLowerCase() === paketNama.toLowerCase()) : null;
    const link = col(r0, 'link_folder', 'link', 'folder');
    const body = {
      pelanggan_nama: col(r0, 'nama', 'nama_pelanggan'), pelanggan_wa: col(r0, 'no_wa', 'wa', 'whatsapp'), judul: col(r0, 'judul'),
      tanggal_sesi: col(r0, 'tanggal', 'tanggal_sesi'), pin: col(r0, 'pin') || undefined,
      paket_id: paket ? paket.id : def.paket_id, cabang_id: def.cabang_id,
      sumber: link ? (def.sumber === 'link_publik' ? 'link_publik' : 'service_account') : (config.allowDemoSource && def.sumber === 'contoh' ? 'contoh' : null),
      link, jumlah_contoh: def.jumlah_contoh || 24,
    };
    try {
      if (paketNama && !paket) throw bad(`Paket "${paketNama}" tidak ada.`);
      if (!body.sumber) throw bad('Kolom link_folder kosong.');
      const out = await db.tx((c) => createSesiIn(c, req.user, studio, body));
      sync.startSync(out.row.id, req.user.nama);
      const waRes = req.body.kirim_wa ? await autoSendWa({ ...studio, wa_otomatis: true }, out.row, out.token, out.pin, req.user.nama) : null;
      hasil.push({ baris: i + 1, ok: true, id: out.row.id, nama: out.pelangganNama, no_wa: out.wa, link: galleryUrl(out.token), pin: out.pin,
        wa: waRes && waRes.error ? 'gagal: ' + waRes.error : waRes ? 'terkirim' : null });
    } catch (e) {
      hasil.push({ baris: i + 1, ok: false, nama: body.pelanggan_nama, error: e.message });
      if (e.status === 402) break; // kuota paket habis: hentikan
    }
  }
  res.json({ hasil, dibuat: hasil.filter((h) => h.ok).length, gagal: hasil.filter((h) => !h.ok).length });
}));

// ---------- Laporan (F-44, F-05 per cabang) ----------
async function laporanData(req) {
  const studio = await db.one('SELECT * FROM studios WHERE id=$1', [req.user.studio_id]);
  plans.requireFeature(studio, 'laporan');
  const tz = studio.zona_waktu || 'Asia/Jakarta';
  const dari = /^\d{4}-\d{2}-\d{2}$/.test(req.query.dari || '') ? req.query.dari : null;
  const sampai = /^\d{4}-\d{2}-\d{2}$/.test(req.query.sampai || '') ? req.query.sampai : null;
  const params = [studio.id, tz, dari, sampai];
  let where = `s.studio_id=$1 AND (s.dibuat_pada AT TIME ZONE $2)::date >= COALESCE($3::date, (now() AT TIME ZONE $2)::date - 29)
    AND (s.dibuat_pada AT TIME ZONE $2)::date <= COALESCE($4::date, (now() AT TIME ZONE $2)::date)`;
  const cab = req.user.cabang_id || (req.query.cabang ? parseInt(req.query.cabang, 10) : null);
  if (cab) { params.push(cab); where += ` AND s.cabang_id=$${params.length}`; }
  const agg = `count(*)::int AS sesi,
    count(*) FILTER (WHERE s.dikirim_pada IS NOT NULL)::int AS terkirim,
    count(*) FILTER (WHERE s.dikirim_pada IS NOT NULL AND NOT s.dikirim_otomatis)::int AS tepat_waktu,
    count(*) FILTER (WHERE s.status='kedaluwarsa')::int AS kedaluwarsa,
    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM events e WHERE e.sesi_id=s.id AND e.jenis='minta_waktu'))::int AS minta_waktu,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM s.dikirim_pada - COALESCE(s.link_dikirim_pada, s.dibuat_pada))) AS median_detik,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM s.dikirim_pada - s.mulai_pilih_pada)) AS median_pilih_detik,
    count(*) FILTER (WHERE t.jumlah_foto > 0)::int AS dengan_tambahan,
    COALESCE(sum(t.jumlah_foto),0)::int AS foto_tambahan,
    COALESCE(sum(t.total_rupiah) FILTER (WHERE t.status_bayar='lunas'),0)::bigint AS pendapatan_lunas,
    COALESCE(sum(t.total_rupiah) FILTER (WHERE t.status_bayar<>'lunas'),0)::bigint AS pendapatan_belum`;
  const from = 'FROM sesis s LEFT JOIN tagihans t ON t.sesi_id=s.id LEFT JOIN cabangs cb ON cb.id=s.cabang_id';
  const total = await db.one(`SELECT ${agg} ${from} WHERE ${where}`, params);
  const perCabang = await db.many(`SELECT COALESCE(cb.nama,'Tanpa cabang') AS cabang, s.cabang_id, ${agg} ${from} WHERE ${where} GROUP BY cb.nama, s.cabang_id ORDER BY 1`, params);
  const perHari = await db.many(`SELECT to_char((s.dibuat_pada AT TIME ZONE $2)::date,'YYYY-MM-DD') AS hari, count(*)::int AS sesi,
      COALESCE(sum(t.total_rupiah),0)::bigint AS tambahan ${from} WHERE ${where} GROUP BY 1 ORDER BY 1`, params);
  const perPaket = await db.many(`SELECT COALESCE(pk.nama,'Kustom') AS paket, count(*)::int AS sesi, COALESCE(sum(t.total_rupiah),0)::bigint AS tambahan
    ${from} LEFT JOIN pakets pk ON pk.id=s.paket_id WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`, params);
  return { total, per_cabang: perCabang, per_hari: perHari, per_paket: perPaket, dari, sampai };
}
r.get('/laporan', requireUser('sesi.kelola'), ah(async (req, res) => res.json(await laporanData(req))));
r.get('/laporan.csv', requireUser('sesi.kelola'), ah(async (req, res) => {
  const d = await laporanData(req);
  const cols = ['cabang', 'sesi', 'terkirim', 'tepat_waktu', 'kedaluwarsa', 'minta_waktu', 'median_detik', 'dengan_tambahan', 'foto_tambahan', 'pendapatan_lunas', 'pendapatan_belum'];
  const lines = [cols.join(',')].concat(d.per_cabang.concat([{ ...d.total, cabang: 'TOTAL' }]).map((x) => cols.map((c) => `"${String(x[c] ?? '').replace(/"/g, '""')}"`).join(',')));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="laporan.csv"');
  res.send('﻿' + lines.join('\r\n') + '\r\n');
}));

// ---------- Langganan & tagihan studio (F-46) ----------
r.get('/langganan', requireUser('sesi.lihat'), ah(async (req, res) => {
  const studio = await db.one('SELECT * FROM studios WHERE id=$1', [req.user.studio_id]);
  const invoices = can(req.user, 'studio.edit') ? await db.many('SELECT id, jenis, plan, bulan, kredit, jumlah, status, payment_url, dibayar_pada, dibuat_pada FROM invoices WHERE studio_id=$1 ORDER BY id DESC LIMIT 24', [studio.id]) : [];
  res.json({ ...plans.summary(studio), pemakaian: await plans.usage(studio.id), invoices, payment: payment.enabled(),
    katalog: Object.entries(plans.PLANS).map(([k, p]) => ({ kode: k, nama: p.nama, harga: p.harga, sesi: p.sesi === Infinity ? null : p.sesi, pengguna: p.pengguna === Infinity ? null : p.pengguna, fitur: p.fitur.map((f) => plans.FITUR_NAMA[f]) })),
    kredit: { sesi: config.kreditPaket, harga: config.kreditHarga } });
}));
r.post('/langganan/beli', requireUser('studio.edit'), ah(async (req, res) => {
  if (!config.billingEnabled) throw bad('Langganan tidak aktif di server ini (BILLING_ENABLED=false): semua fitur sudah terbuka.');
  if (!payment.enabled()) throw bad('Payment gateway belum dikonfigurasi.');
  const studio = await db.one('SELECT * FROM studios WHERE id=$1', [req.user.studio_id]);
  let inv;
  if (req.body.kredit) {
    inv = { jenis: 'kredit', kredit: config.kreditPaket, jumlah: config.kreditHarga, nama: `Kredit ${config.kreditPaket} sesi` };
  } else {
    const p = plans.PLANS[req.body.plan];
    if (!p || !p.harga) throw bad('Paket tidak bisa dibeli online. Hubungi kami untuk paket Bisnis.');
    const bulan = int(req.body.bulan, { min: 1, max: 12, def: 1, name: 'Bulan' });
    const jumlah = bulan >= 12 ? p.harga * 10 : p.harga * bulan; // tahunan: hemat 2 bulan
    inv = { jenis: 'plan', plan: req.body.plan, bulan, jumlah, nama: `Paket ${p.nama} ${bulan} bulan` };
  }
  const row = await db.one(`INSERT INTO invoices(studio_id, jenis, plan, bulan, kredit, jumlah, order_id) VALUES ($1,$2,$3,$4,$5,$6, 'tmp-' || gen_random_uuid()) RETURNING id`,
    [studio.id, inv.jenis, inv.plan || null, inv.bulan || null, inv.kredit || null, inv.jumlah]);
  const orderId = `GS-I-${row.id}-${Date.now()}`;
  let snap;
  try {
    snap = await payment.createSnap({ orderId, amount: inv.jumlah, items: [{ id: `inv-${row.id}`, name: inv.nama.slice(0, 50), price: inv.jumlah, quantity: 1 }],
      customer: { first_name: req.user.nama, email: req.user.email }, finishUrl: `${config.baseUrl}/app#/langganan` });
  } catch (e) { await db.q("UPDATE invoices SET status='batal' WHERE id=$1", [row.id]); throw bad(e.message); }
  await db.q('UPDATE invoices SET order_id=$2, payment_url=$3 WHERE id=$1', [row.id, orderId, snap.url]);
  res.json({ ok: true, url: snap.url });
}));

// ---------- Super admin platform ----------
async function audit(req, aksi, studioId, detail) {
  await db.q('INSERT INTO admin_audit(aktor, aksi, studio_id, detail) VALUES ($1,$2,$3,$4)', [req.user.email, aksi, studioId, detail ? JSON.stringify(detail) : null]);
}
r.get('/admin/studios', requireSuperadmin(), ah(async (req, res) => {
  const q = req.query.q ? `%${String(req.query.q).slice(0, 80)}%` : null;
  res.json(await db.many(`SELECT st.id, st.nama, st.slug, st.plan, st.plan_sampai, st.kredit_sesi, st.aktif, st.dibuat_pada, st.no_wa,
      (SELECT email FROM users WHERE studio_id=st.id AND peran='owner' ORDER BY id LIMIT 1) AS owner_email,
      (SELECT count(*)::int FROM users WHERE studio_id=st.id AND aktif) AS pengguna,
      (SELECT count(*)::int FROM sesis WHERE studio_id=st.id) AS sesi_total,
      (SELECT count(*)::int FROM sesis WHERE studio_id=st.id AND dibuat_pada >= date_trunc('month', now())) AS sesi_bulan_ini,
      (SELECT max(dibuat_pada) FROM sesis WHERE studio_id=st.id) AS sesi_terakhir
    FROM studios st WHERE ($1::text IS NULL OR st.nama ILIKE $1 OR st.slug ILIKE $1) ORDER BY st.id DESC LIMIT 500`, [q]));
}));
r.put('/admin/studios/:id', requireSuperadmin(), ah(async (req, res) => {
  const st = await db.one('SELECT * FROM studios WHERE id=$1', [req.params.id]);
  if (!st) throw notFound();
  const plan = plans.PLANS[req.body.plan] ? req.body.plan : st.plan;
  const sampai = req.body.plan_sampai === '' ? null : (/^\d{4}-\d{2}-\d{2}$/.test(req.body.plan_sampai || '') ? req.body.plan_sampai + 'T23:59:59+07:00' : st.plan_sampai);
  const tambahKredit = int(req.body.tambah_kredit, { min: -100000, max: 100000, def: 0, name: 'Kredit' });
  const aktif = req.body.aktif === undefined ? st.aktif : bool(req.body.aktif);
  await db.q('UPDATE studios SET plan=$2, plan_sampai=$3, kredit_sesi=GREATEST(0, kredit_sesi+$4), aktif=$5 WHERE id=$1', [st.id, plan, sampai, tambahKredit, aktif]);
  await audit(req, 'ubah_studio', st.id, { plan, plan_sampai: sampai, tambah_kredit: tambahKredit, aktif });
  res.json({ ok: true });
}));
r.get('/admin/audit', requireSuperadmin(), ah(async (req, res) => {
  res.json(await db.many(`SELECT a.*, st.nama AS studio_nama FROM admin_audit a LEFT JOIN studios st ON st.id=a.studio_id ORDER BY a.waktu DESC LIMIT 200`));
}));
r.get('/admin/ringkasan', requireSuperadmin(), ah(async (req, res) => {
  res.json(await db.one(`SELECT (SELECT count(*)::int FROM studios) AS studio, (SELECT count(*)::int FROM studios WHERE aktif) AS studio_aktif,
    (SELECT count(*)::int FROM sesis WHERE dibuat_pada > now() - interval '30 days') AS sesi_30h,
    (SELECT count(DISTINCT studio_id)::int FROM sesis WHERE dibuat_pada > now() - interval '14 days') AS studio_aktif_14h,
    (SELECT COALESCE(sum(jumlah),0)::bigint FROM invoices WHERE status='lunas' AND dibayar_pada > now() - interval '30 days') AS pendapatan_30h`));
}));

r.use((req, res, next) => next(new HttpError(404, 'Endpoint tidak ditemukan.')));

module.exports = r;
