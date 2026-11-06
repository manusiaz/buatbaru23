'use strict';
class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const bad = (m, x) => new HttpError(400, m, x);
const forbidden = (m = 'Tidak punya akses.') => new HttpError(403, m);
const notFound = (m = 'Tidak ditemukan.') => new HttpError(404, m);

// Bungkus handler async agar error diteruskan ke error handler Express
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function str(v, { max = 200, required = false, name = 'Field' } = {}) {
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (required && !s) throw bad(`${name} wajib diisi.`);
  if (s.length > max) throw bad(`${name} terlalu panjang (maks ${max}).`);
  return s;
}
function int(v, { min = 0, max = 1e9, name = 'Angka', def } = {}) {
  if ((v === undefined || v === null || v === '') && def !== undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} harus bilangan bulat ${min}–${max}.`);
  return n;
}
function bool(v) { return v === true || v === 'true' || v === 1 || v === '1' || v === 'on'; }

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}
function setCookie(res, req, name, value, { maxAge, path = '/' } = {}) {
  const secure = req.secure ? '; Secure' : '';
  const age = maxAge === undefined ? '' : `; Max-Age=${maxAge}`;
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax${secure}${age}`);
}

module.exports = { HttpError, bad, forbidden, notFound, ah, str, int, bool, parseCookies, setCookie };
