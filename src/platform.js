'use strict';
// Pengaturan bisnis platform (langganan, masa coba, traktir kopi, harga paket) yang diatur super admin
// dari halaman admin. Disimpan di platform_settings ('cfg:<kunci>'); nilai .env hanya jadi bawaan.
const config = require('./config');
const db = require('./db');
const plans = require('./plans');
const { bad } = require('./http');

const int = (min, max) => (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return `Harus bilangan bulat ${min}–${max.toLocaleString('id-ID')}.`;
  return true;
};

// set(nilai) menerapkan ke config / plans; get() membaca nilai berlaku
const FIELDS = [
  { k: 'billing_aktif', grup: 'umum', label: 'Langganan aktif (mode SaaS)', jenis: 'bool',
    hint: 'Mati = semua studio bebas memakai semua fitur tanpa batas (cocok untuk satu studio sendiri).',
    get: () => config.billingEnabled, set: (v) => { config.billingEnabled = v; } },
  { k: 'gratis_hari', grup: 'gratis', label: 'Masa coba gratis studio baru', jenis: 'int', satuan: 'hari', cek: int(0, 365),
    get: () => config.gratisHari, set: (v) => { config.gratisHari = v; } },
  { k: 'kopi_harga', grup: 'gratis', label: 'Harga traktir kopi', jenis: 'int', satuan: 'Rp', cek: int(0, 10000000),
    hint: '0 = sembunyikan tombol traktir kopi.', get: () => config.perpanjangHarga, set: (v) => { config.perpanjangHarga = v; } },
  { k: 'kopi_hari', grup: 'gratis', label: 'Tambahan paket Gratis per traktir kopi', jenis: 'int', satuan: 'hari', cek: int(1, 365),
    get: () => config.perpanjangHari, set: (v) => { config.perpanjangHari = v; } },
  { k: 'gratis_sesi', grup: 'gratis', label: 'Kuota galeri paket Gratis', jenis: 'int', satuan: 'galeri/bulan', cek: int(1, 100000),
    get: () => plans.PLANS.gratis.sesi, set: (v) => { plans.PLANS.gratis.sesi = v; } },
  { k: 'gratis_pengguna', grup: 'gratis', label: 'Pengguna paket Gratis', jenis: 'int', satuan: 'orang', cek: int(1, 1000),
    get: () => plans.PLANS.gratis.pengguna, set: (v) => { plans.PLANS.gratis.pengguna = v; } },
  { k: 'topup_nominal', grup: 'saldo', label: 'Pilihan nominal top up QRIS', jenis: 'list', satuan: 'Rp, pisahkan koma',
    cek: (v) => (Array.isArray(v) && v.length >= 1 && v.length <= 12 && v.every((x) => Number.isInteger(x) && x >= 1000 && x <= 100000000)) || 'Isi 1–12 nominal, masing-masing Rp 1.000–100.000.000.',
    get: () => config.topupNominal, set: (v) => { config.topupNominal = v; } },
];
for (const p of ['starter', 'pro']) {
  const nama = p === 'pro' ? 'Pro' : 'Starter';
  FIELDS.push(
    { k: `${p}_harga`, grup: p, label: `Harga paket ${nama}`, jenis: 'int', satuan: 'Rp/bulan', cek: int(1000, 100000000),
      get: () => plans.PLANS[p].harga, set: (v) => { plans.PLANS[p].harga = v; } },
    { k: `${p}_sesi`, grup: p, label: `Kuota galeri ${nama}`, jenis: 'int', satuan: 'galeri/bulan', cek: int(1, 1000000),
      get: () => plans.PLANS[p].sesi, set: (v) => { plans.PLANS[p].sesi = v; } },
    { k: `${p}_pengguna`, grup: p, label: `Pengguna ${nama}`, jenis: 'int', satuan: 'orang', cek: int(1, 10000),
      get: () => plans.PLANS[p].pengguna, set: (v) => { plans.PLANS[p].pengguna = v; } },
  );
}
const GRUP = {
  umum: 'Umum', gratis: 'Paket Gratis, masa coba & traktir kopi', saldo: 'Saldo & top up', starter: 'Paket Starter', pro: 'Paket Pro',
};
const BY = Object.fromEntries(FIELDS.map((f) => [f.k, f]));
const DEFAULT = Object.fromEntries(FIELDS.map((f) => [f.k, JSON.parse(JSON.stringify(f.get()))])); // dari .env / kode

