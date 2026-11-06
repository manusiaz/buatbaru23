'use strict';
// Kunci API & token integrasi yang dikelola super admin dari satu halaman.
// - Nilai rahasia disimpan terenkripsi AES-256-GCM (kunci turunan APP_SECRET, terpisah dari enkripsi lain).
// - Rahasia TIDAK pernah dikirim ke browser: hanya status, 4 karakter terakhir, siapa & kapan diubah.
// - Nilai di database mengalahkan env; env tetap jadi cadangan.
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const { bad } = require('./http');

const key = crypto.createHash('sha256').update('integrasi:' + config.appSecret).digest();
function enc(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from('gs-integrasi-v1'));
  const e = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), e]).toString('base64url');
}
function dec(blob) {
  const b = Buffer.from(String(blob).replace(/^v1:/, ''), 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAAD(Buffer.from('gs-integrasi-v1'));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

// Registry: kunci → properti config, env, jenis, validasi
const FIELDS = [
  // Google
  { k: 'google_client_id', grup: 'google', label: 'OAuth Client ID (login Google & Picker)', cfg: 'googleClientId', env: 'GOOGLE_CLIENT_ID', rahasia: false,
    cek: (v) => /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(v) || 'Format Client ID: 1234-abc.apps.googleusercontent.com' },
  { k: 'google_app_id', grup: 'google', label: 'Project number (App ID Picker)', cfg: 'googleAppId', env: 'GOOGLE_APP_ID', rahasia: false,
    cek: (v) => /^\d{6,20}$/.test(v) || 'Project number berupa angka.' },
  { k: 'google_api_key', grup: 'google', label: 'API key (link publik & Picker)', cfg: 'googleApiKey', env: 'GOOGLE_API_KEY', rahasia: true,
    cek: (v) => /^AIza[0-9A-Za-z_-]{35}$/.test(v) || 'API key Google diawali "AIza" (39 karakter).' },
  { k: 'google_service_account_json', grup: 'google', label: 'Service account (JSON key)', cfg: 'googleServiceAccountJson', env: 'GOOGLE_SERVICE_ACCOUNT_JSON', rahasia: true, multiline: true,
    cek: (v) => {
      let j; try { j = JSON.parse(v); } catch { return 'Isi harus JSON key service account yang utuh.'; }
      if (j.type !== 'service_account' || !j.client_email || !/BEGIN PRIVATE KEY/.test(j.private_key || '')) return 'JSON bukan key service account (butuh type, client_email, private_key).';
      return true;
    },
    publik: (v) => { try { return JSON.parse(v).client_email; } catch { return null; } } },
  // Midtrans
  { k: 'midtrans_server_key', grup: 'midtrans', label: 'Server key', cfg: 'midtransServerKey', env: 'MIDTRANS_SERVER_KEY', rahasia: true,
    cek: (v) => /^(SB-)?Mid-server-[A-Za-z0-9_-]{10,}$/.test(v) || 'Server key Midtrans diawali "Mid-server-" atau "SB-Mid-server-".' },
  { k: 'midtrans_client_key', grup: 'midtrans', label: 'Client key', cfg: 'midtransClientKey', env: 'MIDTRANS_CLIENT_KEY', rahasia: false,
    cek: (v) => /^(SB-)?Mid-client-[A-Za-z0-9_-]{10,}$/.test(v) || 'Client key Midtrans diawali "Mid-client-" atau "SB-Mid-client-".' },
  { k: 'midtrans_production', grup: 'midtrans', label: 'Mode production (bukan sandbox)', cfg: 'midtransProduction', env: 'MIDTRANS_PRODUCTION', rahasia: false, bool: true },
  // WhatsApp
  { k: 'wa_cloud_token', grup: 'whatsapp', label: 'Access token (permanen, System User)', cfg: 'waToken', env: 'WA_CLOUD_TOKEN', rahasia: true,
    cek: (v) => /^[A-Za-z0-9_-]{40,}$/.test(v) || 'Token WhatsApp Cloud API tidak valid.' },
  { k: 'wa_phone_number_id', grup: 'whatsapp', label: 'Phone number ID', cfg: 'waPhoneNumberId', env: 'WA_PHONE_NUMBER_ID', rahasia: false,
    cek: (v) => /^\d{6,30}$/.test(v) || 'Phone number ID berupa angka.' },
  { k: 'wa_template_link', grup: 'whatsapp', label: 'Nama template kirim link', cfg: 'waTemplateLink', env: 'WA_TEMPLATE_LINK', rahasia: false,
    cek: (v) => /^[a-z0-9_]{1,512}$/.test(v) || 'Nama template: huruf kecil, angka, garis bawah.' },
  { k: 'wa_template_hasil', grup: 'whatsapp', label: 'Nama template kirim hasil', cfg: 'waTemplateHasil', env: 'WA_TEMPLATE_HASIL', rahasia: false,
    cek: (v) => /^[a-z0-9_]{1,512}$/.test(v) || 'Nama template: huruf kecil, angka, garis bawah.' },
  { k: 'wa_template_lang', grup: 'whatsapp', label: 'Bahasa template', cfg: 'waTemplateLang', env: 'WA_TEMPLATE_LANG', rahasia: false, bawaan: 'id',
    cek: (v) => /^[a-z]{2}(_[A-Z]{2})?$/.test(v) || 'Kode bahasa, mis. id atau en_US.' },
  // Email
  { k: 'smtp_url', grup: 'email', label: 'SMTP URL', cfg: 'smtpUrl', env: 'SMTP_URL', rahasia: true,
    cek: (v) => /^smtps?:\/\/.+/.test(v) || 'Format: smtps://user:sandi@host:465' },
  { k: 'mail_from', grup: 'email', label: 'Pengirim (From)', cfg: 'mailFrom', env: 'MAIL_FROM', rahasia: false,
    cek: (v) => /^.{0,80}<?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(v) || 'Format: Nama <no-reply@domain.com>' },
  // Keamanan
  { k: 'security_contact', grup: 'keamanan', label: 'Kontak laporan celah (security.txt)', cfg: 'securityContact', env: 'SECURITY_CONTACT', rahasia: false,
    cek: (v) => /^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(v) || 'Format: mailto:security@domain.com atau https://…' },
];
const GRUP = {
  google: { nama: 'Google (login, Drive, Picker)', bantuan: 'console.cloud.google.com › APIs & Services › Credentials' },
  midtrans: { nama: 'Midtrans (pelanggan bayar foto tambahan)', bantuan: 'dashboard.midtrans.com › Settings › Access Keys. Notification URL: {BASE_URL}/api/webhooks/midtrans' },
  whatsapp: { nama: 'WhatsApp Business Cloud API', bantuan: 'business.facebook.com › WhatsApp Manager › API Setup' },
  email: { nama: 'Email (SMTP) untuk notifikasi', bantuan: 'Mis. smtps://user:app-password@smtp.gmail.com:465' },
  keamanan: { nama: 'Keamanan', bantuan: 'Ditampilkan di /.well-known/security.txt' },
};
const BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.k, f]));

