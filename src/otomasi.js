'use strict';
// Otomasi follow-up ke pelanggan & alert ke tim studio.
// - Tiap aturan hanya terjadi sekali per sesi/tahap (unique index followups).
// - Pesan ke pelanggan: lewat WhatsApp API bila tersedia, kalau tidak masuk antrean "klik untuk kirim".
// - Jam tenang (default 21–08 waktu studio), maks 2 pesan per pelanggan per 24 jam, pelanggan bisa berhenti.
// - Aman untuk multi-instance: satu putaran dijaga pg_try_advisory_lock.
const config = require('./config');
const db = require('./db');
const plans = require('./plans');
const wa = require('./wa');
const { notify } = require('./notify');
const { decrypt } = require('./security');
const F = require('../public/shared/format');

const DEFAULT = {
  aktif: true,
  jam_tenang: { mulai: 21, selesai: 8 },
  staf_wa: false, // alert staf juga ke WhatsApp studio (butuh WA API)
  aturan: {
    belum_dibuka: { aktif: true, jam: 24 },
    tenggat_dekat: { aktif: true, jam: [24, 3] },
    kedaluwarsa: { aktif: true },
    belum_bayar: { aktif: true, jam: 24 },
    hasil_otomatis: { aktif: false },
    editor_telat: { aktif: true, jam: 48 },
    minta_waktu: { aktif: true, menit: 10 },
    link_belum_dikirim: { aktif: true, jam: 3 },
    sinkron_gagal: { aktif: true },
    kuota_hampir_habis: { aktif: true, persen: 80 },
    digest_mingguan: { aktif: true },
  },
  templat: {
    belum_dibuka: 'Halo Kak {nama}, foto {judul} dari {studio} sudah siap dipilih tapi galerinya belum dibuka. Link: {link} · PIN: {pin} · Batas: {tenggat}.',
    tenggat_dekat: 'Halo Kak {nama}, waktu memilih foto {judul} tinggal {sisa}. Yuk pilih sebelum {tenggat}: {link} (PIN {pin}).',
    kedaluwarsa: 'Halo Kak {nama}, galeri {judul} sudah berakhir dan belum ada pilihan masuk. Balas pesan ini kalau masih ingin memilih, nanti {studio} bukakan lagi.',
    belum_bayar: 'Halo Kak {nama}, ada {jumlah} foto tambahan {judul} senilai {total} yang belum dibayar. {bayar}',
  },
};
const ATURAN_NAMA = {
  belum_dibuka: 'Pelanggan belum membuka link', tenggat_dekat: 'Tenggat memilih sudah dekat', kedaluwarsa: 'Galeri kedaluwarsa tanpa pilihan',
  belum_bayar: 'Foto tambahan belum dibayar', hasil_otomatis: 'Kirim hasil otomatis saat link hasil disimpan', editor_telat: 'Pilihan belum dikerjakan editor',
  minta_waktu: 'Permintaan tambah waktu belum direspons', link_belum_dikirim: 'Link galeri belum dikirim ke pelanggan', sinkron_gagal: 'Sinkron Drive gagal',
  kuota_hampir_habis: 'Kuota sesi bulanan hampir habis', digest_mingguan: 'Ringkasan mingguan (Senin pagi)',
};

function merge(a, b) {
  const out = Array.isArray(a) ? a.slice() : { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a && typeof a[k] === 'object' && !Array.isArray(a[k]) ? merge(a[k], v) : v;
  }
  return out;
}
function settings(studio) { return merge(DEFAULT, studio.otomasi || {}); }

