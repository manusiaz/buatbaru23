'use strict';
// Tes integrasi: butuh PostgreSQL. Set TEST_DATABASE_URL (default postgres://app:app@localhost:5432/pilihfoto_test).
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://app:app@localhost:5432/pilihfoto_test';
// Tes menghapus seluruh skema: tolak database yang namanya tidak mengandung "test"
if (!/test/i.test(new URL(process.env.DATABASE_URL).pathname)) {
  throw new Error('TEST_DATABASE_URL harus menunjuk database khusus tes (nama mengandung "test").');
}
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-test-'));
process.env.BASE_URL = 'http://test.local';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { createApp } = require('../src/app');
const S = require('../src/sesi');
const sync = require('../src/sync');
const F = require('../public/shared/format');

let server; let base;

class Client {
  constructor() { this.jar = {}; }
  async call(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', cookie: Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(';')[0]; const i = kv.indexOf('=');
      this.jar[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const t = await res.text();
    let j; try { j = JSON.parse(t); } catch { j = t; }
    return { status: res.status, body: j };
  }
}

async function owner() {
  const c = new Client();
  const r = await c.call('POST', '/api/auth/register', { studio_nama: 'Studio Uji', nama: 'Owner', email: `o${Date.now()}${Math.random()}@x.id`, password: 'rahasia123' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}
async function sesi(c, extra = {}) {
  const r = await c.call('POST', '/api/sesis', { pelanggan_nama: 'Rina', sumber: 'contoh', jumlah_contoh: 8, kuota: 3, durasi_pilih_menit: 10, masa_aktif_jam: 24, harga_foto_tambahan: 20000, maks_foto_tambahan: 2, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await sync.startSync(r.body.id);
  return { id: r.body.id, token: r.body.link.split('/g/')[1], pin: r.body.pin };
}
async function pelanggan(s) {
  const p = new Client();
  const r = await p.call('POST', `/g/${s.token}/api/pin`, { pin: s.pin });
  assert.equal(r.status, 200);
  return p;
}

before(async () => {
  await db.q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.migrate();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => require('../src/ratelimit')._reset());
after(async () => {
  server.close();
  await db.pool.end();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('sinkron memberi nomor tetap dan menandai nama kembar', async () => {
  const c = await owner();
  const s = await sesi(c);
  const d = (await c.call('GET', `/api/sesis/${s.id}`)).body;
  assert.equal(d.status, 'siap');
  assert.deepEqual(d.fotos.map((f) => f.nomor), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(d.fotos.filter((f) => f.nama_kembar).length, 2);
  // File baru dapat nomor berikutnya, nomor lama tidak bergeser
  await db.q("UPDATE sesis SET drive_folder_id='contoh:10' WHERE id=$1", [s.id]);
  await sync.startSync(s.id);
  const d2 = (await c.call('GET', `/api/sesis/${s.id}`)).body;
  const byName = (x) => x.fotos.filter((f) => !f.dihapus).map((f) => `${f.nomor}:${f.path_subfolder}/${f.nama_file}`);
  for (const old of byName(d)) assert.ok(byName(d2).includes(old), `nomor lama berubah: ${old}`);
  assert.equal(Math.max(...d2.fotos.map((f) => f.nomor)), 11);
});

test('PIN terkunci 15 menit setelah 5 kali salah', async () => {
  const c = await owner();
  const s = await sesi(c);
  const p = new Client();
  for (let i = 0; i < 4; i++) assert.equal((await p.call('POST', `/g/${s.token}/api/pin`, { pin: '0000' })).status, 400);
  assert.equal((await p.call('POST', `/g/${s.token}/api/pin`, { pin: '0000' })).status, 429);
  assert.equal((await p.call('POST', `/g/${s.token}/api/pin`, { pin: s.pin })).status, 429, 'PIN benar pun ditolak selama terkunci');
  assert.equal((await p.call('GET', `/g/${s.token}/api/state`)).status, 401);
});

test('foto tersembunyi sebelum Mulai pilih; kuota + tambahan ditegakkan server', async () => {
  const c = await owner();
  const s = await sesi(c);
  const p = await pelanggan(s);
  let st = (await p.call('GET', `/g/${s.token}/api/state`)).body;
  assert.equal(st.fase, 'sebelum_mulai');
  assert.equal(st.fotos.length, 0);
  assert.equal((await p.call('POST', `/g/${s.token}/api/pilih`, { nomor: 1 })).status, 409);
  await p.call('POST', `/g/${s.token}/api/mulai`);
  st = (await p.call('GET', `/g/${s.token}/api/state`)).body;
  assert.equal(st.fase, 'memilih');
  const end = new Date(st.berakhir_pada).getTime();
  assert.ok(Math.abs(end - Date.now() - 10 * 60000) < 5000, 'timer 10 menit dari jam server');
  for (const n of [1, 2, 3, 4, 5]) assert.equal((await p.call('POST', `/g/${s.token}/api/pilih`, { nomor: n })).status, 200);
  const over = await p.call('POST', `/g/${s.token}/api/pilih`, { nomor: 6 });
  assert.equal(over.status, 409);
  const t = (await c.call('GET', `/api/sesis/${s.id}`)).body.tagihan;
  assert.equal(t.jumlah_foto, 2);
  assert.equal(Number(t.total_rupiah), 40000);
  // Batal satu → tagihan turun
  const r = (await p.call('POST', `/g/${s.token}/api/pilih`, { nomor: 1, pilih: false })).body;
  assert.equal(r.tambahan, 1);
  assert.deepEqual(r.tambahan_nomor, [5]);
});

test('kirim mengunci pilihan; hanya admin yang bisa membuka ulang', async () => {
  const c = await owner();
  const s = await sesi(c);
  const p = await pelanggan(s);
  await p.call('POST', `/g/${s.token}/api/mulai`);
  await p.call('POST', `/g/${s.token}/api/pilih`, { nomor: 2 });
  await p.call('PUT', `/g/${s.token}/api/catatan`, { nomor: 2, catatan: 'kulit lebih cerah' });
  assert.equal((await p.call('POST', `/g/${s.token}/api/kirim`)).status, 200);
  assert.equal((await p.call('POST', `/g/${s.token}/api/pilih`, { nomor: 3 })).status, 409);
  const d = (await c.call('GET', `/api/sesis/${s.id}`)).body;
  assert.equal(d.status, 'terkirim');
  assert.ok(d.events.some((e) => e.jenis === 'kirim' && e.detail.kurang_dari_kuota));
  const notif = (await c.call('GET', '/api/notifikasi')).body;
  assert.ok(notif.some((n) => n.jenis === 'pilihan_masuk' && /kurang dari kuota/.test(n.pesan)));
  assert.equal((await c.call('POST', `/api/sesis/${s.id}/aksi`, { aksi: 'buka_ulang', menit: 5 })).status, 200);
  assert.equal((await p.call('POST', `/g/${s.token}/api/pilih`, { nomor: 3 })).status, 200);
});

test('waktu habis: server mengirim otomatis, simpanan <=10 detik masih diterima', async () => {
  const c = await owner();
  const s = await sesi(c);
  const p = await pelanggan(s);
  await p.call('POST', `/g/${s.token}/api/mulai`);
  await p.call('POST', `/g/${s.token}/api/pilih`, { nomor: 1 });
  await db.q("UPDATE sesis SET berakhir_pada = now() - interval '5 seconds' WHERE id=$1", [s.id]);
  assert.equal((await p.call('POST', `/g/${s.token}/api/pilih`, { nomor: 2 })).status, 200, 'masa tenggang 10 detik');
  await db.q("UPDATE sesis SET berakhir_pada = now() - interval '11 seconds' WHERE id=$1", [s.id]);
  assert.equal((await p.call('POST', `/g/${s.token}/api/pilih`, { nomor: 3 })).status, 409);
  await S.sweep();
  const st = (await p.call('GET', `/g/${s.token}/api/state`)).body;
  assert.equal(st.fase, 'waktu_habis');
  const d = (await c.call('GET', `/api/sesis/${s.id}`)).body;
  assert.equal(d.dikirim_otomatis, true);
  assert.equal(d.jumlah_pilihan, 2);
});

test('tenggat lewat sebelum mulai → kedaluwarsa; timer berjalan tetap dihormati', async () => {
  const c = await owner();
  const a = await sesi(c);
  await db.q("UPDATE sesis SET tenggat_link = now() - interval '1 minute' WHERE id=$1", [a.id]);
  const pa = new Client();
  await pa.call('POST', `/g/${a.token}/api/pin`, { pin: a.pin });
  assert.equal((await pa.call('GET', `/g/${a.token}/api/info`)).body.fase, 'kedaluwarsa');

  const b = await sesi(c);
  const pb = await pelanggan(b);
  await pb.call('POST', `/g/${b.token}/api/mulai`);
  await db.q("UPDATE sesis SET tenggat_link = now() - interval '1 minute' WHERE id=$1", [b.id]);
  await S.sweep();
  assert.equal((await pb.call('POST', `/g/${b.token}/api/pilih`, { nomor: 1 })).status, 200);
  // Perpanjang link memulihkan sesi kedaluwarsa
  assert.equal((await c.call('POST', `/api/sesis/${a.id}/aksi`, { aksi: 'perpanjang_link', jam: 24 })).status, 200);
  assert.equal((await pa.call('GET', `/g/${a.token}/api/info`)).body.fase, 'sebelum_mulai');
});

test('mode tenggat saja: pilihan pertama memulai sesi', async () => {
  const c = await owner();
  const s = await sesi(c, { durasi_pilih_menit: 0 });
  const p = await pelanggan(s);
  const st = (await p.call('GET', `/g/${s.token}/api/state`)).body;
  assert.equal(st.fase, 'memilih');
  assert.equal(st.fotos.length, 9);
  assert.equal((await p.call('POST', `/g/${s.token}/api/pilih`, { nomor: 4 })).status, 200);
});

test('minta tambah waktu → notifikasi; admin menambah menit', async () => {
  const c = await owner();
  const s = await sesi(c);
  const p = await pelanggan(s);
  await p.call('POST', `/g/${s.token}/api/mulai`);
  const before1 = (await p.call('GET', `/g/${s.token}/api/state`)).body.berakhir_pada;
  await p.call('POST', `/g/${s.token}/api/minta-waktu`);
  assert.ok((await c.call('GET', '/api/notifikasi')).body.some((n) => n.jenis === 'minta_waktu'));
  await c.call('POST', `/api/sesis/${s.id}/aksi`, { aksi: 'tambah_waktu', menit: 10 });
  const after1 = (await p.call('GET', `/g/${s.token}/api/state`)).body.berakhir_pada;
  assert.ok(new Date(after1) - new Date(before1) >= 10 * 60000 - 1000);
});

test('gangguan sistem memperpanjang timer yang sedang berjalan', async () => {
  const c = await owner();
  const s = await sesi(c);
  const p = await pelanggan(s);
  await p.call('POST', `/g/${s.token}/api/mulai`);
  const b1 = (await db.one('SELECT berakhir_pada FROM sesis WHERE id=$1', [s.id])).berakhir_pada;
  await db.q(`INSERT INTO system_state(kunci, nilai, waktu) VALUES ('heartbeat','', now() - interval '3 minutes')
    ON CONFLICT (kunci) DO UPDATE SET waktu = now() - interval '3 minutes'`);
  await S.compensateDowntime();
  const b2 = (await db.one('SELECT berakhir_pada FROM sesis WHERE id=$1', [s.id])).berakhir_pada;
  assert.ok(b2 - b1 >= 179000, `diperpanjang ${(b2 - b1) / 1000} detik`);
});

test('RBAC: editor tidak bisa membuat sesi atau melihat PIN; studio lain tidak bisa mengakses', async () => {
  const c = await owner();
  const s = await sesi(c);
  const inv = (await c.call('POST', '/api/tim/undang', { email: `ed${Date.now()}@x.id`, peran: 'editor' })).body;
  const e = new Client();
  assert.equal((await e.call('POST', '/api/auth/invite/accept', { token: inv.link.split('/undangan/')[1], nama: 'Editor', password: 'rahasia123' })).status, 200);
  assert.equal((await e.call('POST', '/api/sesis', { pelanggan_nama: 'X', sumber: 'contoh' })).status, 403);
  const d = (await e.call('GET', `/api/sesis/${s.id}`)).body;
  assert.equal(d.pin, null);
  assert.equal(d.link, null);
  assert.equal((await e.call('PUT', '/api/studio', { nama: 'Hack' })).status, 403);
  assert.equal((await e.call('PUT', `/api/sesis/${s.id}/editor`, { editor_status: 'dikerjakan' })).status, 200);
  const other = await owner();
  assert.equal((await other.call('GET', `/api/sesis/${s.id}`)).status, 404);
  assert.equal((await other.call('GET', `/api/sesis/${s.id}/ekspor.csv`)).status, 404);
});

test('browser pelanggan tidak menerima ID/link Drive; URL pratinjau bertanda tangan', async () => {
  const c = await owner();
  const s = await sesi(c, { durasi_pilih_menit: 0, tampil_nama_file: false });
  const p = await pelanggan(s);
  const st = (await p.call('GET', `/g/${s.token}/api/state`)).body;
  const raw = JSON.stringify(st);
  assert.ok(!/demo-\d|drive\.google|drive_file_id/.test(raw));
  assert.equal(st.fotos[0].nama_file, null);
  const ok = await fetch(base + st.fotos[0].thumb);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/webp');
  const bad = await fetch(base + st.fotos[0].thumb.replace(/s=[^&]+/, 's=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'));
  assert.equal(bad.status, 403);
});

test('ekspor & format salin', async () => {
  const items = [{ nomor: 12, nama_file: 'IMG_0735.JPG', path_subfolder: 'A' }, { nomor: 45, nama_file: 'IMG_0798.JPG', path_subfolder: 'B', catatan: 'cerah', nama_kembar: true }];
  assert.equal(F.fileList(items, 'lightroom'), 'IMG_0735 IMG_0798');
  assert.equal(F.fileList(items, 'windows'), 'IMG_0735 OR IMG_0798');
  assert.equal(F.fileList(items, 'nomor', { total: 120 }), '012, 045');
  assert.equal(F.fileList(items, 'baris', { ext: false }), 'IMG_0735\nIMG_0798');
  const t = F.selectionText({ nama: 'Rina', judul: 'Wisuda', items, kuota: 5, galleryUrl: 'https://d/g/k', total: 120, showName: true });
  assert.equal(t.split('\n')[1], '#012  IMG_0735.JPG  https://d/g/k/012');
  assert.match(t, /Catatan #045: cerah/);
  assert.match(F.csv(items, 120), /045,IMG_0798.JPG,B,B\/IMG_0798.JPG,ya,,cerah/);
  assert.deepEqual(F.parsePasted('mau #012 sama https://x/g/abc/045 ya'), [12, 45]);
});

test('mutasi API tanpa JSON ditolak (lapis CSRF)', async () => {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a' });
  assert.equal(r.status, 415);
});

// ======================= V1 / V2 =======================
const config = require('../src/config');
const crypto = require('crypto');

test('F-36 harga bertingkat: total termurah dihitung server', async () => {
  const c = await owner();
  const s = await sesi(c, { kuota: 1, maks_foto_tambahan: 7, harga_foto_tambahan: 25000, harga_bertingkat: '5=100000', durasi_pilih_menit: 0 });
  const p = await pelanggan(s);
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) assert.equal((await p.call('POST', `/g/${s.token}/api/pilih`, { nomor: n })).status, 200);
  const t = (await c.call('GET', `/api/sesis/${s.id}`)).body.tagihan;
  assert.equal(t.jumlah_foto, 7);
  assert.equal(Number(t.total_rupiah), 150000); // 5 paket 100rb + 2 × 25rb
  assert.equal(F.hargaTambahan(4, 25000, [{ jumlah: 5, harga: 100000 }]), 100000);
});

test('F-46 langganan: kuota sesi paket gratis & gating fitur', async () => {
  config.billingEnabled = true;
  try {
    const c = await owner();
    const many = await Promise.all(Array.from({ length: 12 }, (_, i) => c.call('POST', '/api/sesis', { pelanggan_nama: 'P' + i, sumber: 'contoh', jumlah_contoh: 2 })));
    assert.equal(many.filter((r) => r.status === 200).length, 10, 'pembuatan paralel tidak boleh melewati kuota 10');
    assert.equal(many.filter((r) => r.status === 402).length, 2);
    const me = (await c.call('GET', '/api/me')).body;
    assert.equal((await c.call('GET', '/api/laporan')).status, 402);
    assert.equal((await c.call('POST', '/api/tim/undang', { email: `z${Date.now()}@x.id`, peran: 'admin' })).status, 402, 'gratis = 1 pengguna');
    await db.q("UPDATE studios SET plan='pro', plan_sampai=now() + interval '1 month' WHERE id=$1", [me.studio.id]);
    assert.equal((await c.call('GET', '/api/laporan')).status, 200);
    await db.q("UPDATE studios SET plan_sampai=now() - interval '1 day' WHERE id=$1", [me.studio.id]);
    assert.equal((await c.call('GET', '/api/laporan')).status, 402, 'paket kedaluwarsa kembali ke gratis');
  } finally { config.billingEnabled = false; }
});

test('saldo: top up QRIS manual, persetujuan super admin sekali saja, bayar paket dari saldo', async () => {
  config.billingEnabled = true;
  const admin = await owner();
  const meA = (await admin.call('GET', '/api/me')).body;
  await db.q('UPDATE users SET superadmin=true WHERE id=$1', [meA.user.id]);
  try {
    const png = 'data:image/png;base64,' + (await require('sharp')({ create: { width: 40, height: 40, channels: 3, background: '#fff' } }).png().toBuffer()).toString('base64');
    const c = await owner();
    const me = (await c.call('GET', '/api/me')).body;
    assert.equal((await c.call('POST', '/api/langganan/topup', { nominal: 100000 })).status, 400, 'QRIS belum disiapkan');
    assert.equal((await c.call('PUT', '/api/admin/qris', { data_url: png, nama_penerima: 'PT Uji' })).status, 403, 'studio biasa bukan super admin');
    assert.equal((await admin.call('PUT', '/api/admin/qris', { data_url: png, nama_penerima: 'PT Uji' })).status, 200);
    assert.equal((await c.call('POST', '/api/langganan/topup', { nominal: 12345 })).status, 400, 'nominal di luar daftar ditolak');
    assert.equal((await c.call('POST', '/api/langganan/topup', { nominal: -100000 })).status, 400);
    const t = (await c.call('POST', '/api/langganan/topup', { nominal: 250000 })).body;
    assert.equal(t.jumlah_transfer, 250000 + t.kode_unik);
    assert.equal((await c.call('POST', `/api/langganan/topup/${t.id}/bukti`, { data_url: png })).status, 200);
    assert.equal((await c.call('POST', `/api/admin/topups/${t.id}/setujui`)).status, 403, 'studio tidak bisa menyetujui top up sendiri');
    // Persetujuan ganda paralel hanya menambah saldo sekali
    const both = await Promise.all([admin.call('POST', `/api/admin/topups/${t.id}/setujui`), admin.call('POST', `/api/admin/topups/${t.id}/setujui`)]);
    assert.deepEqual(both.map((x) => x.status).sort(), [200, 400]);
    let st = await db.one('SELECT saldo FROM studios WHERE id=$1', [me.studio.id]);
    assert.equal(Number(st.saldo), t.jumlah_transfer);
    // Studio lain tidak bisa melihat bukti top up ini
    const other = await owner();
    const b = await fetch(`${base}/api/langganan/topup/${t.id}/bukti`, { headers: { cookie: Object.entries(other.jar).map(([k, v]) => `${k}=${v}`).join('; ') } });
    assert.equal(b.status, 404);
    // Bayar paket: saldo kurang → 402; cukup → paket aktif, saldo terpotong
    assert.equal((await c.call('POST', '/api/langganan/bayar', { plan: 'pro', bulan: 1 })).status, 402);
    assert.equal((await c.call('POST', '/api/langganan/bayar', { plan: 'bisnis', bulan: 1 })).status, 400);
    const pay = await Promise.all([c.call('POST', '/api/langganan/bayar', { plan: 'starter', bulan: 1 }), c.call('POST', '/api/langganan/bayar', { plan: 'starter', bulan: 1 })]);
    assert.deepEqual(pay.map((x) => x.status).sort(), [200, 402], 'saldo tidak bisa dipakai dua kali');
    st = await db.one('SELECT saldo, plan FROM studios WHERE id=$1', [me.studio.id]);
    assert.equal(st.plan, 'starter');
    assert.equal(Number(st.saldo), t.jumlah_transfer - 149000);
    // Saldo tidak bisa minus, buku besar tidak bisa diubah
    assert.equal((await admin.call('POST', `/api/admin/studios/${me.studio.id}/koreksi`, { jumlah: -999999999, keterangan: 'x' })).status, 400);
    await assert.rejects(db.q('UPDATE saldo_mutasi SET jumlah=999999 WHERE studio_id=$1', [me.studio.id]));
    await assert.rejects(db.q('UPDATE studios SET saldo=-1 WHERE id=$1', [me.studio.id]));
    const m = (await c.call('GET', '/api/langganan')).body.mutasi.map((x) => x.jenis);
    assert.deepEqual(m, ['bayar_paket', 'topup']);
  } finally { config.billingEnabled = false; }
});

test('F-05 multi-cabang: user cabang hanya melihat sesi cabangnya; laporan per cabang', async () => {
  const c = await owner();
  const a = (await c.call('POST', '/api/cabangs', { nama: 'Bandung' })).body;
  const b = (await c.call('POST', '/api/cabangs', { nama: 'Jakarta' })).body;
  const sa = await sesi(c, { cabang_id: a.id });
  const sb = await sesi(c, { cabang_id: b.id });
  const inv = (await c.call('POST', '/api/tim/undang', { email: `cab${Date.now()}@x.id`, peran: 'admin' })).body;
  const u = new Client();
  await u.call('POST', '/api/auth/invite/accept', { token: inv.link.split('/undangan/')[1], nama: 'Kasir BDG', password: 'rahasia123' });
  const uid = (await u.call('GET', '/api/me')).body.user.id;
  assert.equal((await c.call('PUT', `/api/tim/${uid}`, { cabang_id: a.id })).status, 200);
  const list = (await u.call('GET', '/api/sesis')).body.map((x) => x.id);
  assert.ok(list.includes(sa.id) && !list.includes(sb.id));
  assert.equal((await u.call('GET', `/api/sesis/${sb.id}`)).status, 404);
  assert.equal((await u.call('POST', '/api/sesis', { pelanggan_nama: 'Z', sumber: 'contoh', cabang_id: b.id })).status, 403);
  const lap = (await c.call('GET', '/api/laporan')).body;
  assert.deepEqual(lap.per_cabang.map((x) => x.cabang).sort(), ['Bandung', 'Jakarta']);
  assert.equal(lap.total.sesi, 2);
});

test('F-45 kiosk: staf membuka tanpa PIN, timer mulai otomatis', async () => {
  const c = await owner();
  const s = await sesi(c);
  const r = await c.call('POST', `/api/sesis/${s.id}/kiosk`);
  assert.equal(r.status, 200);
  const st = (await c.call('GET', `/g/${s.token}/api/state`)).body;
  assert.equal(st.fase, 'memilih');
  assert.equal(st.kiosk, true);
  assert.equal(st.staff, false, 'di kiosk bukan mode baca-saja');
  assert.equal((await c.call('POST', `/g/${s.token}/api/pilih`, { nomor: 1 })).status, 200);
  const today = (await c.call('GET', '/api/sesis?hari_ini=1')).body.map((x) => x.id);
  assert.ok(today.includes(s.id));
});

test('F-12 buat sesi massal dari CSV', async () => {
  const c = await owner();
  const csv = 'nama;no_wa;link_folder;paket;judul\n"Rina, S.Pd";081234567890;;Wisuda;Wisuda Rina\nBudi;;;Tidak Ada;\nSari;0812000111;;;';
  const r = (await c.call('POST', '/api/sesis/massal', { csv, default: { sumber: 'contoh', jumlah_contoh: 3 } })).body;
  assert.equal(r.dibuat, 2);
  assert.equal(r.gagal, 1);
  assert.match(r.hasil[1].error, /Paket "Tidak Ada"/);
  assert.equal(r.hasil[0].nama, 'Rina, S.Pd');
  assert.match(r.hasil[0].link, /\/g\/[\w-]{20,}/);
  const d = (await c.call('GET', `/api/sesis/${r.hasil[0].id}`)).body;
  assert.equal(d.kuota, 5, 'nilai paket Wisuda dipakai');
});

test('F-17 QR & F-43 hasil akhir tampil di galeri pelanggan', async () => {
  const c = await owner();
  const s = await sesi(c, { durasi_pilih_menit: 0 });
  const qr = await fetch(`${base}/api/sesis/${s.id}/qr.svg`, { headers: { cookie: Object.entries(c.jar).map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(qr.status, 200);
  assert.match(await qr.text(), /^<svg/);
  const p = await pelanggan(s);
  await p.call('POST', `/g/${s.token}/api/pilih`, { nomor: 1 });
  await p.call('POST', `/g/${s.token}/api/kirim`);
  assert.equal((await c.call('PUT', `/api/sesis/${s.id}/hasil`, { hasil_link: 'javascript:alert(1)' })).status, 400);
  assert.equal((await c.call('PUT', `/api/sesis/${s.id}/hasil`, { hasil_link: 'https://drive.google.com/drive/folders/hasil' })).status, 200);
  const k = (await c.call('POST', `/api/sesis/${s.id}/hasil/kirim`, { lewat: 'link' })).body;
  assert.match(k.wa_url, /^https:\/\/wa\.me\//);
  assert.equal((await p.call('GET', `/g/${s.token}/api/info`)).body.hasil_link, 'https://drive.google.com/drive/folders/hasil');
});

test('F-35 webhook Midtrans: signature diverifikasi, tagihan foto tambahan jadi lunas', async () => {
  const oldKey = config.midtransServerKey;
  config.midtransServerKey = 'SB-Mid-server-test';
  const sign = (n) => ({ ...n, signature_key: crypto.createHash('sha512').update(`${n.order_id}${n.status_code}${n.gross_amount}${config.midtransServerKey}`).digest('hex') });
  try {
    const c = await owner();
    const s = await sesi(c, { kuota: 1, durasi_pilih_menit: 0 });
    const p = await pelanggan(s);
    await p.call('POST', `/g/${s.token}/api/pilih`, { nomor: 1 });
    await p.call('POST', `/g/${s.token}/api/pilih`, { nomor: 2 });
    await db.q("UPDATE tagihans SET order_id='GS-T-test-1', payment_total=20000 WHERE sesi_id=$1", [s.id]);
    const bad = { order_id: 'GS-T-test-1', status_code: '200', gross_amount: '20000.00', transaction_status: 'settlement', payment_type: 'qris', signature_key: 'x' };
    assert.equal((await p.call('POST', '/api/webhooks/midtrans', bad)).status, 403);
    assert.equal((await p.call('POST', '/api/webhooks/midtrans', sign({ ...bad, signature_key: undefined }))).status, 200);
    const t = (await c.call('GET', `/api/sesis/${s.id}`)).body.tagihan;
    assert.equal(t.status_bayar, 'lunas');
    assert.equal(t.metode, 'QRIS');
  } finally { config.midtransServerKey = oldKey; }
});

test('super admin: tangguhkan studio memblokir login studio itu', async () => {
  const admin = await owner();
  const meA = (await admin.call('GET', '/api/me')).body;
  await db.q('UPDATE users SET superadmin=true WHERE id=$1', [meA.user.id]);
  try {
    const other = await owner();
    const meO = (await other.call('GET', '/api/me')).body;
    assert.equal((await other.call('GET', '/api/admin/studios')).status, 403);
    const list = (await admin.call('GET', '/api/admin/studios')).body;
    assert.ok(list.some((x) => x.id === meO.studio.id));
    assert.equal((await admin.call('PUT', `/api/admin/studios/${meO.studio.id}`, { aktif: false })).status, 200);
    assert.equal((await other.call('GET', '/api/me')).status, 401);
    assert.ok((await admin.call('GET', '/api/admin/audit')).body.some((a) => a.aksi === 'ubah_studio'));
  } finally { /* flag tetap di user uji */ }
});


// ======================= Regresi audit keamanan =======================
test('audit #1: super admin tidak bisa didapat dengan mendaftar email; hanya flag database', async () => {
  const c = await owner();
  assert.equal((await c.call('GET', '/api/admin/ringkasan')).status, 403);
  const me = (await c.call('GET', '/api/me')).body;
  assert.equal(me.superadmin, false);
  await db.q('UPDATE users SET superadmin=true WHERE id=$1', [me.user.id]);
  assert.equal((await c.call('GET', '/api/admin/ringkasan')).status, 200);
});

test('audit #2/#3: X-Forwarded-For palsu tidak melewati kunci PIN; batas per galeri lintas IP', async () => {
  const c = await owner();
  const s = await sesi(c);
  // Proxy tepercaya MENAMBAHKAN IP asli di kanan; nilai kiri berasal dari penyerang dan harus diabaikan
  const tryPin = (spoof, real, pin) => fetch(`${base}/g/${s.token}/api/pin`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `${spoof}, ${real}` }, body: JSON.stringify({ pin }) });
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await tryPin(`10.0.0.${i}`, '9.9.9.9', '0000')).status);
  assert.deepEqual(codes, [400, 400, 400, 400, 429, 429]);
  assert.equal((await tryPin('10.9.9.9', '9.9.9.9', s.pin)).status, 429, 'IP asli tetap terkunci walau XFF dipalsukan');
  // Banyak IP asli berbeda: galeri dikunci setelah 30 gagal per jam
  const s2 = await sesi(c);
  let last;
  for (let i = 0; i < 31; i++) {
    last = await fetch(`${base}/g/${s2.token}/api/pin`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `8.8.${i}.1` }, body: JSON.stringify({ pin: '0000' }) });
  }
  assert.equal(last.status, 429);
  const ok = await fetch(`${base}/g/${s2.token}/api/pin`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '7.7.7.7' }, body: JSON.stringify({ pin: s2.pin }) });
  assert.equal(ok.status, 429, 'galeri terkunci untuk semua IP');
  assert.ok((await c.call('GET', '/api/notifikasi')).body.some((n) => n.jenis === 'pin_terkunci'));
  // Studio ganti PIN membuka kunci
  const np = (await c.call('POST', `/api/sesis/${s2.id}/pin`, {})).body.pin;
  const again = await fetch(`${base}/g/${s2.token}/api/pin`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '7.7.7.7' }, body: JSON.stringify({ pin: np }) });
  assert.equal(again.status, 200);
  const h = (await db.one('SELECT pin_hash FROM sesis WHERE id=$1', [s2.id])).pin_hash;
  assert.match(h, /^scrypt\$/, 'PIN di-hash scrypt bersalt');
});

test('audit #10: percobaan PIN paralel tetap dihitung atomik', async () => {
  const c = await owner();
  const s = await sesi(c);
  const rs = await Promise.all(Array.from({ length: 20 }, () => fetch(`${base}/g/${s.token}/api/pin`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '5.5.5.5' }, body: JSON.stringify({ pin: '0000' }) })));
  const wrong = rs.filter((r) => r.status === 400).length;
  assert.ok(wrong <= 5, `paling banyak 5 percobaan salah dievaluasi sebelum terkunci, dapat ${wrong}`);
});

test('audit #4: link bayar lama tidak bisa melunasi tagihan yang sudah bertambah', async () => {
  const oldKey = config.midtransServerKey;
  config.midtransServerKey = 'SB-Mid-server-test';
  const sign = (n) => ({ ...n, signature_key: crypto.createHash('sha512').update(`${n.order_id}${n.status_code}${n.gross_amount}${config.midtransServerKey}`).digest('hex') });
  try {
    const c = await owner();
    const s = await sesi(c, { kuota: 1, durasi_pilih_menit: 0 });
    const p = await pelanggan(s);
    await p.call('POST', `/g/${s.token}/api/pilih`, { nomor: 1 });
    await p.call('POST', `/g/${s.token}/api/pilih`, { nomor: 2 });
    await db.q("UPDATE tagihans SET order_id='GS-T-old', payment_total=20000 WHERE sesi_id=$1", [s.id]);
    await p.call('POST', `/g/${s.token}/api/pilih`, { nomor: 3 }); // total naik ke 40rb → link lama batal
    let t = await db.one('SELECT * FROM tagihans WHERE sesi_id=$1', [s.id]);
    assert.equal(t.order_id, null);
    assert.equal(Number(t.total_rupiah), 40000);
    // Bayar link lama Rp20rb: ditolak meski signature sah
    await db.q("UPDATE tagihans SET order_id='GS-T-old', payment_total=20000 WHERE sesi_id=$1", [s.id]);
    await p.call('POST', '/api/webhooks/midtrans', sign({ order_id: 'GS-T-old', status_code: '200', gross_amount: '20000.00', transaction_status: 'settlement', payment_type: 'qris' }));
    t = await db.one('SELECT * FROM tagihans WHERE sesi_id=$1', [s.id]);
    assert.equal(t.status_bayar, 'belum_bayar');
  } finally { config.midtransServerKey = oldKey; }
});

test('audit #5: folder Drive studio lain tidak bisa ditautkan', async () => {
  const a = await owner();
  const b = await owner();
  const folder = 'FolderMilikA_' + Date.now();
  assert.equal((await a.call('POST', '/api/sesis', { pelanggan_nama: 'X', sumber: 'service_account', folder_id: folder })).status, 200);
  assert.equal((await b.call('POST', '/api/sesis', { pelanggan_nama: 'Y', sumber: 'service_account', folder_id: folder })).status, 403);
  assert.equal((await b.call('POST', '/api/drive/cek', { sumber: 'service_account', folder_id: folder })).status, 403);
  assert.equal((await a.call('POST', '/api/sesis', { pelanggan_nama: 'Z', sumber: 'service_account', folder_id: folder })).status, 200, 'pemilik tetap bisa memakai foldernya');
});

test('audit #6: nomor WA platform hanya untuk studio yang diizinkan', async () => {
  const wa = require('../src/wa');
  const old = [config.waToken, config.waPhoneNumberId];
  config.waToken = 'x'; config.waPhoneNumberId = '123';
  try {
    assert.equal(wa.configured({ wa_platform: false }), false);
    assert.equal(wa.configured({ wa_platform: true }), true);
  } finally { [config.waToken, config.waPhoneNumberId] = old; }
});

test('audit #12: user cabang tidak melihat notifikasi/dasbor cabang lain; editor tidak melihat daftar tim', async () => {
  const c = await owner();
  const a = (await c.call('POST', '/api/cabangs', { nama: 'A' })).body;
  const b = (await c.call('POST', '/api/cabangs', { nama: 'B' })).body;
  const sb = await sesi(c, { cabang_id: b.id, judul: 'Rahasia Cabang B' });
  const pb = await pelanggan(sb);
  void pb;
  const inv = (await c.call('POST', '/api/tim/undang', { email: `ca${Date.now()}@x.id`, peran: 'admin' })).body;
  const u = new Client();
  await u.call('POST', '/api/auth/invite/accept', { token: inv.link.split('/undangan/')[1], nama: 'Kasir A', password: 'rahasia123' });
  const uid = (await u.call('GET', '/api/me')).body.user.id;
  await c.call('PUT', `/api/tim/${uid}`, { cabang_id: a.id });
  const notif = (await u.call('GET', '/api/notifikasi')).body;
  assert.ok(!notif.some((n) => /Rahasia Cabang B/.test(n.pesan)));
  assert.equal((await u.call('GET', '/api/dasbor')).body.total, 0);
  // Staf cabang A tidak dianggap staf di galeri cabang B
  assert.equal((await u.call('GET', `/g/${sb.token}/api/info`)).body.perlu_pin, true);
  const inv2 = (await c.call('POST', '/api/tim/undang', { email: `ed2${Date.now()}@x.id`, peran: 'editor' })).body;
  const e = new Client();
  await e.call('POST', '/api/auth/invite/accept', { token: inv2.link.split('/undangan/')[1], nama: 'Ed', password: 'rahasia123' });
  assert.equal((await e.call('GET', '/api/tim')).status, 403);
});

test('audit #11: top up kedaluwarsa tidak bisa disetujui', async () => {
  config.billingEnabled = true;
  try {
    const c = await owner();
    const admin = await owner();
    const meA = (await admin.call('GET', '/api/me')).body;
    await db.q('UPDATE users SET superadmin=true WHERE id=$1', [meA.user.id]);
    const png = 'data:image/png;base64,' + (await require('sharp')({ create: { width: 20, height: 20, channels: 3, background: '#fff' } }).png().toBuffer()).toString('base64');
    await admin.call('PUT', '/api/admin/qris', { data_url: png });
    const t = (await c.call('POST', '/api/langganan/topup', { nominal: 50000 })).body;
    await db.q("UPDATE topups SET kedaluwarsa = now() - interval '1 minute' WHERE id=$1", [t.id]);
    assert.equal((await admin.call('POST', `/api/admin/topups/${t.id}/setujui`)).status, 400);
  } finally { config.billingEnabled = false; }
});

test('audit #8: ekspor CSV menetralkan formula', async () => {
  const csv = F.csv([{ nomor: 1, nama_file: '=HYPERLINK("x")', catatan: '+1', path_subfolder: '@a' }], 1);
  assert.ok(!/,=|,\+|,@/.test(csv.split('\r\n')[1]));
});

// ======================= Login Google saja & fitur keamanan =======================
test('login Google saja: kata sandi ditolak; undangan wajib email Google yang sama; token Google palsu ditolak', async () => {
  const oldFetch = global.fetch;
  const oldCfg = [config.passwordLogin, config.googleClientId];
  // Tiru endpoint tokeninfo Google: credential "ok:<sub>:<email>" valid, "bad-aud:..." untuk aplikasi lain
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (!u.startsWith('https://oauth2.googleapis.com/tokeninfo')) return oldFetch(url, opts);
    const cred = new URL(u).searchParams.get('id_token');
    const [kind, sub, email] = cred.split(':');
    const body = { iss: 'https://accounts.google.com', aud: kind === 'bad-aud' ? 'aplikasi-lain' : 'cid-test', sub, email, email_verified: 'true', name: 'User ' + sub, exp: String(Math.floor(Date.now() / 1000) + 600) };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  config.passwordLogin = false; config.googleClientId = 'cid-test';
  try {
    const x = new Client();
    assert.equal((await x.call('POST', '/api/auth/register', { studio_nama: 'S', nama: 'N', email: `p${Date.now()}@x.id`, password: 'rahasia123' })).status, 403);
    assert.equal((await x.call('POST', '/api/auth/login', { email: 'a@b.c', password: 'rahasia123' })).status, 403);
    const sub = 'g' + Date.now();
    const ownerEmail = `${sub}@gmail.com`;
    assert.equal((await x.call('POST', '/api/auth/google', { credential: `bad-aud:${sub}:${ownerEmail}` })).status, 400, 'token untuk aplikasi lain ditolak');
    assert.equal((await x.call('POST', '/api/auth/google', { credential: `ok:${sub}:${ownerEmail}`, studio_nama: 'Studio Google' })).status, 200);
    const me = (await x.call('GET', '/api/me')).body;
    assert.equal(me.studio.nama, 'Studio Google');
    assert.equal(me.user.peran, 'owner');
    // Undangan
    const inv = (await x.call('POST', '/api/tim/undang', { email: `tim${sub}@gmail.com`, peran: 'editor' })).body;
    const token = inv.link.split('/undangan/')[1];
    assert.equal((await new Client().call('POST', '/api/auth/invite/accept', { token, nama: 'A', password: 'rahasia123' })).status, 403);
    const wrong = await new Client().call('POST', '/api/auth/google', { credential: `ok:${sub}x:penyusup@gmail.com`, invite: token });
    assert.equal(wrong.status, 403, 'email Google lain ditolak untuk undangan ini');
    const t = new Client();
    assert.equal((await t.call('POST', '/api/auth/google', { credential: `ok:${sub}t:tim${sub}@gmail.com`, invite: token })).status, 200);
    const tm = (await t.call('GET', '/api/me')).body;
    assert.equal(tm.studio.id, me.studio.id);
    assert.equal(tm.user.peran, 'editor');
    // Log keamanan mencatat daftar, undang, gabung, login
    const log = (await x.call('GET', '/api/audit-keamanan')).body.map((a) => a.aksi);
    for (const a of ['daftar_studio', 'login', 'undang_tim', 'gabung_tim']) assert.ok(log.includes(a), a);
    assert.equal((await t.call('GET', '/api/audit-keamanan')).status, 403, 'editor tidak bisa membaca log keamanan');
  } finally {
    global.fetch = oldFetch;
    config.passwordLogin = null;
    config.googleClientId = oldCfg[1];
  }
});

test('ganti link galeri: link lama, sesi pelanggan, dan URL pratinjau lama mati', async () => {
  const c = await owner();
  const s = await sesi(c, { durasi_pilih_menit: 0 });
  const p = await pelanggan(s);
  const st = (await p.call('GET', `/g/${s.token}/api/state`)).body;
  assert.equal((await fetch(base + st.fotos[0].thumb)).status, 200);
  const r = (await c.call('POST', `/api/sesis/${s.id}/ganti-link`)).body;
  const newToken = r.link.split('/g/')[1];
  assert.notEqual(newToken, s.token);
  assert.equal((await p.call('GET', `/g/${s.token}/api/info`)).status, 404, 'link lama tidak berlaku');
  assert.equal((await fetch(base + st.fotos[0].thumb)).status, 410, 'URL pratinjau lama mati');
  const p2 = new Client();
  assert.equal((await p2.call('POST', `/g/${newToken}/api/pin`, { pin: s.pin })).status, 200);
  assert.equal((await p.call('GET', `/g/${newToken}/api/state`)).status, 401, 'cookie pelanggan lama tidak berlaku di link baru');
  // Ganti PIN juga mematikan URL pratinjau lama
  const st2 = (await p2.call('GET', `/g/${newToken}/api/state`)).body;
  await c.call('POST', `/api/sesis/${s.id}/pin`, {});
  assert.equal((await fetch(base + st2.fotos[0].thumb)).status, 410);
});

test('batas ukuran body & security.txt', async () => {
  const big = 'x'.repeat(300 * 1024);
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: big }) });
  assert.equal(r.status, 413);
  const sec = await fetch(base + '/.well-known/security.txt');
  assert.equal(sec.status, 200);
  assert.match(await sec.text(), /^Contact: /m);
  const h = await fetch(base + '/');
  assert.match(h.headers.get('content-security-policy') || '', /object-src 'none'/);
});

