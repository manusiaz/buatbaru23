/* Isi angka paket di halaman jualan dari pengaturan super admin */
(function () {
  'use strict';
  function rp(n) { return 'Rp ' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  fetch('/api/config').then(function (r) { return r.json(); }).then(function (c) {
    var H = c.harga; if (!H) return;
    var v = {
      gratis_hari: H.gratis_hari, kopi_harga: rp(H.kopi_harga), kopi_lama: H.kopi_hari % 30 === 0 ? (H.kopi_hari / 30) + ' bulan' : H.kopi_hari + ' hari',
      gratis_sesi: H.paket.gratis.sesi, gratis_pengguna: H.paket.gratis.pengguna,
      starter_harga: rp(H.paket.starter.harga), starter_sesi: H.paket.starter.sesi, starter_pengguna: H.paket.starter.pengguna,
      pro_harga: rp(H.paket.pro.harga), pro_sesi: H.paket.pro.sesi, pro_pengguna: H.paket.pro.pengguna,
    };
    document.querySelectorAll('[data-h]').forEach(function (el) { var k = el.getAttribute('data-h'); if (v[k] !== undefined && v[k] !== null) el.textContent = v[k]; });
    if (!H.kopi_harga) document.querySelectorAll('[data-h-kopi]').forEach(function (el) { el.remove(); });
  }).catch(function () {});
})();
