'use strict';
// Saldo studio: top up lewat QRIS statis (dikonfirmasi manual super admin), dipakai membayar paket bulanan.
// Semua perubahan saldo terjadi di dalam transaksi dengan row lock dan tercatat di saldo_mutasi (append-only).
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const plans = require('./plans');
const { notify } = require('./notify');
const { HttpError, bad, notFound } = require('./http');

const MAX_PENDING = 3;
const TOPUP_JAM = 24;

function nominalList() {
  // Nominal perpanjang masa coba selalu tersedia agar studio bisa top up pas
  const set = new Set(config.topupNominal);
  if (config.perpanjangHarga > 0) set.add(config.perpanjangHarga);
  return [...set].sort((a, b) => a - b);
}

async function createTopup(studioId, userId, nominal) {
  const n = Number(nominal);
  if (!nominalList().includes(n)) throw bad('Nominal top up tidak tersedia.');
  const pending = await db.one("SELECT count(*)::int AS n FROM topups WHERE studio_id=$1 AND status='menunggu' AND kedaluwarsa > now()", [studioId]);
  if (pending.n >= MAX_PENDING) throw bad(`Masih ada ${pending.n} top up menunggu konfirmasi. Selesaikan atau batalkan dulu.`);
  // Kode unik 1–999 ditambahkan ke nominal agar transfer mudah dicocokkan dengan mutasi rekening
  const global = await db.one("SELECT count(*)::int AS n FROM topups WHERE status='menunggu' AND kedaluwarsa > now()");
  if (global.n >= 500) throw new HttpError(503, 'Antrean top up sedang penuh. Coba lagi nanti.');
  for (let i = 0; i < 30; i++) {
    const kode = crypto.randomInt(1, 1000);
    // Jumlah transfer yang sama tidak dipakai ulang dalam 7 hari, agar transfer telat tidak tertukar ke studio lain
    const dipakai = await db.one("SELECT 1 FROM topups WHERE jumlah_transfer=$1 AND dibuat_pada > now() - interval '7 days'", [n + kode]);
    if (dipakai) continue;
    try {
      return await db.one(`INSERT INTO topups(studio_id, nominal, kode_unik, jumlah_transfer, dibuat_oleh, kedaluwarsa)
        VALUES ($1,$2,$3,$4,$5, now() + interval '${TOPUP_JAM} hours') RETURNING *`, [studioId, n, kode, n + kode, userId]);
    } catch (e) {
      if (e.code !== '23505') throw e; // bentrok kode unik: coba lagi
    }
  }
  throw new HttpError(503, 'Sedang ramai, coba lagi sebentar.');
}

async function cancelTopup(studioId, id) {
  const r = await db.q("UPDATE topups SET status='batal', diproses_pada=now() WHERE id=$1 AND studio_id=$2 AND status='menunggu'", [id, studioId]);
  if (!r.rowCount) throw bad('Top up tidak bisa dibatalkan.');
}

