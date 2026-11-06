'use strict';
const path = require('path');

const env = process.env;
function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

const config = {
  port: int(env.PORT, 3000),
  baseUrl: (env.BASE_URL || `http://localhost:${int(env.PORT, 3000)}`).replace(/\/$/, ''),
  databaseUrl: env.DATABASE_URL || 'postgres://app:app@localhost:5432/pilihfoto',
  databaseSsl: /^(1|true|require)$/i.test(env.DATABASE_SSL || ''),
  appSecret: env.APP_SECRET || '',
  dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
  appName: env.APP_NAME || 'Galeri Seleksi',
  // Google Drive
  googleServiceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
  googleServiceAccountFile: env.GOOGLE_SERVICE_ACCOUNT_FILE || '',
  googleApiKey: env.GOOGLE_API_KEY || '',
  googleClientId: env.GOOGLE_CLIENT_ID || '',
  googleAppId: env.GOOGLE_APP_ID || '', // nomor project Google Cloud, untuk Picker
  // Email (opsional)
  smtpUrl: env.SMTP_URL || '',
  mailFrom: env.MAIL_FROM || '',
  // Lain-lain
  // Jumlah hop proxy tepercaya (mis. 1 untuk satu Nginx/Caddy) atau daftar IP/subnet proxy.
  // JANGAN "true": klien bisa memalsukan X-Forwarded-For dan melewati kunci PIN & rate limit.
  trustProxy: parseTrustProxy(env.TRUST_PROXY),
  allowRegistration: env.ALLOW_REGISTRATION !== 'false',
  securityContact: env.SECURITY_CONTACT || '',
  // Login studio default HANYA lewat Google (email terverifikasi, 2FA & pemulihan akun diurus Google, tidak ada kata sandi tersimpan).
  // Login email+kata sandi hanya bila diizinkan eksplisit, atau bila Google belum dikonfigurasi (mis. lokal/tes).
  // (lihat getter passwordLogin di bawah)
  adminIpAllowlist: String(env.ADMIN_IP_ALLOWLIST || '').split(',').map((x) => x.trim()).filter(Boolean),
  previewUrlTtlSec: Math.min(int(env.PREVIEW_URL_TTL_SEC, 3600), 3600),
  allowDemoSource: env.ALLOW_DEMO_SOURCE !== 'false',
  isProd: env.NODE_ENV === 'production',
  // Langganan (F-46). false = semua fitur terbuka tanpa batas (cocok untuk satu studio sendiri)
  billingEnabled: /^(1|true)$/i.test(env.BILLING_ENABLED || ''),
  // Nominal top up saldo yang boleh dipilih (Rupiah)
  topupNominal: String(env.TOPUP_NOMINAL || '50000,100000,250000,500000,1000000').split(',').map((x) => parseInt(x, 10)).filter((x) => x > 0 && x <= 100000000),
  // Payment gateway Midtrans (F-35)
  midtransServerKey: env.MIDTRANS_SERVER_KEY || '',
  midtransClientKey: env.MIDTRANS_CLIENT_KEY || '',
  midtransProduction: /^(1|true)$/i.test(env.MIDTRANS_PRODUCTION || ''),
  // WhatsApp Business Cloud API (F-16) — default platform; studio bisa isi miliknya sendiri
  waToken: env.WA_CLOUD_TOKEN || '',
  waPhoneNumberId: env.WA_PHONE_NUMBER_ID || '',
  waApiVersion: env.WA_API_VERSION || 'v21.0',
  waTemplateLink: env.WA_TEMPLATE_LINK || '',
  waTemplateHasil: env.WA_TEMPLATE_HASIL || '',
  waTemplatePengingat: env.WA_TEMPLATE_PENGINGAT || '',
  waTemplateLang: env.WA_TEMPLATE_LANG || 'id',
};

let passwordLoginOverride = null; // hanya untuk tes; null = ikuti env & Client ID
Object.defineProperty(config, 'passwordLogin', {
  enumerable: true,
  get() {
    if (passwordLoginOverride !== null) return passwordLoginOverride;
    return env.ALLOW_PASSWORD_LOGIN === 'true' || (!config.googleClientId && env.ALLOW_PASSWORD_LOGIN !== 'false');
  },
  set(v) { passwordLoginOverride = v === null || v === undefined ? null : !!v; },
});

if (!config.appSecret) {
  if (!['development', 'test'].includes(env.NODE_ENV)) {
    throw new Error('APP_SECRET wajib diisi (minimal 32 karakter acak). Untuk lokal, set NODE_ENV=development.');
  }
  config.appSecret = 'dev-secret-jangan-dipakai-di-production-0123456789';
} else if (config.appSecret.length < 32) {
  throw new Error('APP_SECRET terlalu pendek (minimal 32 karakter). Buat dengan: openssl rand -base64 48');
}

if (config.isProd && !config.googleClientId) {
  console.warn('[config] GOOGLE_CLIENT_ID kosong: login Google mati, login kata sandi dipakai sebagai cadangan. Isi GOOGLE_CLIENT_ID untuk produksi.');
}

function parseTrustProxy(v) {
  if (v === undefined || v === '') return 'loopback';
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  if (v === 'true') {
    console.warn('[config] TRUST_PROXY=true tidak aman; dipakai sebagai 1 hop proxy.');
    return 1;
  }
  if (v === 'false') return false;
  return v; // daftar IP/subnet, mis. "loopback, 172.16.0.0/12"
}

module.exports = config;
