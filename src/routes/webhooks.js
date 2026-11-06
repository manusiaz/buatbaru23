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
    if (paid && t.status_bayar !== 'lunas' && amount === Number(t.payment_total)) {
      await db.q("UPDATE tagihans SET status_bayar='lunas', metode=$2, dibayar_pada=now(), diubah_pada=now() WHERE sesi_id=$1", [t.sesi_id, payment.methodLabel(n)]);
      await S.logEvent(null, t.sesi_id, 'bayar', 'midtrans', { status_bayar: 'lunas', metode: payment.methodLabel(n) });
      await notify(t.studio_id, t.sesi_id, 'bayar', `${t.judul} membayar foto tambahan Rp ${amount.toLocaleString('id-ID')} (${payment.methodLabel(n)})`);
    } else if (['expire', 'cancel', 'deny'].includes(n.transaction_status)) {
      await db.q('UPDATE tagihans SET payment_url=NULL, order_id=NULL WHERE sesi_id=$1 AND order_id=$2', [t.sesi_id, orderId]);
    }
  } else if (orderId.startsWith('GS-I-')) {
    await db.tx(async (c) => {
      const inv = (await c.query('SELECT * FROM invoices WHERE order_id=$1 FOR UPDATE', [orderId])).rows[0];
      if (!inv || inv.status === 'lunas') return;
      if (paid && amount === Number(inv.jumlah)) {
        await c.query("UPDATE invoices SET status='lunas', dibayar_pada=now() WHERE id=$1", [inv.id]);
        if (inv.jenis === 'kredit') await c.query('UPDATE studios SET kredit_sesi=kredit_sesi+$2 WHERE id=$1', [inv.studio_id, inv.kredit]);
        else {
          await c.query(`UPDATE studios SET plan=$2, plan_sampai = (CASE WHEN plan=$2 AND plan_sampai > now() THEN plan_sampai ELSE now() END) + ($3 || ' months')::interval
            WHERE id=$1`, [inv.studio_id, inv.plan, String(inv.bulan)]);
        }
      } else if (['expire', 'cancel', 'deny'].includes(n.transaction_status)) {
        await c.query("UPDATE invoices SET status='batal' WHERE id=$1", [inv.id]);
      }
    });
  }
  res.json({ ok: true });
}));

module.exports = r;
