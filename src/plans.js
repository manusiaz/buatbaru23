'use strict';
// Paket langganan studio (F-46). Angka dari tabel hipotesis PRD.
const config = require('./config');
const db = require('./db');
const { HttpError } = require('./http');

const PLANS = {
  gratis: { nama: 'Gratis', harga: 0, sesi: 10, pengguna: 1, fitur: [] , label: true },
  starter: { nama: 'Starter', harga: 149000, sesi: 150, pengguna: 3, fitur: ['branding'] },
  pro: { nama: 'Pro', harga: 399000, sesi: 600, pengguna: 10, fitur: ['branding', 'wa_api', 'laporan', 'kiosk', 'bayar_online', 'drive_terpilih', 'csv_massal'] },
  bisnis: { nama: 'Bisnis', harga: null, sesi: Infinity, pengguna: Infinity, fitur: ['branding', 'wa_api', 'laporan', 'kiosk', 'bayar_online', 'drive_terpilih', 'csv_massal', 'multi_cabang'] },
};
const FITUR_NAMA = {
  branding: 'Branding studio penuh', wa_api: 'WhatsApp otomatis', laporan: 'Laporan', kiosk: 'Mode kiosk',
  bayar_online: 'Pembayaran online', drive_terpilih: 'Salin ke folder Terpilih', csv_massal: 'Buat sesi massal (CSV)', multi_cabang: 'Multi-cabang',
};

function effectivePlan(studio) {
  if (!config.billingEnabled) return 'bisnis';
  if (studio.plan !== 'gratis' && studio.plan_sampai && new Date(studio.plan_sampai) < Date.now()) return 'gratis';
  return PLANS[studio.plan] ? studio.plan : 'gratis';
}
function has(studio, fitur) { return PLANS[effectivePlan(studio)].fitur.includes(fitur); }
function requireFeature(studio, fitur) {
  if (!has(studio, fitur)) throw new HttpError(402, `${FITUR_NAMA[fitur] || fitur} butuh paket yang lebih tinggi. Buka Pengaturan › Langganan.`, { upgrade: true });
}

async function usage(studioId) {
  const r = await db.one(`SELECT
      (SELECT count(*)::int FROM sesis WHERE studio_id=$1 AND dibuat_pada >= date_trunc('month', now())) AS sesi_bulan_ini,
      (SELECT count(*)::int FROM users WHERE studio_id=$1 AND aktif) AS pengguna`, [studioId]);
  return r;
}

// Dipanggil di dalam transaksi pembuatan sesi: pakai kuota bulanan, lalu kredit musiman.
async function consumeSession(c, studio, n = 1) {
  if (!config.billingEnabled) return;
  const plan = PLANS[effectivePlan(studio)];
  if (plan.sesi === Infinity) return;
  const used = (await c.query("SELECT count(*)::int AS n FROM sesis WHERE studio_id=$1 AND dibuat_pada >= date_trunc('month', now())", [studio.id])).rows[0].n;
  const sisa = Math.max(0, plan.sesi - used);
  if (sisa >= n) return;
  const butuhKredit = n - sisa;
  const u = await c.query('UPDATE studios SET kredit_sesi = kredit_sesi - $2 WHERE id=$1 AND kredit_sesi >= $2 RETURNING kredit_sesi', [studio.id, butuhKredit]);
  if (!u.rowCount) {
    throw new HttpError(402, `Kuota ${plan.sesi} sesi/bulan paket ${plan.nama} habis. Upgrade paket atau beli kredit sesi musiman.`, { upgrade: true });
  }
}

async function checkUserLimit(studio) {
  if (!config.billingEnabled) return;
  const plan = PLANS[effectivePlan(studio)];
  const { pengguna } = await usage(studio.id);
  const pending = (await db.one('SELECT count(*)::int AS n FROM invites WHERE studio_id=$1 AND dipakai_pada IS NULL AND kedaluwarsa>now()', [studio.id])).n;
  if (pengguna + pending >= plan.pengguna) throw new HttpError(402, `Paket ${plan.nama} maksimal ${plan.pengguna} pengguna.`, { upgrade: true });
}

function summary(studio) {
  const key = effectivePlan(studio);
  const p = PLANS[key];
  return {
    billing: config.billingEnabled, plan: key, nama: p.nama, harga: p.harga, plan_sampai: studio.plan_sampai,
    batas_sesi: p.sesi === Infinity ? null : p.sesi, batas_pengguna: p.pengguna === Infinity ? null : p.pengguna,
    fitur: Object.fromEntries(Object.keys(FITUR_NAMA).map((f) => [f, p.fitur.includes(f)])),
    label_produk: !!p.label && config.billingEnabled, kredit_sesi: studio.kredit_sesi,
  };
}

module.exports = { PLANS, FITUR_NAMA, effectivePlan, has, requireFeature, usage, consumeSession, checkUserLimit, summary };