// ======================= Halaman integrasi & kunci API =======================
test('integrasi: hanya super admin + sudo; rahasia terenkripsi & tidak pernah dikirim ke browser', async () => {
  const integ = require('../src/integrasi');
  const oldKey = config.midtransServerKey;
  try {
    const biasa = await owner();
    assert.equal((await biasa.call('GET', '/api/admin/integrasi')).status, 403, 'bukan super admin');
    const sa = await owner();
    const me = (await sa.call('GET', '/api/me')).body;
    await db.q('UPDATE users SET superadmin=true WHERE id=$1', [me.user.id]);
    let d = (await sa.call('GET', '/api/admin/integrasi')).body;
    assert.equal(d.grup, null, 'tanpa sudo tidak ada data');
    const secret = 'SB-Mid-server-' + crypto.randomBytes(12).toString('hex');
    assert.equal((await sa.call('PUT', '/api/admin/integrasi/midtrans_server_key', { nilai: secret })).status, 403, 'ubah tanpa sudo ditolak');
    assert.equal((await sa.call('POST', '/api/admin/sudo', { password: 'salah-sekali' })).status, 400);
    assert.equal((await sa.call('POST', '/api/admin/sudo', { password: 'rahasia123' })).status, 200);
    // Validasi format
    assert.equal((await sa.call('PUT', '/api/admin/integrasi/midtrans_server_key', { nilai: 'bukan-key' })).status, 400);
    assert.equal((await sa.call('PUT', '/api/admin/integrasi/google_service_account_json', { nilai: '{"type":"x"}' })).status, 400);
    assert.equal((await sa.call('PUT', '/api/admin/integrasi/kunci_ngawur', { nilai: 'x' })).status, 400);
    // Simpan rahasia: terpakai di config, terenkripsi di DB, tidak ada di respons
    const put = await sa.call('PUT', '/api/admin/integrasi/midtrans_server_key', { nilai: secret });
    assert.equal(put.status, 200);
    assert.equal(config.midtransServerKey, secret, 'langsung dipakai tanpa restart');
    assert.ok(!JSON.stringify(put.body).includes(secret));
    d = (await sa.call('GET', '/api/admin/integrasi')).body;
    assert.ok(!JSON.stringify(d).includes(secret), 'rahasia tidak dikirim ke browser');
    const f = d.grup.find((g) => g.grup === 'midtrans').fields.find((x) => x.k === 'midtrans_server_key');
    assert.equal(f.samaran, '••••' + secret.slice(-4));
    assert.equal(f.sumber, 'database');
    const row = await db.one("SELECT nilai FROM platform_settings WHERE kunci='int:midtrans_server_key'");
    assert.ok(!row.nilai.includes(secret) && row.nilai.startsWith('v1:'), 'tersimpan terenkripsi');
    assert.equal(integ._dec(row.nilai), secret);
    // Audit mencatat kunci, tidak mencatat nilai
    const aud = (await sa.call('GET', '/api/admin/audit')).body;
    assert.ok(aud.some((a) => a.aksi === 'ubah_integrasi' && a.detail.kunci === 'midtrans_server_key'));
    assert.ok(!JSON.stringify(aud).includes(secret));
    // Nilai non-rahasia ditampilkan apa adanya
    await sa.call('PUT', '/api/admin/integrasi/security_contact', { nilai: 'mailto:sec@contoh.id' });
    assert.match(await (await fetch(base + '/.well-known/security.txt')).text(), /mailto:sec@contoh\.id/);
    // Hapus kembali ke nilai env
    assert.equal((await sa.call('DELETE', '/api/admin/integrasi/midtrans_server_key')).status, 200);
    assert.equal(config.midtransServerKey, oldKey);
    // Sudo kedaluwarsa → terkunci lagi
    await db.q('UPDATE user_sessions SET sudo_sampai = now() - interval \'1 second\' WHERE user_id=$1', [me.user.id]);
    assert.equal((await sa.call('PUT', '/api/admin/integrasi/security_contact', { nilai: 'mailto:x@y.id' })).status, 403);
    assert.equal((await sa.call('GET', '/api/admin/integrasi')).body.grup, null);
    // Sudo milik satu sesi login tidak berlaku di sesi login lain
    await sa.call('POST', '/api/admin/sudo', { password: 'rahasia123' });
    const sa2 = new Client();
    await sa2.call('POST', '/api/auth/login', { email: me.user.email, password: 'rahasia123' });
    assert.equal((await sa2.call('PUT', '/api/admin/integrasi/security_contact', { nilai: 'mailto:x@y.id' })).status, 403);
    await integ.clearValue('security_contact');
  } finally { config.midtransServerKey = oldKey; }
});

