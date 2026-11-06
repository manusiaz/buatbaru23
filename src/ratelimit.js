'use strict';
// Rate limit sederhana di memori per IP (cukup untuk satu instance; untuk multi-instance pakai limiter di reverse proxy).
const { HttpError } = require('./http');

const buckets = new Map();
function hit(key, max, windowSec) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowSec * 1000 }; buckets.set(key, b); }
  b.n += 1;
  return b.n <= max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, 60000).unref();

function limit(name, max, windowSec) {
  return (req, res, next) => {
    if (!hit(`${name}:${req.ip}`, max, windowSec)) return next(new HttpError(429, 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.'));
    next();
  };
}
module.exports = { limit, hit, _reset: () => buckets.clear() };