// Nilai env asli (sebelum ditimpa DB) sebagai cadangan
const ENV_DEFAULT = Object.fromEntries(FIELDS.map((f) => [f.k, config[f.cfg]]));

let resetHooks = [];
function onChange(fn) { resetHooks.push(fn); }

let loaded = {}; // k -> { nilai, waktu, oleh }
async function reload() {
  const rows = await db.many("SELECT kunci, nilai, waktu, diubah_oleh FROM platform_settings WHERE kunci LIKE 'int:%'");
  const next = {};
  for (const r of rows) {
    const f = BY_KEY[r.kunci.slice(4)];
    if (!f) continue;
    let v;
    try { v = f.rahasia ? dec(r.nilai) : r.nilai; } catch { console.error(`[integrasi] gagal mendekripsi ${f.k} (APP_SECRET berubah?)`); continue; }
    next[f.k] = { nilai: v, waktu: r.waktu, oleh: r.diubah_oleh };
  }
  loaded = next;
  for (const f of FIELDS) {
    const raw = loaded[f.k] ? loaded[f.k].nilai : ENV_DEFAULT[f.k];
    config[f.cfg] = f.bool ? (raw === true || /^(1|true)$/i.test(String(raw || ''))) : (raw || f.bawaan || '');
  }
  resetHooks.forEach((fn) => { try { fn(); } catch (e) { console.error('[integrasi]', e.message); } });
}

function mask(v) {
  const s = String(v || '');
  if (!s) return null;
  return s.length <= 8 ? '••••' : '••••' + s.slice(-4);
}

// Ringkasan aman untuk browser: tidak pernah memuat nilai rahasia
function summary() {
  return Object.entries(GRUP).map(([g, meta]) => ({
    grup: g, ...meta,
    fields: FIELDS.filter((f) => f.grup === g).map((f) => {
      const fromDb = loaded[f.k];
      const val = fromDb ? fromDb.nilai : ENV_DEFAULT[f.k];
      const has = f.bool ? true : !!val;
      return {
        k: f.k, label: f.label, rahasia: f.rahasia, bool: !!f.bool, multiline: !!f.multiline,
        sumber: fromDb ? 'database' : (ENV_DEFAULT[f.k] && !f.bool) || (f.bool && process.env[f.env]) ? 'env' : 'kosong',
        terisi: has,
        nilai: f.rahasia ? null : (f.bool ? !!config[f.cfg] : (val || '')),
        samaran: f.rahasia ? mask(val) : null,
        info_publik: f.publik && val ? f.publik(val) : null,
        diubah_pada: fromDb ? fromDb.waktu : null,
        diubah_oleh: fromDb ? fromDb.oleh : null,
      };
    }),
  }));
}

