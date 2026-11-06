'use strict';
const bcrypt = require('bcryptjs');
const db = require('./db');
const config = require('./config');
const { randomToken, sha256 } = require('./security');
const { HttpError, forbidden, parseCookies, setCookie } = require('./http');

const COOKIE = 'gs_sid';
const TTL_DAYS = 30;

async function hashPassword(p) { return bcrypt.hash(p, 11); }
async function checkPassword(p, h) { return h ? bcrypt.compare(p, h) : false; }

async function createLogin(req, res, userId) {
  const token = randomToken(32);
  await db.q(`INSERT INTO user_sessions(token_hash, user_id, user_agent, kedaluwarsa)
    VALUES ($1,$2,$3, now() + interval '${TTL_DAYS} days')`, [sha256(token), userId, String(req.headers['user-agent'] || '').slice(0, 200)]);
  setCookie(res, req, COOKIE, token, { maxAge: TTL_DAYS * 86400 });
}

async function destroyLogin(req, res) {
  const t = parseCookies(req)[COOKIE];
  if (t) await db.q('DELETE FROM user_sessions WHERE token_hash=$1', [sha256(t)]);
  setCookie(res, req, COOKIE, '', { maxAge: 0 });
}

async function currentUser(req) {
  if (req._userLoaded) return req.user;
  req._userLoaded = true;
  const t = parseCookies(req)[COOKIE];
  if (!t) return null;
  const u = await db.one(`SELECT u.id, u.studio_id, u.nama, u.email, u.peran, u.cabang_id, u.superadmin, (u.google_sub IS NOT NULL) AS google_terhubung,
      s.token_hash AS sid, s.sudo_sampai, st.aktif AS studio_aktif
    FROM user_sessions s JOIN users u ON u.id=s.user_id JOIN studios st ON st.id=u.studio_id
    WHERE s.token_hash=$1 AND s.kedaluwarsa > now() AND u.aktif`, [sha256(t)]);
  // Studio yang dinonaktifkan super admin tidak bisa dipakai (kecuali oleh super admin)
  req.user = u && (u.studio_aktif || u.superadmin) ? u : null;
  return req.user;
}

// Hak akses per peran (RBAC). Server menegakkan semua yang disembunyikan UI.
const PERMS = {
  owner: ['studio.edit', 'tim.kelola', 'paket.kelola', 'sesi.kelola', 'sesi.hapus', 'sesi.lihat', 'tagihan.kelola', 'editor.kerja'],
  admin: ['paket.lihat', 'sesi.kelola', 'sesi.hapus', 'sesi.lihat', 'tagihan.kelola', 'editor.kerja'],
  editor: ['sesi.lihat', 'editor.kerja'],
};
function can(user, perm) {
  if (!user) return false;
  const p = PERMS[user.peran] || [];
  if (perm === 'paket.lihat') return p.includes('paket.lihat') || p.includes('paket.kelola');
  return p.includes(perm);
}

function ipAllowed(ip) {
  const list = config.adminIpAllowlist;
  if (!list.length) return true;
  const clean = String(ip || '').replace(/^::ffff:/, '');
  return list.some((x) => {
    if (!x.includes('/')) return x === clean;
    const [net, bits] = x.split('/');
    const toInt = (a) => a.split('.').reduce((n, o) => (n << 8) + (parseInt(o, 10) & 255), 0) >>> 0;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(clean) || !/^\d+\.\d+\.\d+\.\d+$/.test(net)) return false;
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return (toInt(clean) & mask) === (toInt(net) & mask);
  });
}

function requireSuperadmin() {
  return async (req, res, next) => {
    try {
      const u = await currentUser(req);
      if (!u || !u.superadmin) throw forbidden('Khusus super admin.');
      if (!ipAllowed(req.ip)) throw forbidden('Akses super admin tidak diizinkan dari jaringan ini.');
      res.set('Cache-Control', 'no-store');
      next();
    } catch (e) { next(e); }
  };
}

// Sudo mode: aksi paling sensitif butuh konfirmasi identitas ulang dalam 10 menit terakhir
const SUDO_MENIT = 10;
function requireSudo() {
  return async (req, res, next) => {
    try {
      const u = await currentUser(req);
      if (!u || !u.sudo_sampai || new Date(u.sudo_sampai) < Date.now()) throw new HttpError(403, 'Konfirmasi identitas dulu.', { sudo: true });
      next();
    } catch (e) { next(e); }
  };
}
async function grantSudo(user) {
  const r = await db.one(`UPDATE user_sessions SET sudo_sampai = now() + interval '${SUDO_MENIT} minutes' WHERE token_hash=$1 RETURNING sudo_sampai`, [user.sid]);
  return r.sudo_sampai;
}

function requireUser(perm) {
  return async (req, res, next) => {
    try {
      const u = await currentUser(req);
      if (!u) throw new HttpError(401, 'Silakan masuk dulu.');
      if (perm && !can(u, perm)) throw forbidden();
      next();
    } catch (e) { next(e); }
  };
}

module.exports = { requireSudo, grantSudo, SUDO_MENIT, requireSuperadmin, hashPassword, checkPassword, createLogin, destroyLogin, currentUser, requireUser, can, PERMS, COOKIE };
