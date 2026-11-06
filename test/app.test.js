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