function parse(f, raw) {
  if (f.jenis === 'bool') return raw === true || raw === 'true';
  if (f.jenis === 'list') {
    const arr = (Array.isArray(raw) ? raw : String(raw).split(/[,;\s]+/)).map((x) => parseInt(String(x).replace(/\./g, ''), 10)).filter((x) => !Number.isNaN(x));
    return [...new Set(arr)].sort((a, b) => a - b);
  }
  return typeof raw === 'number' ? raw : parseInt(String(raw).replace(/\./g, ''), 10);
}

let tersimpan = {};
async function reload() {
  const rows = await db.many("SELECT kunci, nilai, waktu, diubah_oleh FROM platform_settings WHERE kunci LIKE 'cfg:%'");
  tersimpan = {};
  for (const r of rows) {
    const f = BY[r.kunci.slice(4)];
    if (!f) continue;
    try { tersimpan[f.k] = { nilai: JSON.parse(r.nilai), waktu: r.waktu, oleh: r.diubah_oleh }; } catch { /* abaikan */ }
  }
  for (const f of FIELDS) f.set(tersimpan[f.k] ? tersimpan[f.k].nilai : JSON.parse(JSON.stringify(DEFAULT[f.k])));
}

function summary() {
  return Object.entries(GRUP).map(([g, nama]) => ({
    grup: g, nama,
    fields: FIELDS.filter((f) => f.grup === g).map((f) => ({
      k: f.k, label: f.label, jenis: f.jenis, satuan: f.satuan || null, hint: f.hint || null,
      nilai: f.get(), bawaan: DEFAULT[f.k], diatur: !!tersimpan[f.k],
      diubah_pada: tersimpan[f.k] ? tersimpan[f.k].waktu : null, diubah_oleh: tersimpan[f.k] ? tersimpan[f.k].oleh : null,
    })),
  }));
}

// Simpan beberapa kunci sekaligus (semua divalidasi dulu). null / '' = kembali ke bawaan.
async function save(changes, aktor) {
  const ops = [];
  for (const [k, raw] of Object.entries(changes || {})) {
    const f = BY[k];
    if (!f) throw bad(`Pengaturan tidak dikenal: ${k}`);
    if (raw === null || raw === '') { ops.push({ k, hapus: true }); continue; }
    const v = parse(f, raw);
    const ok = f.cek ? f.cek(v) : true;
    if (ok !== true) throw bad(`${f.label}: ${ok}`);
    ops.push({ k, v });
  }
  await db.tx(async (c) => {
    for (const o of ops) {
      if (o.hapus) await c.query('DELETE FROM platform_settings WHERE kunci=$1', ['cfg:' + o.k]);
      else {
        await c.query(`INSERT INTO platform_settings(kunci, nilai, waktu, diubah_oleh) VALUES ($1,$2, now(), $3)
          ON CONFLICT (kunci) DO UPDATE SET nilai=$2, waktu=now(), diubah_oleh=$3`, ['cfg:' + o.k, JSON.stringify(o.v), aktor]);
      }
    }
  });
  await reload();
  return ops.map((o) => ({ kunci: o.k, nilai: o.hapus ? 'bawaan' : o.v }));
}

function start() {
  setInterval(() => reload().catch((e) => console.error('[platform]', e.message)), 60000).unref();
}

module.exports = { FIELDS, reload, summary, save, start };
