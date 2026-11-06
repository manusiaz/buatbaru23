'use strict';
// WhatsApp Business Cloud API (Meta) — F-16. Pesan pembuka ke pelanggan wajib template yang sudah disetujui;
// tanpa template, dikirim sebagai teks (hanya sampai bila pelanggan pernah chat dalam 24 jam terakhir).
const config = require('./config');
const db = require('./db');
const { decrypt } = require('./security');

function credsFor(studio) {
  if (studio.wa_phone_number_id && studio.wa_token_enc) {
    try { return { phoneId: studio.wa_phone_number_id, token: decrypt(studio.wa_token_enc) }; } catch { /* abaikan */ }
  }
  if (config.waToken && config.waPhoneNumberId) return { phoneId: config.waPhoneNumberId, token: config.waToken };
  return null;
}
function configured(studio) { return !!credsFor(studio); }

// template: { name, params: [..] } | null ; text: fallback
async function send(studio, { sesiId, to, jenis, template, text }) {
  const cred = credsFor(studio);
  if (!cred) throw new Error('WhatsApp API belum dikonfigurasi.');
  if (!to) throw new Error('Nomor WhatsApp pelanggan kosong.');
  const body = template && template.name
    ? { messaging_product: 'whatsapp', to, type: 'template', template: { name: template.name, language: { code: config.waTemplateLang },
      components: [{ type: 'body', parameters: template.params.map((t) => ({ type: 'text', text: String(t).slice(0, 1000) })) }] } }
    : { messaging_product: 'whatsapp', to, type: 'text', text: { body: String(text).slice(0, 4000), preview_url: true } };
  let status = 'terkirim'; let pesanId = null; let error = null;
  try {
    const res = await fetch(`https://graph.facebook.com/${config.waApiVersion}/${cred.phoneId}/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${cred.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { status = 'gagal'; error = (j.error && j.error.message) || `HTTP ${res.status}`; } else pesanId = j.messages && j.messages[0] && j.messages[0].id;
  } catch (e) { status = 'gagal'; error = e.message; }
  await db.q('INSERT INTO wa_logs(studio_id, sesi_id, tujuan, jenis, status, pesan_id, error) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [studio.id, sesiId || null, to, jenis, status, pesanId, error]);
  if (status === 'gagal') throw new Error(`WhatsApp gagal: ${error}`);
  return { pesan_id: pesanId };
}

module.exports = { send, configured };
