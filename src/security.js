'use strict';
const crypto = require('crypto');
const config = require('./config');

const key = crypto.createHash('sha256').update('enc:' + config.appSecret).digest();

function randomToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64url');
}
function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}
function hmac(s) {
  return crypto.createHmac('sha256', config.appSecret).update(String(s)).digest('base64url');
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url');
}
function decrypt(blob) {
  const b = Buffer.from(blob, 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function randomPin(len = 6) {
  let s = '';
  for (let i = 0; i < len; i++) s += crypto.randomInt(0, 10);
  return s;
}

// PIN di-hash scrypt dengan salt acak (bukan sha256 polos yang bisa dibalik dalam sekejap)
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pin), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64url')}$${h.toString('base64url')}`;
}
function verifyPin(pin, stored) {
  const s = String(stored || '');
  if (s.startsWith('scrypt$')) {
    const [, salt, hash] = s.split('$');
    const h = crypto.scryptSync(String(pin), Buffer.from(salt, 'base64url'), 32, { N: 16384, r: 8, p: 1 });
    const want = Buffer.from(hash, 'base64url');
    return want.length === h.length && crypto.timingSafeEqual(want, h);
  }
  return safeEqual(sha256(`pin:${pin}`), s); // format lama
}

module.exports = { hashPin, verifyPin, randomToken, sha256, hmac, encrypt, decrypt, safeEqual, randomPin };