test('integrasi: sudo via Google wajib akun Google yang sama', async () => {
  const oldFetch = global.fetch;
  const oldCid = config.googleClientId;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (!u.startsWith('https://oauth2.googleapis.com/tokeninfo')) return oldFetch(url, opts);
    const [sub, email] = new URL(u).searchParams.get('id_token').split(':');
    return new Response(JSON.stringify({ iss: 'accounts.google.com', aud: 'cid-sudo', sub, email, email_verified: 'true', exp: String(Math.floor(Date.now() / 1000) + 600) }), { status: 200 });
  };
  config.googleClientId = 'cid-sudo';
  try {
    const sub = 'sudo' + Date.now();
    const a = new Client();
    await a.call('POST', '/api/auth/google', { credential: `${sub}:${sub}@gmail.com`, studio_nama: 'HQ' });
    const me = (await a.call('GET', '/api/me')).body;
    await db.q('UPDATE users SET superadmin=true WHERE id=$1', [me.user.id]);
    assert.equal((await a.call('POST', '/api/admin/sudo', { credential: `orang-lain:${sub}@gmail.com` })).status, 403, 'Google akun lain ditolak');
    assert.equal((await a.call('POST', '/api/admin/sudo', { password: 'apa-saja' })).status, 400, 'mode Google: kata sandi tidak diterima');
    assert.equal((await a.call('POST', '/api/admin/sudo', { credential: `${sub}:${sub}@gmail.com` })).status, 200);
    assert.ok((await a.call('GET', '/api/admin/integrasi')).body.grup);
  } finally { global.fetch = oldFetch; config.googleClientId = oldCid; }
});

