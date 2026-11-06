'use strict';
// Midtrans Snap (QRIS, virtual account, e-wallet) — F-35 & tagihan langganan.
const crypto = require('crypto');
const config = require('./config');

function enabled() { return !!config.midtransServerKey; }
function base() { return config.midtransProduction ? 'https://app.midtrans.com' : 'https://app.sandbox.midtrans.com'; }

async function createSnap({ orderId, amount, items, customer, finishUrl }) {
  if (!enabled()) throw new Error('Payment gateway belum dikonfigurasi (MIDTRANS_SERVER_KEY).');
  const res = await fetch(`${base()}/snap/v1/transactions`, {
    method: 'POST',
    headers: { authorization: 'Basic ' + Buffer.from(config.midtransServerKey + ':').toString('base64'), 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      transaction_details: { order_id: orderId, gross_amount: amount },
      item_details: items,
      customer_details: customer,
      enabled_payments: ['other_qris', 'gopay', 'shopeepay', 'bca_va', 'bni_va', 'bri_va', 'permata_va', 'echannel', 'other_va'],
      callbacks: finishUrl ? { finish: finishUrl } : undefined,
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Midtrans: ${(j.error_messages || []).join(', ') || res.status}`);
  return { token: j.token, url: j.redirect_url };
}

// Verifikasi notifikasi HTTP: signature_key = SHA512(order_id + status_code + gross_amount + server_key)
function verifyNotification(n) {
  if (!enabled() || !n || !n.signature_key) return false;
  const sig = crypto.createHash('sha512').update(`${n.order_id}${n.status_code}${n.gross_amount}${config.midtransServerKey}`).digest('hex');
  const a = Buffer.from(sig); const b = Buffer.from(String(n.signature_key));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function isPaid(n) {
  return (n.transaction_status === 'settlement') || (n.transaction_status === 'capture' && n.fraud_status !== 'deny' && n.fraud_status !== 'challenge');
}
function methodLabel(n) {
  if (n.payment_type === 'qris') return 'QRIS';
  if (n.payment_type === 'bank_transfer' || n.payment_type === 'echannel') return `VA ${((n.va_numbers && n.va_numbers[0] && n.va_numbers[0].bank) || n.bank || 'mandiri').toUpperCase()}`;
  return n.payment_type || 'Online';
}

module.exports = { enabled, createSnap, verifyNotification, isPaid, methodLabel };