// Validasi & simpan pengaturan studio (hanya kunci yang dikenal, angka dibatasi)
function sanitize(input) {
  const out = { aturan: {}, templat: {} };
  const b = input || {};
  if (b.aktif !== undefined) out.aktif = !!b.aktif;
  if (b.staf_wa !== undefined) out.staf_wa = !!b.staf_wa;
  if (b.jam_tenang) {
    const m = Math.min(23, Math.max(0, parseInt(b.jam_tenang.mulai, 10) || 0));
    const s = Math.min(23, Math.max(0, parseInt(b.jam_tenang.selesai, 10) || 0));
    out.jam_tenang = { mulai: m, selesai: s };
  }
  for (const [k, def] of Object.entries(DEFAULT.aturan)) {
    const v = (b.aturan || {})[k];
    if (!v) continue;
    const r = { aktif: !!v.aktif };
    if ('jam' in def) {
      r.jam = Array.isArray(def.jam)
        ? (Array.isArray(v.jam) ? v.jam : String(v.jam || '').split(',')).map((x) => parseInt(x, 10)).filter((x) => x >= 1 && x <= 720).slice(0, 3).sort((x, y) => y - x)
        : Math.min(720, Math.max(1, parseInt(v.jam, 10) || def.jam));
      if (Array.isArray(def.jam) && !r.jam.length) r.jam = def.jam;
    }
    if ('menit' in def) r.menit = Math.min(1440, Math.max(1, parseInt(v.menit, 10) || def.menit));
    if ('persen' in def) r.persen = Math.min(100, Math.max(10, parseInt(v.persen, 10) || def.persen));
    out.aturan[k] = r;
  }
  for (const k of Object.keys(DEFAULT.templat)) {
    const t = (b.templat || {})[k];
    if (t !== undefined) {
      const s = String(t).slice(0, 700).trim();
      if (s) out.templat[k] = s;
    }
  }
  return out;
}

function localHour(tz) {
  return parseInt(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: tz || 'Asia/Jakarta' }).format(new Date()), 10) % 24;
}
function localWeekKey(tz) {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: tz || 'Asia/Jakarta' }));
  const day = d.getDay(); // 0 Minggu
  const monday = new Date(d); monday.setDate(d.getDate() - ((day + 6) % 7));
  return { key: monday.toISOString().slice(0, 10), isMonday: day === 1, hour: d.getHours() };
}
function quiet(st, cfg) {
  const h = localHour(st.zona_waktu);
  const { mulai, selesai } = cfg.jam_tenang;
  if (mulai === selesai) return false;
  return mulai > selesai ? (h >= mulai || h < selesai) : (h >= mulai && h < selesai);
}
function fill(tpl, vars) { return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m)); }
function fmtWaktu(d, tz) {
  return d ? new Intl.DateTimeFormat('id-ID', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz || 'Asia/Jakarta' }).format(new Date(d)) : '-';
}
function sisa(d) {
  const ms = new Date(d) - Date.now();
  if (ms <= 0) return 'sebentar lagi';
  const j = Math.round(ms / 3600000);
  return j >= 1 ? `${j} jam` : `${Math.max(1, Math.round(ms / 60000))} menit`;
}

// Klaim slot dedup; null bila aturan ini sudah pernah diproses
async function claim(studioId, sesiId, kunci, target, kanal, status, tujuan, pesan) {
  const r = await db.q(`INSERT INTO followups(studio_id, sesi_id, kunci, target, kanal, status, tujuan, pesan) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (studio_id, COALESCE(sesi_id, 0), kunci) DO NOTHING RETURNING id`, [studioId, sesiId, kunci, target, kanal, status, tujuan, pesan]);
  return r.rows[0] ? r.rows[0].id : null;
}

async function toCustomer(st, cfg, s, kunci, pesan, stats) {
  if (s.pengingat_mati) return;
  if (quiet(st, cfg)) { stats.ditunda += 1; return; } // dicoba lagi di putaran berikut
  const recent = await db.one(`SELECT count(*)::int AS n FROM followups WHERE sesi_id=$1 AND target='pelanggan' AND status IN ('terkirim','antre')
    AND dibuat_pada > now() - interval '24 hours'`, [s.id]);
  if (recent.n >= 2) { stats.ditunda += 1; return; }
  const viaApi = s.pelanggan_wa && plans.has(st, 'wa_api') && wa.configured(st);
  const id = await claim(st.id, s.id, kunci, 'pelanggan', viaApi ? 'wa_api' : 'manual', viaApi ? 'terkirim' : 'antre', s.pelanggan_wa, pesan);
  if (!id) return;
  stats.pelanggan += 1;
  if (!viaApi) return; // antrean manual: staf menekan "Kirim via WhatsApp" di halaman Follow-up
  try {
    await wa.send(st, { sesiId: s.id, to: s.pelanggan_wa, jenis: 'pengingat:' + kunci,
      template: config.waTemplatePengingat ? { name: config.waTemplatePengingat, params: [s.pelanggan_nama, pesan.replace(/\s*\n\s*/g, ' ')] } : null, text: pesan });
    await db.q('UPDATE followups SET dikirim_pada=now() WHERE id=$1', [id]);
  } catch (e) {
    // Gagal via API → jatuh ke antrean manual agar tetap bisa dikirim staf
    await db.q("UPDATE followups SET status='antre', kanal='manual', error=$2 WHERE id=$1", [id, String(e.message).slice(0, 300)]);
  }
}

