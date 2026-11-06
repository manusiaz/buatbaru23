'use strict';
const config = require('./config');
const db = require('./db');

let transporter = null;
function mailer() {
  if (!config.smtpUrl) return null;
  if (!transporter) transporter = require('nodemailer').createTransport(config.smtpUrl);
  return transporter;
}

// Notifikasi in-app untuk studio + email ke owner/admin bila SMTP dikonfigurasi (F-40).
async function notify(studioId, sesiId, jenis, pesan, { email = true } = {}) {
  await db.q('INSERT INTO notifikasis(studio_id, sesi_id, jenis, pesan) VALUES ($1,$2,$3,$4)', [studioId, sesiId, jenis, pesan]);
  const m = mailer();
  if (!m || !email) return;
  try {
    const to = await db.many("SELECT email FROM users WHERE studio_id=$1 AND aktif AND peran IN ('owner','admin')", [studioId]);
    if (!to.length) return;
    const link = sesiId ? `${config.baseUrl}/app#/galeri/${sesiId}` : `${config.baseUrl}/app`;
    await m.sendMail({
      from: config.mailFrom || `"${config.appName}" <no-reply@localhost>`,
      to: to.map((r) => r.email).join(','),
      subject: `[${config.appName}] ${pesan}`,
      text: `${pesan}\n\nBuka: ${link}`,
    });
  } catch (e) {
    console.error('[notify] email gagal:', e.message);
  }
}

module.exports = { notify };