async function addLedger(c, studioId, jenis, jumlah, saldoAkhir, keterangan, ref, aktor) {
  await c.query('INSERT INTO saldo_mutasi(studio_id, jenis, jumlah, saldo_akhir, keterangan, ref, aktor) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [studioId, jenis, jumlah, saldoAkhir, keterangan, ref, aktor]);
}

// Super admin menyetujui setelah mencocokkan mutasi rekening. Idempoten: hanya status 'menunggu' yang diproses.
async function approveTopup(id, aktor) {
  const out = await db.tx(async (c) => {
    const t = (await c.query('SELECT * FROM topups WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!t) throw notFound('Top up tidak ditemukan.');
    if (t.status !== 'menunggu') throw bad(`Top up sudah ${t.status}.`);
    if (new Date(t.kedaluwarsa) < Date.now()) throw bad('Top up sudah kedaluwarsa. Minta studio membuat top up baru, atau koreksi saldo manual dengan alasan.');
    const s = (await c.query('UPDATE studios SET saldo = saldo + $2 WHERE id=$1 RETURNING saldo', [t.studio_id, t.jumlah_transfer])).rows[0];
    await c.query("UPDATE topups SET status='disetujui', diproses_oleh=$2, diproses_pada=now() WHERE id=$1", [id, aktor]);
    await addLedger(c, t.studio_id, 'topup', Number(t.jumlah_transfer), Number(s.saldo), `Top up QRIS #${t.id}`, `topup:${t.id}`, aktor);
    return { studio_id: t.studio_id, jumlah: Number(t.jumlah_transfer), saldo: Number(s.saldo) };
  });
  await notify(out.studio_id, null, 'saldo', `Top up ${rupiah(out.jumlah)} disetujui. Saldo sekarang ${rupiah(out.saldo)}.`);
  return out;
}

async function rejectTopup(id, aktor, catatan) {
  const t = await db.one(`UPDATE topups SET status='ditolak', diproses_oleh=$2, diproses_pada=now(), catatan=$3
    WHERE id=$1 AND status='menunggu' RETURNING studio_id, jumlah_transfer`, [id, aktor, catatan || null]);
  if (!t) throw bad('Top up tidak bisa ditolak (sudah diproses).');
  await notify(t.studio_id, null, 'saldo', `Top up ${rupiah(t.jumlah_transfer)} ditolak${catatan ? ': ' + catatan : ''}.`);
}

// Koreksi manual super admin (+/-). Constraint saldo >= 0 menolak koreksi yang membuat saldo minus.
async function koreksi(studioId, jumlah, keterangan, aktor) {
  if (!Number.isSafeInteger(jumlah) || jumlah === 0 || Math.abs(jumlah) > 1e10) throw bad('Jumlah koreksi tidak valid.');
  if (!keterangan) throw bad('Keterangan koreksi wajib diisi.');
  return db.tx(async (c) => {
    const s = (await c.query('SELECT saldo FROM studios WHERE id=$1 FOR UPDATE', [studioId])).rows[0];
    if (!s) throw notFound();
    if (Number(s.saldo) + jumlah < 0) throw bad('Saldo tidak boleh minus.');
    const r = (await c.query('UPDATE studios SET saldo = saldo + $2 WHERE id=$1 RETURNING saldo', [studioId, jumlah])).rows[0];
    await addLedger(c, studioId, 'koreksi', jumlah, Number(r.saldo), keterangan, null, aktor);
    return Number(r.saldo);
  });
}

function hargaPaket(planKode, bulan) {
  const p = plans.PLANS[planKode];
  if (!p || !p.harga) throw bad('Paket ini tidak bisa dibayar dari saldo. Hubungi kami untuk paket Bisnis.');
  if (![1, 12].includes(bulan)) throw bad('Pilih 1 atau 12 bulan.');
  return { p, total: bulan === 12 ? p.harga * 10 : p.harga }; // tahunan: hemat 2 bulan
}

// Bayar paket dari saldo. Masa aktif diperpanjang dari akhir masa sekarang bila paketnya sama dan masih aktif.
async function bayarPaket(studioId, planKode, bulan, aktor) {
  const { p, total } = hargaPaket(planKode, bulan);
  return db.tx(async (c) => {
    const st = (await c.query('SELECT id, saldo, plan, plan_sampai FROM studios WHERE id=$1 FOR UPDATE', [studioId])).rows[0];
    if (!st) throw notFound();
    if (Number(st.saldo) < total) throw new HttpError(402, `Saldo kurang. Butuh ${rupiah(total)}, saldo ${rupiah(st.saldo)}. Top up dulu.`, { topup: true });
    const r = (await c.query(`UPDATE studios SET saldo = saldo - $2, plan = $3,
        plan_sampai = (CASE WHEN plan = $3 AND plan_sampai > now() THEN plan_sampai ELSE now() END) + ($4 || ' months')::interval
      WHERE id=$1 RETURNING saldo, plan_sampai`, [studioId, total, planKode, String(bulan)])).rows[0];
    await addLedger(c, studioId, 'bayar_paket', -total, Number(r.saldo), `Paket ${p.nama} ${bulan} bulan`, `paket:${planKode}:${bulan}`, aktor);
    return { saldo: Number(r.saldo), plan_sampai: r.plan_sampai, total };
  });
}

// Perpanjang masa coba gratis: potong saldo, tambah N hari dari akhir masa coba (atau dari sekarang bila sudah habis)
async function perpanjangCoba(studioId, aktor) {
  const harga = config.perpanjangHarga; const hari = config.perpanjangHari;
  return db.tx(async (c) => {
    const st = (await c.query('SELECT * FROM studios WHERE id=$1 FOR UPDATE', [studioId])).rows[0];
    if (!st) throw notFound();
    if (plans.effectivePlan(st) !== 'gratis') throw bad('Studio sedang memakai paket berbayar; tidak perlu memperpanjang masa coba.');
    if (Number(st.saldo) < harga) throw new HttpError(402, `Saldo kurang. Perpanjang ${hari} hari butuh ${rupiah(harga)}, saldo ${rupiah(st.saldo)}. Top up dulu.`, { topup: true, nominal: harga });
    const dari = new Date(Math.max(plans.trialSampai(st).getTime(), Date.now()));
    const sampai = new Date(dari.getTime() + hari * 86400000);
    const r = (await c.query("UPDATE studios SET saldo = saldo - $2, plan='gratis', plan_sampai=$3 WHERE id=$1 RETURNING saldo", [studioId, harga, sampai])).rows[0];
    await addLedger(c, studioId, 'bayar_paket', -harga, Number(r.saldo), `Perpanjang coba gratis ${hari} hari`, `coba:${hari}`, aktor);
    return { saldo: Number(r.saldo), trial_sampai: sampai, harga, hari };
  });
}

// Perpanjang otomatis dari saldo menjelang masa paket habis
async function autoRenew() {
  if (!config.billingEnabled) return 0;
  const rows = await db.many(`SELECT id, plan FROM studios WHERE aktif AND perpanjang_otomatis AND plan <> 'gratis' AND plan <> 'bisnis'
    AND plan_sampai IS NOT NULL AND plan_sampai < now() + interval '12 hours' AND plan_sampai > now() - interval '30 days'`);
  let n = 0;
  for (const s of rows) {
    try {
      await bayarPaket(s.id, s.plan, 1, 'sistem');
      n += 1;
    } catch (e) {
      if (e.status !== 402) { console.error('[autoRenew]', s.id, e.message); continue; }
      const sudah = await db.one("SELECT 1 FROM notifikasis WHERE studio_id=$1 AND jenis='saldo_kurang' AND dibuat_pada > now() - interval '24 hours'", [s.id]);
      if (!sudah) await notify(s.id, null, 'saldo_kurang', `Saldo tidak cukup untuk memperpanjang paket. ${e.message}`);
    }
  }
  await db.q("UPDATE topups SET status='batal', catatan='Kedaluwarsa' WHERE status='menunggu' AND kedaluwarsa < now()");
  return n;
}

function rupiah(n) { return 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID'); }

let timer = null;
function start() {
  timer = setInterval(() => autoRenew().catch((e) => console.error('[saldo]', e.message)), 5 * 60 * 1000);
  timer.unref();
  setTimeout(() => autoRenew().catch(() => {}), 20000).unref();
}

module.exports = { perpanjangCoba, nominalList, createTopup, cancelTopup, approveTopup, rejectTopup, koreksi, bayarPaket, hargaPaket, autoRenew, start, MAX_PENDING };