async function toStaff(st, cfg, sesiId, kunci, pesan, stats, userIds) {
  const id = await claim(st.id, sesiId, kunci, 'staf', 'inapp', 'terkirim', null, pesan);
  if (!id) return;
  stats.staf += 1;
  await db.q('UPDATE followups SET dikirim_pada=now() WHERE id=$1', [id]);
  await notify(st.id, sesiId, 'alert', pesan, { userIds });
  if (cfg.staf_wa && st.no_wa && plans.has(st, 'wa_api') && wa.configured(st)) {
    await wa.send(st, { sesiId, to: st.no_wa, jenis: 'alert:' + kunci,
      template: config.waTemplatePengingat ? { name: config.waTemplatePengingat, params: ['Tim ' + st.nama, pesan] } : null, text: `[${config.appName}] ${pesan}` }).catch(() => {});
  }
}

function vars(st, s) {
  let link = ''; let pin = '';
  try { link = `${config.baseUrl}/g/${decrypt(s.token_enc)}`; pin = decrypt(s.pin_enc); } catch { /* abaikan */ }
  return { nama: s.pelanggan_nama, judul: s.judul, studio: st.nama, link, pin, tenggat: fmtWaktu(s.tenggat_link, st.zona_waktu) };
}

const SESI_SQL = `SELECT s.*, p.nama AS pelanggan_nama, p.no_wa AS pelanggan_wa FROM sesis s JOIN pelanggans p ON p.id=s.pelanggan_id WHERE s.studio_id=$1
  AND s.ditangguhkan_pada IS NULL AND p.ditangguhkan_pada IS NULL`;