async function setValue(k, value, aktor) {
  const f = BY_KEY[k];
  if (!f) throw bad('Kunci tidak dikenal.');
  let v = f.bool ? (value === true || value === 'true' ? 'true' : 'false') : String(value == null ? '' : value).trim();
  if (!f.bool) {
    if (!v) throw bad('Nilai kosong. Pakai tombol Hapus untuk mengosongkan.');
    if (v.length > (f.multiline ? 10000 : 2000)) throw bad('Nilai terlalu panjang.');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) throw bad('Nilai berisi karakter tidak valid.');
    const ok = f.cek ? f.cek(v) : true;
    if (ok !== true) throw bad(ok);
  }
  const stored = f.rahasia ? enc(v) : v;
  await db.q(`INSERT INTO platform_settings(kunci, nilai, waktu, diubah_oleh) VALUES ($1,$2, now(), $3)
    ON CONFLICT (kunci) DO UPDATE SET nilai=$2, waktu=now(), diubah_oleh=$3`, ['int:' + k, stored, aktor]);
  await reload();
}
async function clearValue(k) {
  if (!BY_KEY[k]) throw bad('Kunci tidak dikenal.');
  await db.q('DELETE FROM platform_settings WHERE kunci=$1', ['int:' + k]);
  await reload();
}

// Tes koneksi dari server (hasil tidak pernah memuat rahasia)
async function test(grup) {
  const t0 = Date.now();
  const done = (ok, pesan) => ({ ok, pesan, ms: Date.now() - t0 });
  try {
    if (grup === 'google') {
      const drive = require('./drive');
      const hasil = [];
      if (config.googleServiceAccountJson) {
        await drive.testServiceAccount();
        hasil.push(`Service account OK (${drive.serviceAccountEmail()})`);
      } else hasil.push('Service account belum diisi');
      if (config.googleApiKey) {
        const r = await fetch(`https://www.googleapis.com/drive/v3/about?fields=kind&key=${encodeURIComponent(config.googleApiKey)}`);
        const j = await r.json().catch(() => ({}));
        const reason = j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason;
        if (r.status === 400 && /keyInvalid/.test(reason || '')) return done(false, 'API key ditolak Google (keyInvalid).');
        hasil.push('API key dikenali Google');
      }
      if (!config.googleClientId) hasil.push('Client ID belum diisi — login Google mati');
      return done(true, hasil.join(' · '));
    }
    if (grup === 'midtrans') {
      if (!config.midtransServerKey) return done(false, 'Server key belum diisi.');
      const base = config.midtransProduction ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com';
      const r = await fetch(`${base}/v2/gs-tes-koneksi-${Date.now()}/status`, { headers: { authorization: 'Basic ' + Buffer.from(config.midtransServerKey + ':').toString('base64'), accept: 'application/json' } });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401 || j.status_code === '401') return done(false, `Server key ditolak Midtrans (${config.midtransProduction ? 'production' : 'sandbox'}). Cek mode & key.`);
      return done(true, `Server key diterima Midtrans (${config.midtransProduction ? 'production' : 'sandbox'}).`);
    }
    if (grup === 'whatsapp') {
      if (!config.waToken || !config.waPhoneNumberId) return done(false, 'Token dan phone number ID wajib diisi.');
      const r = await fetch(`https://graph.facebook.com/${config.waApiVersion}/${encodeURIComponent(config.waPhoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`, { headers: { authorization: `Bearer ${config.waToken}` } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return done(false, `Meta menolak: ${(j.error && j.error.message) || r.status}`);
      return done(true, `Nomor ${j.display_phone_number || '?'} (${j.verified_name || 'tanpa nama'}), kualitas ${j.quality_rating || '-'}.`);
    }
    if (grup === 'email') {
      if (!config.smtpUrl) return done(false, 'SMTP URL belum diisi.');
      await require('nodemailer').createTransport(config.smtpUrl).verify();
      return done(true, 'Server SMTP menerima login.');
    }
    return done(false, 'Tidak ada tes untuk grup ini.');
  } catch (e) {
    return done(false, String(e.message || e).replace(/(key|token|password|sandi)=[^&\s]+/gi, '$1=•••').slice(0, 300));
  }
}

let timer = null;
function start() {
  // Muat ulang berkala agar semua instance memakai nilai terbaru
  timer = setInterval(() => reload().catch((e) => console.error('[integrasi]', e.message)), 60000);
  timer.unref();
}

module.exports = { FIELDS, GRUP, reload, summary, setValue, clearValue, test, onChange, start, _enc: enc, _dec: dec };