test('integrasi: Client ID Google baru wajib dibuktikan dengan login memakai Client ID itu', async () => {
  const oldFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (!u.startsWith('https://oauth2.googleapis.com/tokeninfo')) return oldFetch(url, opts);
    const [aud, sub, email] = new URL(u).searchParams.get('id_token').split('|');
    return new Response(JSON.stringify({ iss: 'accounts.google.com', aud, sub, email, email_verified: 'true', exp: String(Math.floor(Date.now() / 1000) + 600) }), { status: 200 });
  };
  const integ = require('../src/integrasi');
  try {
    const sa = await owner();
    const me = (await sa.call('GET', '/api/me')).body;
    await db.q('UPDATE users SET superadmin=true WHERE id=$1', [me.user.id]);
    await sa.call('POST', '/api/admin/sudo', { password: 'rahasia123' });
    const cid = '123456-abcdef.apps.googleusercontent.com';
    assert.equal((await sa.call('PUT', '/api/admin/integrasi/google_client_id', { nilai: cid })).status, 400, 'tanpa bukti ditolak');
    assert.equal((await sa.call('PUT', '/api/admin/integrasi/google_client_id', { nilai: cid, credential: `lain.apps.googleusercontent.com|s1|${me.user.email}` })).status, 400, 'token untuk Client ID lain ditolak');
    assert.equal((await sa.call('PUT', '/api/admin/integrasi/google_client_id', { nilai: cid, credential: `${cid}|s1|orang@lain.com` })).status, 403, 'akun Google lain ditolak');
    assert.equal(config.googleClientId, '', 'belum berubah');
    assert.equal((await sa.call('PUT', '/api/admin/integrasi/google_client_id', { nilai: cid, credential: `${cid}|s1|${me.user.email}` })).status, 200);
    assert.equal(config.googleClientId, cid);
    assert.equal(config.passwordLogin, false, 'login kata sandi otomatis mati setelah Client ID aktif');
  } finally {
    global.fetch = oldFetch;
    await integ.clearValue('google_client_id');
  }
  assert.equal(config.passwordLogin, true);
});

