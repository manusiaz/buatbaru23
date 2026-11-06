'use strict';
// Notifikasi pembayaran Midtrans (publik, diverifikasi dengan signature_key)
const express = require('express');
const db = require('../db');
const payment = require('../payment');
const S = require('../sesi');
const { notify } = require('../notify');
const { ah } = require('../http');

const r = express.Router();

r.post('/midtrans', ah(async (req, res) => {
  const n = req.body || {};
  if (!payment.verifyNotification(n)) return res.status(403).json({ error: 'signature tidak valid' });
  const orderId = String(n.order_id || '');
  const paid = payment.isPaid(n);
  const amount = Math.round(Number(n.gross_amount));
  if (orderId.startsWith('GS-T-')) {
    const t = await db.one('SELECT t.*, s.studio_id, s.judul FROM tagihans t JOIN sesis s ON s.id=t.sesi_id WHERE t.order_id=$1', [orderId]);
    if (!t) return res.json({ ok: true, abaikan: true });
    // Harus melunasi total TERKINI (link lama tidak berlaku setelah pilihan berubah)
    if (paid && t.status_bayar !== 'lunas' && amount === Number(t.payment_total) && amount >= Number(t.total_rupiah)) {
      await db.q("UPDATE tagihans SET status_bayar='lunas', metode=$2, dibayar_pada=now(), diubah_pada=now() WHERE sesi_id=$1", [t.sesi_id, payment.methodLabel(n)]);
      await S.logEvent(null, t.sesi_id, 'bayar', 'midtrans', { status_bayar: 'lunas', metode: payment.methodLabel(n) });
      await notify(t.studio_id, t.sesi_id, 'bayar', `${t.judul} membayar foto tambahan Rp ${amount.toLocaleString('id-ID')} (${payment.methodLabel(n)})`);
    } else if (['expire', 'cancel', 'deny'].includes(n.transaction_status)) {
      await db.q('UPDATE tagihans SET payment_url=NULL, order_id=NULL WHERE sesi_id=$1 AND order_id=$2', [t.sesi_id, orderId]);
    }
  }
  res.json({ ok: true });
}));

module.exports = r;
