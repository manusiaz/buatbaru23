'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const media = require('./media');
const { HttpError } = require('./http');

function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    // CSP: skrip hanya dari server sendiri + Google (login, Picker). Tidak ada inline script.
    res.set('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self' https://apis.google.com https://accounts.google.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https://*.googleusercontent.com https://*.gstatic.com",
      "connect-src 'self' https://accounts.google.com https://www.googleapis.com",
      "frame-src https://accounts.google.com https://docs.google.com https://drive.google.com",
      "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'",
    ].join('; '));
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  app.get('/healthz', async (req, res) => {
    try { await db.q('SELECT 1'); res.json({ ok: true }); } catch (e) { res.status(503).json({ ok: false }); }
  });

  // Mutasi API hanya menerima JSON (lapis CSRF: form lintas situs tidak bisa mengirim application/json tanpa preflight)
  app.use(['/api', '/g/:token/api'], (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json')) {
      return next(new HttpError(415, 'Content-Type harus application/json.'));
    }
    next();
  });
  // Batas body: 5 MB hanya untuk unggahan gambar & CSV massal, selain itu 256 KB
  const bigBody = /^\/api\/(studio\/logo|langganan\/topup\/\d+\/bukti|admin\/qris|sesis\/massal)$/;
  app.use((req, res, next) => express.json({ limit: bigBody.test(req.path) ? '5mb' : '256kb' })(req, res, next));

  // Muat setting integrasi dari database sekali sebelum request pertama
  let integrasiSiap = null;
  app.use((req, res, next) => {
    if (!integrasiSiap) integrasiSiap = Promise.all([require('./integrasi').reload(), require('./platform').reload()]).catch((e) => { integrasiSiap = null; throw e; });
    integrasiSiap.then(() => next(), next);
  });
  app.use('/api/webhooks', require('./routes/webhooks'));
  app.use('/api', require('./routes/studio'));
  app.use('/g/:token/api', require('./routes/client'));
  app.get('/media/:sesiId/:fotoId/:kind', media.handler);

  app.get('/logo/:studioId', async (req, res) => {
    const st = await db.one('SELECT logo_path FROM studios WHERE id=$1', [parseInt(req.params.studioId, 10) || 0]).catch(() => null);
    if (!st || !st.logo_path) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=300');
    res.sendFile(path.join(config.dataDir, 'logos', path.basename(st.logo_path)));
  });

  const pub = path.join(__dirname, '..', 'public');
  const page = (file) => (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(pub, file));
  };
  app.get('/', page('index.html'));
  app.get(['/masuk', '/daftar'], page('masuk.html'));
  app.get('/undangan/:token', page('masuk.html'));
  app.get('/app', page('app.html'));
  app.get(['/g/:token', '/g/:token/:nomor'], (req, res, next) => {
    if (req.params.nomor && !/^\d{1,5}$/.test(req.params.nomor)) return next();
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.sendFile(path.join(pub, 'galeri.html'));
  });
  app.get('/privasi', page('privasi.html'));
  app.get(['/.well-known/security.txt', '/security.txt'], (req, res) => {
    const exp = new Date(Date.now() + 180 * 86400000).toISOString();
    res.type('text/plain').send(`Contact: ${config.securityContact || 'mailto:security@' + new URL(config.baseUrl).hostname}\nExpires: ${exp}\nPreferred-Languages: id, en\nCanonical: ${config.baseUrl}/.well-known/security.txt\n`);
  });
  app.use(express.static(pub, { index: false, maxAge: config.isProd ? '1h' : 0 }));

  // Error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    const msg = status >= 500 ? 'Terjadi kesalahan di server. Coba lagi.' : err.message;
    if (req.path.startsWith('/api') || req.path.includes('/api/')) {
      return res.status(status).json({ error: msg, ...(err.extra || {}) });
    }
    res.status(status).type('text').send(msg);
  });

  fs.mkdirSync(path.join(config.dataDir, 'previews'), { recursive: true });
  return app;
}

module.exports = { createApp };