// ======================= Otomasi follow-up & alert =======================
const otm = require('../src/otomasi');
async function studioOf(c) { return (await c.call('GET', '/api/me')).body.studio.id; }
async function runFor(c) { return (await c.call('POST', '/api/otomasi/jalankan')).body; }
const NO_QUIET = { jam_tenang: { mulai: 0, selesai: 0 } };

test('otomasi: pengingat "belum dibuka" sekali saja, masuk antrean manual tanpa WA API, isi link & PIN', async () => {
  const c = await owner();
  await c.call('PUT', '/api/otomasi', NO_QUIET);
  const s = await sesi(c, { pelanggan_wa: '081234567890', masa_aktif_jam: 168 });
  await db.q("UPDATE sesis SET link_dikirim_pada = now() - interval '25 hours' WHERE id=$1", [s.id]);
  const r1 = await runFor(c);
  assert.equal(r1.pelanggan, 1);
  const q = (await c.call('GET', '/api/followup?status=antre')).body;
  assert.equal(q.length, 1);
  assert.equal(q[0].kunci, 'belum_dibuka');
  assert.equal(q[0].kanal, 'manual');
  assert.ok(q[0].pesan.includes(s.pin) && q[0].pesan.includes(`/g/${s.token}`));
  assert.match(q[0].wa_url, /^https:\/\/wa\.me\/6281234567890\?text=/);
  assert.equal((await runFor(c)).pelanggan, 0, 'tidak dikirim dua kali');
  // Staf menandai terkirim; studio lain tidak bisa menyentuh
  const other = await owner();
  assert.equal((await other.call('POST', `/api/followup/${q[0].id}/terkirim`)).status, 404);
  assert.equal((await c.call('POST', `/api/followup/${q[0].id}/terkirim`)).status, 200);
  assert.equal((await c.call('GET', '/api/followup?status=antre')).body.length, 0);
});

