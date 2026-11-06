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
  app.set('trust proxy', config.trustProxy === 'true' ? true : config.trustProxy);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
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
  app.use(express.json({ limit: '4mb' }));

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