async function runStudio(st, stats) {
  const cfg = settings(st);
  if (!cfg.aktif) return;
  const A = cfg.aturan; const T = cfg.templat;

  // ---- Ke pelanggan ----
  if (A.belum_dibuka.aktif) {
    const rows = await db.many(`${SESI_SQL} AND s.status='siap' AND s.link_dikirim_pada IS NOT NULL
      AND s.link_dikirim_pada < now() - ($2 || ' hours')::interval AND s.tenggat_link > now() + interval '1 hour' AND NOT s.pengingat_mati`, [st.id, String(A.belum_dibuka.jam)]);
    for (const s of rows) await toCustomer(st, cfg, s, 'belum_dibuka', fill(T.belum_dibuka, vars(st, s)), stats);
  }
  if (A.tenggat_dekat.aktif) {
    for (const jam of A.tenggat_dekat.jam) {
      // Lewati sesi yang sedang menjalankan hitung mundur (pelanggan sedang aktif memilih)
      const rows = await db.many(`${SESI_SQL} AND s.tenggat_link > now() AND s.tenggat_link <= now() + ($2 || ' hours')::interval
        AND (s.status IN ('siap','dibuka') OR (s.status='memilih' AND s.durasi_pilih_menit = 0)) AND NOT s.pengingat_mati`, [st.id, String(jam)]);
      for (const s of rows) await toCustomer(st, cfg, s, `tenggat_dekat:${jam}j`, fill(T.tenggat_dekat, { ...vars(st, s), sisa: sisa(s.tenggat_link) }), stats);
    }
  }
  if (A.kedaluwarsa.aktif) {
    const rows = await db.many(`${SESI_SQL} AND s.status='kedaluwarsa' AND s.tenggat_link > now() - interval '3 days'
      AND NOT EXISTS (SELECT 1 FROM pilihans x WHERE x.sesi_id=s.id)`, [st.id]);
    for (const s of rows) {
      await toCustomer(st, cfg, s, 'kedaluwarsa', fill(T.kedaluwarsa, vars(st, s)), stats);
      await toStaff(st, cfg, s.id, 'kedaluwarsa_staf', `${s.judul} kedaluwarsa tanpa pilihan. Perpanjang link bila pelanggan masih ingin memilih.`, stats);
    }
  }
  if (A.belum_bayar.aktif) {
    const rows = await db.many(`${SESI_SQL.replace('FROM sesis s', 'FROM sesis s JOIN tagihans t ON t.sesi_id=s.id').replace('SELECT s.*', 'SELECT s.*, t.jumlah_foto AS t_jumlah, t.total_rupiah AS t_total')}
      AND t.total_rupiah > 0 AND t.status_bayar='belum_bayar' AND s.status IN ('terkirim','selesai')
      AND s.dikirim_pada < now() - ($2 || ' hours')::interval AND s.dikirim_pada > now() - interval '14 days'`, [st.id, String(A.belum_bayar.jam)]);
    for (const s of rows) {
      const v = vars(st, s);
      const online = require('./payment').enabled() && plans.has(st, 'bayar_online');
      const bayar = online ? `Bayar online (QRIS/VA) lewat galerimu: ${v.link}` : 'Bisa dibayar di kasir atau transfer sesuai arahan studio.';
      await toCustomer(st, cfg, s, 'belum_bayar', fill(T.belum_bayar, { ...v, jumlah: s.t_jumlah, total: F.rupiah(s.t_total), bayar }), stats);
    }
  }
  if (A.hasil_otomatis.aktif) {
    const rows = await db.many(`${SESI_SQL} AND s.hasil_link IS NOT NULL AND s.hasil_dikirim_pada IS NULL`, [st.id]);
    for (const s of rows) {
      const tpl = st.template_hasil || 'Halo Kak {nama}, hasil edit foto {judul} dari {studio} sudah siap 🎉\n\n{link}\n\nTerima kasih sudah memotret bersama kami!';
      const before = stats.pelanggan;
      await toCustomer(st, cfg, { ...s, pengingat_mati: false }, 'hasil', fill(tpl, { ...vars(st, s), link: s.hasil_link }), stats);
      if (stats.pelanggan > before) await db.q('UPDATE sesis SET hasil_dikirim_pada=now() WHERE id=$1 AND hasil_dikirim_pada IS NULL', [s.id]);
    }
  }

  // ---- Ke tim studio ----
  if (A.editor_telat.aktif) {
    const rows = await db.many(`SELECT id, judul, editor_id, dikirim_pada FROM sesis WHERE studio_id=$1 AND status='terkirim' AND editor_status<>'selesai'
      AND dikirim_pada < now() - ($2 || ' hours')::interval`, [st.id, String(A.editor_telat.jam)]);
    for (const s of rows) {
      await toStaff(st, cfg, s.id, 'editor_telat', `Pilihan ${s.judul} sudah masuk ${Math.round((Date.now() - new Date(s.dikirim_pada)) / 3600000)} jam tapi belum selesai dikerjakan.`, stats, s.editor_id ? [s.editor_id] : null);
    }
  }
  if (A.minta_waktu.aktif) {
    const rows = await db.many(`SELECT id, judul, minta_waktu_pada FROM sesis WHERE studio_id=$1 AND status='memilih' AND minta_waktu_pada IS NOT NULL
      AND minta_waktu_pada < now() - ($2 || ' minutes')::interval`, [st.id, String(A.minta_waktu.menit)]);
    for (const s of rows) {
      await toStaff(st, cfg, s.id, `minta_waktu:${new Date(s.minta_waktu_pada).getTime()}`, `PENTING: ${s.judul} minta tambah waktu sejak ${Math.round((Date.now() - new Date(s.minta_waktu_pada)) / 60000)} menit lalu dan belum direspons.`, stats);
    }
  }
  if (A.link_belum_dikirim.aktif) {
    const rows = await db.many(`SELECT id, judul FROM sesis WHERE studio_id=$1 AND status='siap' AND link_dikirim_pada IS NULL AND NOT kiosk
      AND sinkron_status='selesai' AND COALESCE(sinkron_pada, dibuat_pada) < now() - ($2 || ' hours')::interval AND tenggat_link > now()`, [st.id, String(A.link_belum_dikirim.jam)]);
    for (const s of rows) await toStaff(st, cfg, s.id, 'link_belum_dikirim', `Galeri ${s.judul} sudah siap tapi link belum dikirim ke pelanggan.`, stats);
  }
  if (A.sinkron_gagal.aktif) {
    const rows = await db.many("SELECT id, judul, sinkron_error FROM sesis WHERE studio_id=$1 AND sinkron_status='gagal'", [st.id]);
    for (const s of rows) await toStaff(st, cfg, s.id, `sinkron_gagal:${String(s.sinkron_error || '').slice(0, 40)}`, `Sinkron Drive ${s.judul} gagal: ${s.sinkron_error || 'tidak diketahui'}`, stats);
  }
  if (A.kuota_hampir_habis.aktif && config.billingEnabled) {
    const p = plans.PLANS[plans.effectivePlan(st)];
    if (p.sesi !== Infinity) {
      const u = await plans.usage(st.id);
      if (u.sesi_bulan_ini >= Math.ceil(p.sesi * A.kuota_hampir_habis.persen / 100)) {
        const bulan = new Date().toISOString().slice(0, 7);
        await toStaff(st, cfg, null, `kuota:${bulan}`, `Kuota sesi bulan ini sudah terpakai ${u.sesi_bulan_ini} dari ${p.sesi}. Upgrade paket agar tidak terhenti.`, stats);
      }
    }
  }
  if (A.digest_mingguan.aktif) {
    const w = localWeekKey(st.zona_waktu);
    if (w.isMonday && w.hour >= 8) {
      const d = await db.one(`SELECT count(*) FILTER (WHERE status IN ('siap','dibuka','memilih'))::int AS aktif,
          count(*) FILTER (WHERE status='terkirim')::int AS belum_selesai,
          count(*) FILTER (WHERE dibuat_pada > now() - interval '7 days')::int AS baru,
          count(*) FILTER (WHERE dikirim_pada > now() - interval '7 days')::int AS masuk
        FROM sesis WHERE studio_id=$1`, [st.id]);
      const t = await db.one(`SELECT COALESCE(sum(t.total_rupiah),0)::bigint AS belum FROM tagihans t JOIN sesis s ON s.id=t.sesi_id
        WHERE s.studio_id=$1 AND t.status_bayar='belum_bayar' AND t.total_rupiah>0`, [st.id]);
      await toStaff(st, cfg, null, `digest:${w.key}`, `Ringkasan minggu ini: ${d.baru} galeri baru, ${d.masuk} pilihan masuk, ${d.aktif} galeri aktif, ${d.belum_selesai} belum selesai diedit, foto tambahan belum dibayar ${F.rupiah(t.belum)}.`, stats);
    }
  }
}

async function run() {
  const stats = { pelanggan: 0, staf: 0, ditunda: 0 };
  const c = await db.pool.connect();
  try {
    const lock = await c.query('SELECT pg_try_advisory_lock(724520) AS ok');
    if (!lock.rows[0].ok) return { ...stats, dilewati: 'instance lain sedang berjalan' };
    try {
      const studios = await db.many('SELECT * FROM studios WHERE aktif');
      for (const st of studios) {
        try { await runStudio(st, stats); } catch (e) { console.error('[otomasi]', st.id, e.message); }
      }
    } finally {
      await c.query('SELECT pg_advisory_unlock(724520)');
    }
  } finally { c.release(); }
  return stats;
}

let timer = null;
function start() {
  timer = setInterval(() => run().catch((e) => console.error('[otomasi]', e.message)), 5 * 60 * 1000);
  timer.unref();
  setTimeout(() => run().catch(() => {}), 45000).unref();
}

module.exports = { DEFAULT, ATURAN_NAMA, settings, sanitize, run, runStudio, start, quiet };