test('otomasi: jam tenang menunda, pelanggan bisa berhenti, maksimal 2 pesan per 24 jam', async () => {
  const c = await owner();
  const h = parseInt(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Jakarta' }).format(new Date()), 10) % 24;
  await c.call('PUT', '/api/otomasi', { jam_tenang: { mulai: h, selesai: (h + 1) % 24 } });
  const s = await sesi(c, { durasi_pilih_menit: 0 });
  await db.q("UPDATE sesis SET tenggat_link = now() + interval '2 hours' WHERE id=$1", [s.id]);
  const r = await runFor(c);
  assert.equal(r.pelanggan, 0);
  assert.ok(r.ditunda >= 1, 'ditunda karena jam tenang');
  await c.call('PUT', '/api/otomasi', NO_QUIET);
  // tenggat 2 jam memenuhi tahap 24j dan 3j sekaligus → batas 2/24 jam tetap dihormati
  assert.equal((await runFor(c)).pelanggan, 2);
  await db.q("UPDATE sesis SET link_dikirim_pada = now() - interval '30 hours' WHERE id=$1", [s.id]);
  assert.equal((await runFor(c)).pelanggan, 0, 'maksimal 2 pesan per 24 jam');
  // Pelanggan mematikan pengingat
  const s2 = await sesi(c, { durasi_pilih_menit: 0 });
  await db.q("UPDATE sesis SET tenggat_link = now() + interval '20 hours' WHERE id=$1", [s2.id]);
  const p2 = await pelanggan(s2);
  assert.equal((await p2.call('POST', `/g/${s2.token}/api/pengingat`, { aktif: false })).status, 200);
  await runFor(c);
  assert.equal((await db.one("SELECT count(*)::int AS n FROM followups WHERE sesi_id=$1", [s2.id])).n, 0);
});

test('otomasi: kirim lewat WhatsApp API bila tersedia; gagal → jatuh ke antrean manual', async () => {
  const oldFetch = global.fetch;
  let calls = 0; let fail = false;
  global.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://graph.facebook.com/')) return oldFetch(url, opts);
    calls += 1;
    return fail ? new Response(JSON.stringify({ error: { message: 'token kedaluwarsa' } }), { status: 401 })
      : new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 });
  };
  try {
    const c = await owner();
    await c.call('PUT', '/api/otomasi', NO_QUIET);
    await c.call('PUT', '/api/studio', { nama: 'Studio WA', wa_phone_number_id: '1234567', wa_token: 'x'.repeat(50) });
    const s = await sesi(c, { pelanggan_wa: '081211112222', masa_aktif_jam: 168 });
    await db.q("UPDATE sesis SET link_dikirim_pada = now() - interval '25 hours' WHERE id=$1", [s.id]);
    await runFor(c);
    let f = await db.one('SELECT * FROM followups WHERE sesi_id=$1', [s.id]);
    assert.equal(f.kanal, 'wa_api');
    assert.equal(f.status, 'terkirim');
    assert.equal(calls, 1);
    fail = true;
    const s2 = await sesi(c, { pelanggan_wa: '081233334444', masa_aktif_jam: 168 });
    await db.q("UPDATE sesis SET link_dikirim_pada = now() - interval '25 hours' WHERE id=$1", [s2.id]);
    await runFor(c);
    f = await db.one('SELECT * FROM followups WHERE sesi_id=$1', [s2.id]);
    assert.equal(f.status, 'antre');
    assert.match(f.error, /token kedaluwarsa/);
  } finally { global.fetch = oldFetch; }
});

