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
  trustProxy: env.TRUST_PROXY || 'loopback',
  previewUrlTtlSec: Math.min(int(env.PREVIEW_URL_TTL_SEC, 3600), 3600),
  allowDemoSource: env.ALLOW_DEMO_SOURCE !== 'false',
  isProd: env.NODE_ENV === 'production',
  // Langganan (F-46). false = semua fitur terbuka tanpa batas (cocok untuk satu studio sendiri)
  billingEnabled: /^(1|true)$/i.test(env.BILLING_ENABLED || ''),
  superadminEmails: String(env.SUPERADMIN_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
  kreditPaket: int(env.KREDIT_PAKET_SESI, 100),
  kreditHarga: int(env.KREDIT_PAKET_HARGA, 149000),
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
  waTemplateLang: env.WA_TEMPLATE_LANG || 'id',
};

if (!config.appSecret) {
  if (config.isProd) {
    throw new Error('APP_SECRET wajib diisi di production (minimal 32 karakter acak).');
  }
  config.appSecret = 'dev-secret-jangan-dipakai-di-production-0123456789';
}

module.exports = config;