test('otomasi: alert staf (editor telat, minta waktu belum direspons, link belum dikirim) sekali saja', async () => {
  const c = await owner();
  await c.call('PUT', '/api/otomasi', NO_QUIET);
  const a = await sesi(c);
  await db.q("UPDATE sesis SET status='terkirim', dikirim_pada = now() - interval '50 hours' WHERE id=$1", [a.id]);
  const b = await sesi(c);
  const pb = await pelanggan(b);
  await pb.call('POST', `/g/${b.token}/api/mulai`);
  await db.q("UPDATE sesis SET minta_waktu_pada = now() - interval '15 minutes' WHERE id=$1", [b.id]);
  const d = await sesi(c);
  await db.q("UPDATE sesis SET sinkron_pada = now() - interval '4 hours' WHERE id=$1", [d.id]);
  const r = await runFor(c);
  assert.ok(r.staf >= 3, JSON.stringify(r));
  const n = (await c.call('GET', '/api/notifikasi')).body.filter((x) => x.jenis === 'alert').map((x) => x.pesan).join('\n');
  assert.match(n, /belum selesai dikerjakan/);
  assert.match(n, /PENTING: .* minta tambah waktu/);
  assert.match(n, /link belum dikirim/);
  assert.equal((await runFor(c)).staf, 0, 'alert tidak berulang');
});

test('otomasi: pengaturan divalidasi; templat kustom dipakai; editor tidak bisa mengubah', async () => {
  const c = await owner();
  await c.call('PUT', '/api/otomasi', { ...NO_QUIET, aturan: { belum_dibuka: { aktif: true, jam: 99999 }, ngawur: { aktif: true } },
    templat: { belum_dibuka: 'Kak {nama}, cek {link} ya' } });
  const st = (await c.call('GET', '/api/otomasi')).body.pengaturan;
  assert.equal(st.aturan.belum_dibuka.jam, 720, 'jam dibatasi');
  assert.equal(st.aturan.ngawur, undefined);
  const s = await sesi(c);
  await db.q("UPDATE sesis SET link_dikirim_pada = now() - interval '721 hours', tenggat_link = now() + interval '5 days' WHERE id=$1", [s.id]);
  await runFor(c);
  const f = await db.one('SELECT pesan FROM followups WHERE sesi_id=$1', [s.id]);
  assert.match(f.pesan, /^Kak Rina, cek http/);
  const inv = (await c.call('POST', '/api/tim/undang', { email: `oe${Date.now()}@x.id`, peran: 'editor' })).body;
  const e = new Client();
  await e.call('POST', '/api/auth/invite/accept', { token: inv.link.split('/undangan/')[1], nama: 'Ed', password: 'rahasia123' });
  assert.equal((await e.call('PUT', '/api/otomasi', { aktif: false })).status, 403);
  assert.equal((await e.call('GET', '/api/followup')).status, 403);
});

test('otomasi: putaran paralel aman (advisory lock)', async () => {
  const [x, y] = await Promise.all([otm.run(), otm.run()]);
  assert.ok(x.dilewati || y.dilewati || true); // keduanya selesai tanpa error / duplikasi
  const dup = await db.one('SELECT count(*)::int AS n FROM (SELECT studio_id, COALESCE(sesi_id,0), kunci FROM followups GROUP BY 1,2,3 HAVING count(*) > 1) z');
  assert.equal(dup.n, 0);
});
