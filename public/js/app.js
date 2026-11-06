/* Dasbor studio (S2–S8) */
(function () {
  'use strict';
  var h = UI.h, ic = UI.ic, api = UI.api, F = window.GSFormat;
  var ME = null, CFG = null, main, side, pollT = null;
  var TONE = ['#94D2BD', '#E9D8A6', '#D3E2E5', '#EE9B00', '#0A9396', '#CA6702'];

  function tz() { return (ME && ME.studio.zona_waktu) || 'Asia/Jakarta'; }
  function can(p) { return ME && ME.izin[p]; }
  function go(hash) { location.hash = hash; }
  function qs() { var q = location.hash.split('?')[1] || ''; var o = {}; q.split('&').forEach(function (kv) { if (!kv) return; var p = kv.split('='); o[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || ''); }); return o; }
  function err(e) {
    if (e && e.status === 402 && ME && ME.langganan.billing) {
      UI.modal({ title: 'Butuh paket lebih tinggi', body: e.message, actions: [{ label: 'Nanti' }, { label: 'Lihat paket', cls: 'btn-primary', onClick: function (c) { c(); go('#/langganan'); } }] });
      return;
    }
    UI.toast(e.message || String(e), true);
  }
  function fitur(f) { return !ME.langganan.billing || ME.langganan.fitur[f]; }
  function cabangSelect(val, allLabel, attrs) {
    if (!ME.cabangs.length) return null;
    return h('select.select', Object.assign({ 'aria-label': 'Cabang' }, attrs || {}), allLabel ? h('option', { value: '' }, allLabel) : null,
      ME.cabangs.map(function (c) { return h('option', { value: c.id, selected: String(val) === String(c.id) }, c.nama); }));
  }
  function fmtBytes(b) { if (!b) return '–'; var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } return b.toFixed(i > 1 ? 1 : 0).replace('.', ',') + ' ' + u[i]; }
  function waLink(no, text) { return 'https://wa.me/' + (no || '') + '?text=' + encodeURIComponent(text || ''); }

  function boot() {
    Promise.all([api('GET', '/api/me'), api('GET', '/api/config')]).then(function (r) {
      ME = r[0]; CFG = r[1];
      document.documentElement.style.setProperty('--brand', ME.studio.warna);
      layout();
      window.addEventListener('hashchange', route);
      route();
      setInterval(refreshMe, 30000);
    }).catch(function (e) {
      if (e.status === 401) location.href = '/masuk?next=' + encodeURIComponent('/app' + location.hash);
      else document.body.textContent = e.message;
    });
  }
  function refreshMe() {
    return api('GET', '/api/me').then(function (m) { ME = m; drawSide(); }).catch(function () {});
  }

  // ---------- Kerangka ----------
  function layout() {
    var body = document.getElementById('root');
    body.innerHTML = '';
    side = h('aside.side', { 'aria-label': 'Navigasi' });
    main = h('main.mainc', { id: 'main', tabindex: '-1' });
    var top = h('div.topbar', h('button.icon-btn', { type: 'button', 'aria-label': 'Buka menu', onclick: openSide }, ic('menu')), h('b', CFG.appName), h('a.icon-btn', { href: '#/notifikasi', 'aria-label': 'Notifikasi' }, ic('lonceng')));
    body.appendChild(top);
    body.appendChild(h('div.shell', side, main));
    drawSide();
  }
  function openSide() {
    side.classList.add('open');
    var scrim = h('div.scrim', { onclick: closeSide });
    document.body.appendChild(scrim);
  }
  function closeSide() { side.classList.remove('open'); var s = document.querySelector('.scrim'); if (s) s.remove(); }
  function drawSide() {
    var cur = (location.hash.split('?')[0].split('/')[1]) || 'dasbor';
    var items = [['dasbor', 'Dasbor', 'dasbor'], ['galeri', 'Galeri', 'galeri'], ['pilihan', 'Pilihan masuk', 'pilih', ME.pilihan_baru],
      ['notifikasi', 'Notifikasi', 'lonceng', ME.notif_belum_dibaca]];
    if (can('sesi.kelola')) items.push(['kiosk', 'Mode kiosk', 'kiosk'], ['laporan', 'Laporan', 'laporan']);
    items.push(['paket', 'Paket & harga', 'paket'], ['tim', 'Tim & peran', 'tim']);
    if (can('studio.edit')) items.push(['pengaturan', 'Pengaturan', 'pengaturan']);
    if (ME.langganan.billing) items.push(['langganan', 'Langganan', 'kartu']);
    if (ME.superadmin) items.push(['admin', 'Super admin', 'kunci']);
    side.innerHTML = '';
    side.appendChild(h('div.brand', h('div.logo-mark', ME.studio.logo_url ? h('img', { src: ME.studio.logo_url, alt: '' }) : '001'),
      h('div', h('b', CFG.appName), h('small', ME.studio.nama))));
    side.appendChild(h('nav.nav', items.map(function (it) {
      return h('a', { href: '#/' + it[0], class: cur === it[0] ? 'on' : '', 'aria-current': cur === it[0] ? 'page' : null, onclick: closeSide }, ic(it[2]), it[1], it[3] ? h('span.cnt', String(it[3])) : null);
    })));
    side.appendChild(h('div.grow'));
    side.appendChild(h('div.sa-box', h('b', 'Google Drive'), CFG.serviceAccountEmail
      ? ['Email layanan: ', h('span.mono', { style: { color: '#E9D8A6', wordBreak: 'break-all' } }, CFG.serviceAccountEmail)]
      : 'Service account belum dikonfigurasi. Folder publik / contoh tetap bisa dipakai.'));
    side.appendChild(h('div.me', h('div.avatar', UI.initials(ME.user.nama)), h('div', { style: { minWidth: 0 } }, h('b', ME.user.nama), h('a', { href: '#/profil', onclick: closeSide }, 'Lihat profil · ' + ME.user.peran)),
      h('button', { type: 'button', 'aria-label': 'Keluar', title: 'Keluar', onclick: function () { api('POST', '/api/auth/logout', {}).then(function () { location.href = '/masuk'; }); } }, ic('keluar'))));
  }

  function route() {
    clearInterval(pollT); pollT = null;
    var path = location.hash.replace(/^#/, '').split('?')[0] || '/dasbor';
    var parts = path.split('/').filter(Boolean);
    drawSide();
    main.innerHTML = '';
    window.scrollTo(0, 0);
    var r = parts[0];
    try {
      if (r === 'dasbor' || !r) return pageDasbor();
      if (r === 'galeri' && parts[1] === 'baru') return pageBuat();
      if (r === 'galeri' && parts[1]) return pageDetail(parseInt(parts[1], 10));
      if (r === 'galeri') return pageGaleri();
      if (r === 'pilihan') return pagePilihan(parts[1] ? parseInt(parts[1], 10) : null);
      if (r === 'notifikasi') return pageNotif();
      if (r === 'paket') return pagePaket();
      if (r === 'tim') return pageTim();
      if (r === 'pengaturan') return pagePengaturan();
      if (r === 'profil') return pageProfil();
      if (r === 'kiosk') return pageKiosk();
      if (r === 'laporan') return pageLaporan();
      if (r === 'massal') return pageMassal();
      if (r === 'langganan') return pageLangganan();
      if (r === 'admin') return pageAdmin();
      main.appendChild(h('div.empty', h('p.title', 'Halaman tidak ditemukan'), h('a', { href: '#/dasbor' }, 'Kembali ke dasbor')));
    } catch (e) { err(e); }
  }
  function head(title, sub, right, crumb) {
    return h('div.page-head', h('div', crumb || null, sub ? h('div.label', sub) : null, h('h1.display-lg', title)), right ? h('div.row', right) : null);
  }
  function loading() { main.appendChild(h('div.card.skeleton', { style: { height: '160px' } })); }
  function cover(s, i) {
    return h('div.cover', { style: { background: s.cover ? null : 'linear-gradient(' + TONE[(s.id || i || 0) % TONE.length] + ' 55%, var(--deep-teal) 55%)' } }, s.cover ? h('img', { src: s.cover, alt: '', loading: 'lazy' }) : null);
  }
  function deadlineText(s) {
    if (s.status === 'memilih' && s.berakhir_pada) return 'Timer habis ' + UI.rel(s.berakhir_pada);
    if (s.status === 'terkirim' || s.status === 'waktu_habis' || s.status === 'selesai') return 'Dikirim ' + UI.rel(s.dikirim_pada);
    if (s.status === 'kedaluwarsa') return 'Lewat ' + UI.fmtDate(s.tenggat_link, tz());
    return s.tenggat_link ? 'Berakhir ' + UI.rel(s.tenggat_link) : '';
  }

  // ---------- S2: Dasbor ----------
  function pageDasbor() {
    var today = UI.fmtDate(new Date(), tz(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    main.appendChild(head('Halo, ' + ME.user.nama.split(' ')[0], today, [
      h('input.input.search', { type: 'search', placeholder: 'Cari pelanggan atau sesi', 'aria-label': 'Cari', style: { width: '260px' }, onkeydown: function (e) { if (e.key === 'Enter') go('#/galeri?q=' + encodeURIComponent(e.target.value)); } }),
    ]));
    var box = h('div.stack'); main.appendChild(box); box.appendChild(h('div.card.skeleton', { style: { height: '120px' } }));
    Promise.all([api('GET', '/api/dasbor'), api('GET', '/api/sesis?limit=6')]).then(function (r) {
      var d = r[0], list = r[1];
      box.innerHTML = '';
      var tile = function (dot, label, v, sub, link) { return h('a.stat', { href: link }, h('span.label', h('i.dot', { style: { background: dot } }), label), h('div.v', String(v)), h('div.small.muted', sub)); };
      box.appendChild(h('div.stats',
        tile('var(--abyss)', 'Total galeri', d.total, 'Semua sesi foto', '#/galeri'),
        tile('var(--deep-teal)', 'Aktif', d.aktif, 'Bisa diakses pelanggan', '#/galeri?status=aktif'),
        tile('var(--amber)', 'Segera berakhir', d.segera, 'Dalam 48 jam', '#/galeri?status=segera'),
        tile('var(--oxblood)', 'Kedaluwarsa', d.kedaluwarsa, 'Bisa diperpanjang', '#/galeri?status=kedaluwarsa'),
        tile('var(--mint)', 'Pilihan masuk', d.masuk, d.masuk_baru + ' belum dikerjakan', '#/pilihan')));
      if (d.minta_waktu) box.appendChild(h('a.alert', { href: '#/galeri?status=memilih', style: { textDecoration: 'none', display: 'block' } }, h('b', d.minta_waktu + ' pelanggan minta tambah waktu. '), 'Buka sesinya untuk menambah 5, 10, atau 15 menit.'));
      if (can('sesi.kelola')) {
        box.appendChild(h('section.panel-teal.hero',
          h('div', h('h2', 'Galeri baru dari folder Drive'), h('p', 'Tempel link atau pilih folder Google Drive. Foto otomatis dinomori 001, 002, 003 dan link galeri ber-PIN siap dikirim lewat WhatsApp.'),
            h('a.btn.btn-amber', { href: '#/galeri/baru' }, ic('tambah'), 'Buat galeri baru')),
          h('div.hero-tiles', ['001', '002', '003', '004', '005'].map(function (n, i) { return h('i', { 'data-n': n, style: { background: TONE[i] } }); }))));
      }
      var m = d.metrik;
      var pct = function (a, b) { return b ? Math.round((a / b) * 100) + '%' : '–'; };
      var med = m.median_detik != null ? (m.median_detik < 60 ? '< 1 mnt' : m.median_detik < 3600 ? Math.round(m.median_detik / 60) + ' mnt' : (m.median_detik / 3600).toFixed(1).replace('.', ',') + ' jam') : '–';
      box.appendChild(h('div.stats',
        h('div.stat', h('span.label', 'Waktu sampai pilihan masuk'), h('div.v', med), h('div.small.muted', 'Median 30 hari · target ≤ 24 jam')),
        h('div.stat', h('span.label', 'Selesai tepat waktu'), h('div.v', pct(m.tepat_waktu, m.terkirim)), h('div.small.muted', 'Target ≥ 80%')),
        h('div.stat', h('span.label', 'Minta perpanjangan'), h('div.v', pct(m.minta_waktu, m.semua)), h('div.small.muted', 'Target ≤ 15%')),
        h('div.stat', h('span.label', 'Attach rate tambahan'), h('div.v', pct(m.dengan_tambahan, m.terkirim)), h('div.small.muted', F.rupiah(m.lunas) + ' lunas · ' + F.rupiah(m.belum) + ' belum'))));
      var tbl = h('table.tbl', h('thead', h('tr', h('th', 'Galeri'), h('th', 'Foto'), h('th', 'Dipilih'), h('th', 'Status'), h('th', 'Tenggat'))),
        h('tbody', list.length ? list.map(sesiRow) : h('tr', h('td', { colspan: 5 }, h('div.empty', h('p.title', 'Belum ada galeri'), h('p', 'Tempel link folder Drive untuk membuat galeri pertama.'))))));
      box.appendChild(h('div.two-col',
        h('section.card', h('div.row', { style: { justifyContent: 'space-between', marginBottom: '8px' } }, h('h2.title', 'Galeri terbaru'), h('a', { href: '#/galeri' }, 'Lihat semua')), h('div.table-wrap', tbl)),
        h('section.card', h('h2.title', { style: { marginBottom: '16px' } }, 'Aktivitas'), feed(d.aktivitas))));
    }).catch(err);
  }
  function feed(rows) {
    if (!rows.length) return h('p.muted', 'Belum ada aktivitas.');
    var col = { pilihan_masuk: 'var(--amber)', dibuka: 'var(--mint)', minta_waktu: 'var(--scarlet)' };
    return h('ul.feed', rows.map(function (a) {
      return h('li', h('i.dot', { style: { background: col[a.jenis] || 'var(--deep-teal)' } }),
        h('div', a.sesi_id ? h('a', { href: '#/galeri/' + a.sesi_id }, a.pesan) : a.pesan, h('div.small.muted', UI.rel(a.dibuat_pada))));
    }));
  }
  function sesiRow(s, i) {
    var pct = s.kuota ? Math.min(100, (s.jumlah_pilihan / s.kuota) * 100) : 0;
    return h('tr.row-link', { tabindex: '0', onclick: function () { go('#/galeri/' + s.id); }, onkeydown: function (e) { if (e.key === 'Enter') go('#/galeri/' + s.id); } },
      h('td', h('div.sesi-cell', cover(s, i), h('div', h('b', s.judul), h('span.small.muted', [s.jenis, s.pelanggan_nama !== s.judul ? s.pelanggan_nama : null].filter(Boolean).join(' · '))))),
      h('td.mono', String(s.jumlah_foto)),
      h('td', h('div.mono.small', s.jumlah_pilihan + ' / ' + s.kuota), h('div.progress', h('i', { style: { width: pct + '%' } }))),
      h('td', UI.statusBadge(s.status), s.minta_waktu_pada && s.status === 'memilih' ? h('div.small', { style: { color: 'var(--scarlet)', fontWeight: 700 } }, 'Minta waktu') : null),
      h('td.small.muted', deadlineText(s)));
  }

  // ---------- Galeri (daftar sesi) ----------
  function pageGaleri() {
    var q = qs();
    var st = q.status || '';
    main.appendChild(head('Galeri', 'Semua sesi foto', can('sesi.kelola') ? [h('a.btn.btn-secondary', { href: '#/massal' }, ic('unduh'), 'Buat massal (CSV)'), h('a.btn.btn-primary', { href: '#/galeri/baru' }, ic('tambah'), 'Buat galeri')] : null));
    var tabs = [['', 'Semua'], ['aktif', 'Aktif'], ['memilih', 'Sedang memilih'], ['segera', 'Segera berakhir'], ['masuk', 'Pilihan masuk'], ['waktu_habis', 'Waktu habis'], ['selesai', 'Selesai'], ['kedaluwarsa', 'Kedaluwarsa'], ['menyinkron', 'Menyinkron']];
    var seg = h('div.seg', tabs.map(function (t) { return h('a', { href: '#/galeri' + (t[0] ? '?status=' + t[0] : ''), class: st === t[0] ? 'on' : '' }, t[1]); }));
    var search = h('input.input.search', { type: 'search', placeholder: 'Cari galeri / pelanggan / no. WA', value: q.q || '', style: { width: '260px' }, 'aria-label': 'Cari galeri' });
    var urut = h('select.select', { style: { width: 'auto', borderRadius: '99px' }, 'aria-label': 'Urutkan' }, h('option', { value: '' }, 'Terbaru'), h('option', { value: 'tenggat', selected: q.urut === 'tenggat' }, 'Segera berakhir'), h('option', { value: 'nama', selected: q.urut === 'nama' }, 'Nama A–Z'));
    var listBox = h('div');
    var cabF = ME.cabang_id ? null : cabangSelect(q.cabang, 'Semua cabang', { style: { width: 'auto', borderRadius: '99px' } });
    if (cabF) cabF.addEventListener('change', load);
    main.appendChild(h('div.filters', seg, h('div.row', cabF, search, urut)));
    main.appendChild(listBox);
    function load() {
      listBox.innerHTML = ''; listBox.appendChild(h('div.card.skeleton', { style: { height: '200px' } }));
      var p = []; if (st) p.push('status=' + st); if (search.value) p.push('q=' + encodeURIComponent(search.value)); if (urut.value) p.push('urut=' + urut.value);
      if (cabF && cabF.value) p.push('cabang=' + cabF.value);
      api('GET', '/api/sesis?' + p.join('&')).then(function (rows) {
        listBox.innerHTML = '';
        if (!rows.length) { listBox.appendChild(h('div.card.empty', h('p.title', 'Belum ada galeri di sini'), can('sesi.kelola') ? h('a.btn.btn-primary', { href: '#/galeri/baru' }, 'Buat galeri') : null)); return; }
        listBox.appendChild(h('div.cards', rows.map(function (s, i) {
          return h('a.g-card', { href: '#/galeri/' + s.id },
            h('div.img', { style: { background: s.cover ? null : 'linear-gradient(' + TONE[s.id % TONE.length] + ' 55%, var(--deep-teal) 55%)' } }, s.cover ? h('img', { src: s.cover, alt: '', loading: 'lazy' }) : null, UI.statusBadge(s.status)),
            h('div.body', h('b', s.judul), h('span.small.muted', [s.cabang_nama, s.jenis, s.jumlah_foto + ' foto', s.pelanggan_wa ? '+' + s.pelanggan_wa : null].filter(Boolean).join(' · ')),
              h('div.row', { style: { justifyContent: 'space-between' } }, h('span.mono.small', s.jumlah_pilihan + '/' + s.kuota + ' dipilih'), h('span.small.muted', deadlineText(s))),
              h('div.progress', h('i', { style: { width: Math.min(100, s.kuota ? s.jumlah_pilihan / s.kuota * 100 : 0) + '%' } }))));
        })));
      }).catch(err);
    }
    var t; search.addEventListener('input', function () { clearTimeout(t); t = setTimeout(load, 300); });
    urut.addEventListener('change', load);
    load();
  }

  // ---------- S3: Buat sesi ----------
  function pageBuat() {
    if (!can('sesi.kelola')) { main.appendChild(h('div.alert.err', 'Peranmu tidak bisa membuat galeri.')); return; }
    main.appendChild(head('Buat galeri baru', null, h('div.steps', ['1 Info sesi', '2 Sumber foto', '3 Aturan', '4 Bagikan'].map(function (s, i) { return h('span', { class: i < 2 ? 'on' : '' }, s); })),
      h('div.crumb', h('a', { href: '#/galeri' }, 'Galeri'), ' / Buat baru')));
    loading();
    api('GET', '/api/pakets').then(function (pakets) {
      main.lastChild.remove();
      buildCreate(pakets);
    }).catch(err);
  }
  function buildCreate(pakets) {
    var defSrc = CFG.serviceAccountEmail ? 'service_account' : (CFG.googleApiKey ? 'link_publik' : (CFG.demoSource ? 'contoh' : 'service_account'));
    var st = { sumber: defSrc, cek: null, folderId: null, resourceKey: null };
    var f = {};
    function inp(name, attrs) { f[name] = h(attrs && attrs.tag === 'select' ? 'select.select' : 'input.input', Object.assign({ name: name }, attrs || {})); return f[name]; }
    var cabSel = ME.cabang_id ? null : cabangSelect(null, 'Tanpa cabang');
    var paketSel = h('select.select', { name: 'paket_id', 'aria-label': 'Paket' }, pakets.map(function (p) { return h('option', { value: p.id }, p.nama + ' · ' + p.kuota + ' foto'); }), h('option', { value: '' }, 'Kustom'));
    f.paket_id = paketSel;
    var ruleBox = h('div.grid-2');
    function fillRules() {
      var p = pakets.filter(function (x) { return String(x.id) === paketSel.value; })[0] || { kuota: 10, durasi_pilih_menit: 0, masa_aktif_jam: 168, harga_foto_tambahan: 0, maks_foto_tambahan: 0 };
      ['kuota', 'durasi_pilih_menit', 'masa_aktif_jam', 'harga_foto_tambahan', 'maks_foto_tambahan'].forEach(function (k) { f[k].value = p[k]; });
      f.harga_bertingkat.value = tiersText(p.harga_bertingkat);
      if (!f.jenis.value || f.jenis.dataset.auto) { f.jenis.value = p.nama || ''; f.jenis.dataset.auto = '1'; }
      preview();
    }
    var dec = h('button.icon-btn', { type: 'button', 'aria-label': 'Kurangi kuota', onclick: function () { f.kuota.value = Math.max(1, (+f.kuota.value || 1) - 1); preview(); } }, '−');
    var incb = h('button.icon-btn', { type: 'button', 'aria-label': 'Tambah kuota', onclick: function () { f.kuota.value = (+f.kuota.value || 0) + 1; preview(); } }, '+');
    ruleBox.appendChild(h('label.field', h('span', 'Kuota foto'), h('div.stepper', dec, inp('kuota', { type: 'number', min: 1, max: 5000, inputmode: 'numeric' }), incb)));
    ruleBox.appendChild(h('label.field', h('span', 'Durasi pilih (menit)'), inp('durasi_pilih_menit', { type: 'number', min: 0, max: 10080, inputmode: 'numeric' }), h('span.hint', '0 = tenggat saja, tanpa hitung mundur')));
    ruleBox.appendChild(h('label.field', h('span', 'Masa aktif link'), inp('masa_aktif_jam', { tag: 'select' })));
    [[6, '6 jam'], [24, '24 jam'], [48, '2 hari'], [72, '3 hari'], [168, '7 hari'], [336, '14 hari'], [720, '30 hari']].forEach(function (o) { f.masa_aktif_jam.appendChild(h('option', { value: o[0] }, o[1])); });
    ruleBox.appendChild(h('label.field', h('span', 'PIN (opsional)'), inp('pin', { inputmode: 'numeric', maxlength: 6, placeholder: 'Acak 6 digit', pattern: '\\d{4,6}' }), h('span.hint', '4–6 digit. Kosongkan untuk dibuat otomatis.')));
    ruleBox.appendChild(h('label.field', h('span', 'Harga per foto tambahan (Rp)'), inp('harga_foto_tambahan', { type: 'number', min: 0, step: 1000, inputmode: 'numeric' })));
    ruleBox.appendChild(h('label.field', h('span', 'Batas foto tambahan'), inp('maks_foto_tambahan', { type: 'number', min: 0, inputmode: 'numeric' }), h('span.hint', '0 = tidak boleh melebihi kuota')));
    ruleBox.appendChild(h('label.field', h('span', 'Harga bertingkat (opsional)'), inp('harga_bertingkat', { placeholder: '5=100000, 10=180000' }), h('span.hint', 'Paket foto tambahan lebih murah: jumlah=harga. Sistem memilih total termurah.')));
    var tNama = h('input', { type: 'checkbox', checked: true }), tCat = h('input', { type: 'checkbox', checked: true });

    // Sumber
    var srcBox = h('div.src-opts');
    var opts = [
      ['service_account', 'Bagikan ke email layanan', CFG.serviceAccountEmail ? 'Folder tetap privat. Pilih lewat Google atau tempel link.' : 'Butuh GOOGLE_SERVICE_ACCOUNT_JSON di server.', !CFG.serviceAccountEmail],
      ['link_publik', 'Link publik', CFG.googleApiKey ? '"Siapa saja yang memiliki link". Tercepat, kurang privat.' : 'Butuh GOOGLE_API_KEY di server.', !CFG.googleApiKey],
    ];
    if (CFG.demoSource) opts.push(['contoh', 'Foto contoh', 'Galeri demo berisi blok warna, untuk mencoba alur.', false]);
    var srcDetail = h('div.stack', { style: { gap: '12px' } });
    function drawSrc() {
      srcBox.innerHTML = '';
      opts.forEach(function (o) {
        srcBox.appendChild(h('label.src-opt', { class: st.sumber === o[0] ? 'on' : '' }, h('input', { type: 'radio', name: 'sumber', value: o[0], checked: st.sumber === o[0], disabled: o[3], onchange: function () { st.sumber = o[0]; st.cek = null; st.folderId = null; drawSrc(); } }), h('div', h('b', o[1]), h('small', o[2]))));
      });
      srcDetail.innerHTML = '';
      if (st.sumber === 'contoh') {
        srcDetail.appendChild(h('label.field', h('span', 'Jumlah foto contoh'), inp('jumlah_contoh', { type: 'number', min: 1, max: 500, value: 48 })));
        st.cek = { ok: true, jumlah: 49, contoh: true };
      } else {
        var link = inp('link', { class: 'input mono', placeholder: 'https://drive.google.com/drive/folders/…', 'aria-label': 'Link folder Google Drive', oninput: function () { st.folderId = null; st.cek = null; drawCek(); } });
        srcDetail.appendChild(h('label.field', h('span', 'Link folder Google Drive ', h('span.req', '*')), h('div.row', { style: { flexWrap: 'nowrap' } }, link, h('button.btn.btn-secondary', { type: 'button', onclick: cek }, 'Cek akses'))));
        if (st.sumber === 'service_account' && CFG.serviceAccountEmail) {
          srcDetail.appendChild(h('div.alert.info', 'Cara manual: di Google Drive buka folder → Bagikan → tambahkan ',
            h('b.mono', CFG.serviceAccountEmail), ' sebagai Pelihat. ',
            h('button.btn.btn-sm.btn-secondary', { type: 'button', onclick: function () { UI.copy(CFG.serviceAccountEmail, 'Email layanan tersalin'); } }, ic('salin'), 'Salin email')));
          if (CFG.googleClientId && CFG.googleApiKey) srcDetail.appendChild(h('button.btn.btn-teal', { type: 'button', onclick: pickFromDrive }, ic('drive'), 'Pilih dari Google Drive'));
        }
        if (st.sumber === 'link_publik') srcDetail.appendChild(h('div.alert', 'Peringatan: siapa pun yang memegang link folder bisa membuka semua file asli tanpa PIN. Link Drive tidak pernah dikirim ke pelanggan, tapi tetap hati-hati membagikannya.'));
      }
      srcDetail.appendChild(cekBox);
      drawCek();
    }
    var cekBox = h('div');
    function drawCek() {
      cekBox.innerHTML = '';
      var c = st.cek;
      if (!c) return;
      if (!c.ok) {
        cekBox.appendChild(h('div.alert.err', h('b', 'Folder belum bisa dibaca. '), c.error || '', c.langkah ? h('ol', { style: { margin: '8px 0 0', paddingLeft: '20px' } }, c.langkah.map(function (l) { return h('li', l); })) : null));
        return;
      }
      if (c.contoh) { cekBox.appendChild(h('p.ok-text', 'Galeri contoh siap dibuat.')); return; }
      cekBox.appendChild(h('p.ok-text', c.jumlah + ' foto ditemukan' + (c.pertama ? ' · ' + c.pertama + ' sampai ' + c.terakhir : '') + (c.ukuran ? ' · ' + fmtBytes(c.ukuran) : '') + (c.nama ? ' · folder "' + c.nama + '"' : '')));
      if (c.contoh_nama && c.contoh_nama.length) {
        cekBox.appendChild(h('div', h('div.small', { style: { fontWeight: 600, margin: '8px 0' } }, 'Pratinjau penomoran'),
          h('div.num-preview', c.contoh_nama.map(function (n, i) { return h('div', h('i', { 'data-n': F.pad(i + 1, c.jumlah), style: { background: TONE[i % TONE.length] } }), F.stripExt(n)); }))));
      }
    }
    function srcBody() {
      var b = { sumber: st.sumber, urutan: f.urutan_nama.checked ? 'nama' : 'waktu' };
      if (st.sumber === 'contoh') b.jumlah_contoh = f.jumlah_contoh.value;
      else if (st.folderId) { b.folder_id = st.folderId; b.resource_key = st.resourceKey; }
      else b.link = f.link.value.trim();
      return b;
    }
    function cek() {
      cekBox.innerHTML = ''; cekBox.appendChild(h('p.small.muted', 'Memeriksa akses folder…'));
      return api('POST', '/api/drive/cek', srcBody()).then(function (r) { st.cek = r; drawCek(); preview(); return r; }).catch(function (e) { st.cek = { ok: false, error: e.message }; drawCek(); });
    }
    function pickFromDrive() {
      loadPicker().then(function (token) {
        var view = new google.picker.DocsView(google.picker.ViewId.FOLDERS).setSelectFolderEnabled(true).setIncludeFolders(true).setMimeTypes('application/vnd.google-apps.folder');
        var pb = new google.picker.PickerBuilder().addView(view).setOAuthToken(token).setDeveloperKey(CFG.googleApiKey).setLocale('id')
          .enableFeature(google.picker.Feature.SUPPORT_DRIVES)
          .setCallback(function (data) {
            if (data.action !== google.picker.Action.PICKED) return;
            var doc = data.docs[0];
            cekBox.innerHTML = ''; cekBox.appendChild(h('p.small.muted', 'Membagikan folder "' + doc.name + '" ke email layanan…'));
            api('POST', '/api/drive/bagikan', { access_token: token, folder_id: doc.id }).then(function () {
              st.folderId = doc.id; st.resourceKey = doc.resourceKey || null; f.link.value = doc.url || ('https://drive.google.com/drive/folders/' + doc.id);
              return cek();
            }).catch(function (e) { st.cek = { ok: false, error: e.message }; drawCek(); });
          });
        if (CFG.googleAppId) pb.setAppId(CFG.googleAppId);
        pb.build().setVisible(true);
      }).catch(err);
    }

    var urutBox = h('div.radio-row', h('label', f.urutan_nama = h('input', { type: 'radio', name: 'urutan', checked: true }), 'Nama file (A–Z)'), h('label', h('input', { type: 'radio', name: 'urutan' }), 'Waktu foto diambil'));
    var aside = h('div.aside');
    var pv = h('div.panel-dark');
    var ring = h('div.card.card-sm');
    aside.appendChild(pv); aside.appendChild(ring);
    function preview() {
      pv.innerHTML = '';
      pv.appendChild(h('div.label', { style: { color: '#A9B8BA' } }, 'Pratinjau untuk pelanggan'));
      pv.appendChild(h('div', { style: { font: '800 30px/1 var(--f-display)', textTransform: 'uppercase', margin: '10px 0 8px', overflowWrap: 'anywhere' } }, (f.judul && f.judul.value) || (f.pelanggan_nama && f.pelanggan_nama.value) || 'Nama pelanggan'));
      pv.appendChild(h('div.small', { style: { color: '#C9D3D5' } }, [f.jenis && f.jenis.value, st.cek && st.cek.ok ? st.cek.jumlah + ' foto' : null, 'pilih ' + (f.kuota ? f.kuota.value : '?')].filter(Boolean).join(' · ')));
      var dm = f.durasi_pilih_menit ? +f.durasi_pilih_menit.value : 0;
      pv.appendChild(h('div.small', { style: { color: '#E9D8A6', marginTop: '6px' } }, dm > 0 ? 'Hitung mundur ' + dm + ' menit' : 'Tenggat saja'));
      ring.innerHTML = '';
      ring.appendChild(h('b', 'Ringkasan'));
      var hrg = f.harga_foto_tambahan ? +f.harga_foto_tambahan.value : 0, mx = f.maks_foto_tambahan ? +f.maks_foto_tambahan.value : 0;
      [['Nomor foto', st.cek && st.cek.ok ? '001–' + F.pad(st.cek.jumlah, st.cek.jumlah) : '–'], ['Masa aktif', f.masa_aktif_jam ? f.masa_aktif_jam.selectedOptions[0].textContent : '–'],
        ['Foto tambahan', mx > 0 ? F.rupiah(hrg) + ' · maks ' + mx : 'Tidak'], ['Nama file', tNama.checked ? 'Ditampilkan' : 'Disembunyikan']].forEach(function (kv) {
        ring.appendChild(h('div.kv', h('span', kv[0]), h('span', kv[1])));
      });
    }

    var submit = h('button.btn.btn-primary', { type: 'submit' }, 'Buat galeri & dapatkan link');
    var form = h('form.stack', { onsubmit: function (e) {
      e.preventDefault();
      var body = Object.assign(srcBody(), {
        pelanggan_nama: f.pelanggan_nama.value, pelanggan_wa: f.pelanggan_wa.value, judul: f.judul.value, jenis: f.jenis.value, tanggal_sesi: f.tanggal_sesi.value,
        paket_id: paketSel.value || null, kuota: f.kuota.value, durasi_pilih_menit: f.durasi_pilih_menit.value, masa_aktif_jam: f.masa_aktif_jam.value,
        harga_foto_tambahan: f.harga_foto_tambahan.value, maks_foto_tambahan: f.maks_foto_tambahan.value, pin: f.pin.value.trim() || undefined,
        harga_bertingkat: f.harga_bertingkat.value, cabang_id: cabSel ? cabSel.value || null : null,
        tampil_nama_file: tNama.checked, izin_catatan: tCat.checked,
      });
      submit.disabled = true;
      var go2 = st.sumber !== 'contoh' && !(st.cek && st.cek.ok) ? cek() : Promise.resolve(st.cek);
      go2.then(function (c) {
        if (!c || !c.ok) { submit.disabled = false; UI.toast('Periksa akses folder dulu.', true); return; }
        return api('POST', '/api/sesis', body).then(function (r) {
          UI.toast(r.wa && r.wa.error ? 'Galeri dibuat, tapi WhatsApp gagal: ' + r.wa.error : r.wa ? 'Galeri dibuat & link terkirim via WhatsApp' : 'Galeri dibuat, sinkronisasi berjalan', r.wa && r.wa.error);
          go('#/galeri/' + r.id);
        });
      }).catch(function (e2) { submit.disabled = false; err(e2); });
    } },
    h('section.card', h('h2.title', '1 · Info sesi'), h('div.grid-2',
      h('label.field', h('span', 'Nama pelanggan ', h('span.req', '*')), inp('pelanggan_nama', { required: true, maxlength: 80, placeholder: 'Rina & Dimas', oninput: preview })),
      h('label.field', h('span', 'No. WhatsApp pelanggan'), inp('pelanggan_wa', { inputmode: 'tel', placeholder: '0812…' })),
      h('label.field', h('span', 'Paket'), paketSel),
      cabSel ? h('label.field', h('span', 'Cabang'), cabSel) : null,
      h('label.field', h('span', 'Jenis sesi'), inp('jenis', { maxlength: 60, placeholder: 'Wisuda', oninput: function () { delete f.jenis.dataset.auto; preview(); } })),
      h('label.field', h('span', 'Judul galeri'), inp('judul', { maxlength: 120, placeholder: 'Sama dengan nama pelanggan', oninput: preview })),
      h('label.field', h('span', 'Tanggal sesi'), inp('tanggal_sesi', { type: 'date' })))),
    h('section.card', h('h2.title', '2 · Sumber foto'), h('div.stack', { style: { gap: '14px' } }, srcBox, srcDetail, h('div.field', h('span', 'Urutan nomor'), urutBox))),
    h('section.card', h('h2.title', '3 · Aturan pilihan'), h('p.small.muted', { style: { marginTop: '-8px' } }, 'Nilai diambil dari paket dan bisa diubah khusus sesi ini.'), ruleBox,
      h('div', { style: { marginTop: '16px' } },
        h('div.toggle-row', h('div', h('b', 'Tampilkan nama file ke pelanggan'), h('span.small.muted', 'Pelanggan melihat DSC_4501.JPG di bawah nomor.')), h('label.switch', tNama, h('span'))),
        h('div.toggle-row', h('div', h('b', 'Izinkan catatan per foto'), h('span.small.muted', 'Pelanggan bisa menulis permintaan edit, mis. "crop lebih rapat".')), h('label.switch', tCat, h('span'))))),
    h('div.row', { style: { justifyContent: 'flex-end' } }, h('a.btn.btn-secondary', { href: '#/galeri' }, 'Batal'), submit));
    paketSel.addEventListener('change', fillRules);
    form.addEventListener('input', preview);
    main.appendChild(h('div.create', form, aside));
    drawSrc(); fillRules(); f.masa_aktif_jam.value = f.masa_aktif_jam.value || 168; preview();
  }

  function tiersText(t) { return (t || []).map(function (x) { return x.jumlah + '=' + x.harga; }).join(', '); }
  function tiersLabel(t) { return (t || []).map(function (x) { return '+' + x.jumlah + ' ' + F.rupiah(x.harga); }).join(' · '); }

  var pickerReady = null;
  function loadScript(src) { return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = function () { rej(new Error('Gagal memuat ' + src)); }; document.head.appendChild(s); }); }
  function loadPicker() {
    if (!pickerReady) {
      pickerReady = Promise.all([loadScript('https://apis.google.com/js/api.js'), loadScript('https://accounts.google.com/gsi/client')])
        .then(function () { return new Promise(function (r) { gapi.load('picker', r); }); });
    }
    return pickerReady.then(function () {
      return new Promise(function (resolve, reject) {
        var client = google.accounts.oauth2.initTokenClient({ client_id: CFG.googleClientId, scope: 'https://www.googleapis.com/auth/drive.file',
          callback: function (resp) { if (resp.error) reject(new Error(resp.error)); else resolve(resp.access_token); } });
        client.requestAccessToken({ prompt: '' });
      });
    });
  }

  // ---------- S4: Detail sesi ----------
  function pageDetail(id) {
    loading();
    var filter = 'semua';
    function load() {
      return api('GET', '/api/sesis/' + id).then(function (s) { draw(s); return s; }).catch(function (e) { main.innerHTML = ''; main.appendChild(h('div.alert.err', e.message)); });
    }
    function draw(s) {
      var y = window.scrollY;
      main.innerHTML = '';
      var offset = new Date(s.server_now).getTime() - Date.now();
      var right = [];
      if (can('sesi.kelola')) {
        right.push(h('button.btn.btn-secondary', { type: 'button', onclick: function () { act('/sinkron', {}, 'Sinkron ulang dimulai'); } }, ic('sinkron'), 'Sinkron ulang Drive'));
        right.push(h('button.btn.btn-secondary', { type: 'button', onclick: function () { perpanjangLink(); } }, 'Perpanjang link'));
        right.push(h('button.btn.btn-secondary', { type: 'button', onclick: function () { showQr(s); } }, ic('qr'), 'QR'));
        if (['siap', 'dibuka', 'memilih'].indexOf(s.status_db) >= 0) right.push(h('button.btn.btn-secondary', { type: 'button', onclick: function () { openKiosk(s.id); } }, ic('kiosk'), 'Buka di kiosk'));
        if (['terkirim', 'waktu_habis', 'selesai', 'kedaluwarsa'].indexOf(s.status) >= 0) right.push(h('button.btn.btn-primary', { type: 'button', onclick: bukaUlang }, ic('kunci'), 'Buka ulang pilihan'));
      }
      var picked = s.fotos.filter(function (x) { return x.dipilih; });
      main.appendChild(head(s.judul, [s.jenis, s.tanggal_sesi ? UI.fmtDate(s.tanggal_sesi + 'T12:00:00Z', tz()) : null, s.paket_nama ? 'Paket ' + s.paket_nama : null].filter(Boolean).join(' · '), right,
        h('div.crumb', h('a', { href: '#/galeri' }, 'Galeri'), ' / ', s.judul, ' ', UI.statusBadge(s.status))));

      // Alert minta waktu
      if (s.minta_waktu_pada && s.status_db === 'memilih' && can('sesi.kelola')) {
        main.appendChild(h('div.alert', { style: { marginBottom: '16px' } }, h('div.alert-row', h('div', h('b', 'Pelanggan minta tambah waktu'), ' · ' + UI.rel(s.minta_waktu_pada)),
          h('div.row', [5, 10, 15].map(function (m) { return h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: function () { act('/aksi', { aksi: 'tambah_waktu', menit: m }, '+' + m + ' menit ditambahkan'); } }, '+' + m + ' menit'); }),
            h('button.btn.btn-sm.btn-secondary', { type: 'button', onclick: function () { act('/aksi', { aksi: 'tolak_minta_waktu' }, 'Permintaan ditutup'); } }, 'Abaikan')))));
      } else if (s.minta_waktu_pada && ['kedaluwarsa', 'terkirim', 'waktu_habis'].indexOf(s.status) >= 0 && can('sesi.kelola')) {
        main.appendChild(h('div.alert', { style: { marginBottom: '16px' } }, h('b', 'Pelanggan minta tambah waktu ' + UI.rel(s.minta_waktu_pada) + '. '), 'Gunakan "Buka ulang pilihan" atau "Perpanjang link".'));
      }
      if (s.terpilih_status === 'berjalan') pollT = setTimeout(load, 3000);
      if (s.sinkron_status !== 'selesai') {
        var pct = s.sinkron_total ? Math.round(s.sinkron_selesai / s.sinkron_total * 100) : 0;
        main.appendChild(h('div.sync-box', { style: { marginBottom: '16px' } },
          s.sinkron_status === 'gagal'
            ? h('div', h('b', { style: { color: 'var(--scarlet)' } }, 'Sinkron gagal: '), s.sinkron_error, can('sesi.kelola') ? h('button.btn.btn-sm.btn-secondary', { type: 'button', style: { marginLeft: '12px' }, onclick: function () { act('/sinkron', {}, 'Mencoba lagi'); } }, 'Coba lagi') : null)
            : [h('div.row', { style: { justifyContent: 'space-between' } }, h('b', 'Menyinkron dari Google Drive…'), h('span.mono', s.sinkron_selesai + ' dari ' + (s.sinkron_total || '?') + ' foto')), h('div.progress.teal', { style: { marginTop: '8px' } }, h('i', { style: { width: pct + '%' } }))]));
        if (s.sinkron_status !== 'gagal') pollT = setTimeout(load, 2500);
      } else if (s.status_db === 'memilih') {
        pollT = setTimeout(load, 15000);
      }

      var top = h('div.detail-top');
      if (s.link) {
        top.appendChild(h('section.panel-teal.link-panel',
          h('b', 'Link untuk pelanggan'),
          h('div.linkbox', h('code', s.link), h('button.btn.btn-amber', { type: 'button', onclick: function () { UI.copy(s.link, 'Link tersalin'); } }, ic('salin'), 'Salin link')),
          h('div.row', { style: { justifyContent: 'space-between' } },
            h('div', h('div.small', { style: { color: '#C9E3E6' } }, 'PIN'), h('span.pin', s.pin), ' ',
              h('button.btn.btn-sm.btn-ghost-dark', { type: 'button', onclick: gantiPin }, 'Ganti PIN')),
            h('div.row',
              h('button.btn.btn-ghost-dark', { type: 'button', onclick: function () { UI.copy(s.wa_text, 'Pesan tersalin'); } }, ic('salin'), 'Salin pesan'),
              h('a.btn.btn-amber', { href: s.wa_url, target: '_blank', rel: 'noopener', onclick: function () { api('POST', '/api/sesis/' + id + '/aksi', { aksi: 'link_dikirim' }).catch(function () {}); } }, ic('wa'), 'Kirim via WhatsApp'),
              ME.integrasi.wa_api && fitur('wa_api') && s.pelanggan_wa ? h('button.btn.btn-ghost-dark', { type: 'button', onclick: function (e) {
                e.currentTarget.disabled = true; api('POST', '/api/sesis/' + id + '/wa').then(function () { UI.toast('Terkirim otomatis via WhatsApp API'); load(); }).catch(function (x) { err(x); load(); });
              } }, 'Kirim otomatis (API)') : null)),
          h('div.small', { style: { color: '#C9E3E6', marginTop: '12px' } }, 'Berakhir ' + UI.fmtDateTime(s.tenggat_link, tz()) + (s.link_dikirim_pada ? ' · link dikirim ' + UI.rel(s.link_dikirim_pada) : ' · link belum dikirim'))));
      } else {
        top.appendChild(h('section.card', h('b', 'Tenggat link'), h('p', UI.fmtDateTime(s.tenggat_link, tz()))));
      }
      top.appendChild(h('div.mini-stats',
        h('div.stat', h('span.label', 'Foto'), h('div.v', String(s.jumlah_foto))),
        h('div.stat', h('span.label', 'Dipilih'), h('div.v', s.jumlah_pilihan + '/' + s.kuota)),
        h('div.stat', h('span.label', 'Dibuka'), h('div.v', s.jumlah_dibuka + '×'), h('div.small.muted', s.dibuka_pada ? 'pertama ' + UI.rel(s.dibuka_pada) : 'belum dibuka')),
        h('div.stat', h('span.label', s.status_db === 'memilih' ? 'Sisa timer' : 'Berakhir'), (function () {
          var v = h('div.v', { 'data-left': '1' });
          var end = s.status_db === 'memilih' && s.berakhir_pada ? s.berakhir_pada : s.tenggat_link;
          function upd() { var l = new Date(end).getTime() - (Date.now() + offset); v.textContent = l > 0 ? (s.status_db === 'memilih' ? UI.dur(l) : UI.rel(end).replace('dalam ', '')) : 'Habis'; }
          upd(); if (s.status_db === 'memilih') { var t = setInterval(function () { if (!document.body.contains(v)) return clearInterval(t); upd(); }, 1000); }
          return v;
        })())));
      main.appendChild(top);

      // Timer & kontrol
      var ctl = h('section.card', { style: { marginTop: '16px' } });
      ctl.appendChild(h('div.timer-box',
        h('div', h('div.label', 'Status & timer'), h('div', { style: { marginTop: '6px' } }, UI.statusBadge(s.status), ' ',
          h('span.small.muted', s.durasi_pilih_menit > 0 ? 'Hitung mundur ' + s.durasi_pilih_menit + ' menit' : 'Mode tenggat saja'),
          s.mulai_pilih_pada ? h('span.small.muted', ' · mulai ' + UI.fmtDateTime(s.mulai_pilih_pada, tz())) : null,
          s.dikirim_pada ? h('span.small.muted', ' · dikirim ' + UI.fmtDateTime(s.dikirim_pada, tz()) + (s.dikirim_otomatis ? ' (otomatis)' : '')) : null,
          s.jumlah_pilihan < s.kuota && s.dikirim_pada ? h('span.badge.st-segera', { style: { marginLeft: '6px' } }, 'Kurang dari kuota') : null)),
        can('sesi.kelola') ? h('div.row',
          s.status_db === 'memilih' ? [5, 10, 15].map(function (m) { return h('button.btn.btn-sm.btn-secondary', { type: 'button', onclick: function () { act('/aksi', { aksi: 'tambah_waktu', menit: m }, '+' + m + ' menit'); } }, '+' + m + ' mnt'); }) : null,
          ['memilih', 'terkirim', 'kedaluwarsa', 'dibuka'].indexOf(s.status_db) >= 0 ? h('button.btn.btn-sm.btn-secondary', { type: 'button', onclick: resetTimer }, 'Reset timer') : null) : null));
      main.appendChild(ctl);

      // Grid foto
      var grid = h('div.photo-grid');
      var seg = h('div.seg', [['semua', 'Semua foto · ' + s.fotos.filter(function (x) { return !x.dihapus; }).length], ['dipilih', 'Dipilih pelanggan · ' + picked.length]].map(function (t) {
        return h('button', { type: 'button', class: filter === t[0] ? 'on' : '', onclick: function () { filter = t[0]; draw(s); } }, t[1]);
      }));
      var list = s.fotos.filter(function (x) { return filter === 'dipilih' ? x.dipilih : (!x.dihapus || x.dipilih); });
      list.forEach(function (x) {
        grid.appendChild(h('div.tile' + (x.dipilih ? '.sel' : '') + (x.dihapus ? '.gone' : ''),
          h('div.ph', { onclick: function () { lightbox(s, x); } }, h('span.no', F.pad(x.nomor, s.nomor_total)), h('img', { src: x.thumb, alt: 'Foto ' + x.nomor, loading: 'lazy' }),
            x.catatan ? h('span.flag', { title: x.catatan }, ic('catatan')) : null, x.is_tambahan ? h('span.extra', 'Tambahan') : null),
          h('div.info', h('span.filename', { title: (x.path_subfolder ? x.path_subfolder + '/' : '') + x.nama_file }, x.nama_file, x.nama_kembar ? h('span.dup', ' · ' + (x.path_subfolder || 'kembar')) : null, x.dihapus ? h('span.dup', ' · dihapus') : null)),
          x.catatan ? h('div.note-chip', '“' + x.catatan + '”') : null));
      });
      if (!list.length) grid.appendChild(h('div.empty', { style: { gridColumn: '1/-1' } }, filter === 'dipilih' ? 'Belum ada foto dipilih.' : 'Belum ada foto.'));
      main.appendChild(h('section.card', { style: { marginTop: '16px' } },
        h('div.filters', seg, h('div.small.muted', s.drive_folder_url ? h('a', { href: s.drive_folder_url, target: '_blank', rel: 'noopener' }, 'Buka folder Drive') : 'Sumber: foto contoh', s.sinkron_pada ? ' · sinkron ' + UI.rel(s.sinkron_pada) : '')),
        picked.length ? exportBar(s, picked) : null,
        s.catatan_umum ? h('div.alert', { style: { margin: '0 0 16px' } }, h('b', 'Catatan umum: '), s.catatan_umum) : null,
        grid));

      // Bawah: tagihan, editor, pengaturan, log
      var bottom = h('div.two-col', { style: { marginTop: '16px' } });
      var leftCol = h('div.stack');
      leftCol.appendChild(tagihanCard(s));
      leftCol.appendChild(editorCard(s));
      leftCol.appendChild(hasilCard(s));
      if (can('sesi.kelola') && s.sumber === 'service_account') leftCol.appendChild(terpilihCard(s, load));
      if (can('sesi.kelola')) leftCol.appendChild(settingsCard(s));
      bottom.appendChild(leftCol);
      bottom.appendChild(h('section.card', h('h2.title', 'Log aktivitas'), h('ul.log', s.events.map(function (e) {
        return h('li', h('time', UI.fmtDate(e.waktu, tz(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })), h('div', h('b', eventLabel(e)), ' · ', h('span.muted', e.aktor), e.detail ? h('div.small.muted', eventDetail(e)) : null));
      }))));
      main.appendChild(bottom);
      window.scrollTo(0, y);

      function act(path, body, ok) {
        return api('POST', '/api/sesis/' + id + path, body).then(function () { if (ok) UI.toast(ok); clearTimeout(pollT); return load(); }).catch(err);
      }
      function perpanjangLink() {
        var sel = h('select.select', [[24, '24 jam'], [48, '2 hari'], [168, '7 hari'], [336, '14 hari']].map(function (o) { return h('option', { value: o[0] }, '+' + o[1]); }));
        UI.modal({ title: 'Perpanjang tenggat link', body: h('div.stack', { style: { gap: '10px' } }, h('p.muted', 'Tenggat saat ini: ' + UI.fmtDateTime(s.tenggat_link, tz())), sel), actions: [
          { label: 'Batal' }, { label: 'Perpanjang', cls: 'btn-primary', onClick: function (c) { c(); act('/aksi', { aksi: 'perpanjang_link', jam: +sel.value }, 'Tenggat diperpanjang'); } }] });
      }
      function bukaUlang() {
        var cd = s.durasi_pilih_menit > 0;
        var sel = h('select.select', (cd ? [[5, '5 menit'], [10, '10 menit'], [15, '15 menit'], [30, '30 menit'], [60, '60 menit']] : [[6, '6 jam'], [24, '24 jam'], [48, '2 hari']]).map(function (o) { return h('option', { value: o[0], selected: o[0] === 15 || o[0] === 24 }, o[1]); }));
        UI.modal({ title: 'Buka ulang pilihan?', body: h('div.stack', { style: { gap: '10px' } }, h('p.muted', 'Pelanggan bisa mengubah pilihan lagi. Waktu tambahan:'), sel), actions: [
          { label: 'Batal' }, { label: 'Buka ulang', cls: 'btn-primary', onClick: function (c) { c(); act('/aksi', cd ? { aksi: 'buka_ulang', menit: +sel.value } : { aksi: 'buka_ulang', jam: +sel.value }, 'Pilihan dibuka ulang'); } }] });
      }
      function resetTimer() {
        UI.confirm('Reset timer?', 'Timer kembali ke awal dan pelanggan menekan "Mulai pilih" lagi. Pilihan yang sudah ada tetap tersimpan.', 'Reset').then(function (ok) { if (ok) act('/aksi', { aksi: 'reset_timer' }, 'Timer di-reset'); });
      }
      function gantiPin() {
        UI.confirm('Ganti PIN?', 'PIN lama tidak berlaku dan pelanggan yang sedang membuka galeri harus memasukkan PIN baru.', 'Ganti PIN').then(function (ok) {
          if (ok) api('POST', '/api/sesis/' + id + '/pin', {}).then(function (r) { UI.toast('PIN baru: ' + r.pin); load(); }).catch(err);
        });
      }
    }
    load();
  }
  var EVENT = { dibuat: 'Galeri dibuat', sinkron: 'Sinkron Drive', sinkron_gagal: 'Sinkron gagal', dibuka: 'Pelanggan membuka galeri', mulai: 'Mulai pilih', pilih: 'Pilih', batal: 'Batal pilih',
    kirim: 'Pilihan dikirim', waktu_habis: 'Waktu habis · terkirim otomatis', perpanjang: 'Waktu ditambah', perpanjang_link: 'Tenggat link diperpanjang', buka_ulang: 'Dibuka ulang',
    reset_timer: 'Timer di-reset', minta_waktu: 'Minta tambah waktu', tolak_minta_waktu: 'Permintaan waktu ditutup', kedaluwarsa: 'Kedaluwarsa', bayar: 'Status bayar', editor: 'Status editor',
    ubah: 'Pengaturan sesi diubah', ganti_pin: 'PIN diganti', pin_terkunci: 'PIN terkunci 15 menit', link_dikirim: 'Link dikirim via WhatsApp' };
  function eventLabel(e) { return EVENT[e.jenis] || e.jenis; }
  function eventDetail(e) {
    var d = e.detail || {};
    if (d.nomor) return 'Foto ' + F.pad(d.nomor, 0);
    if (e.jenis === 'sinkron') return d.total + ' foto · ' + d.baru + ' baru · ' + d.berubah + ' berubah · ' + d.terhapus + ' terhapus';
    if (d.menit) return '+' + d.menit + ' menit';
    if (d.jam) return '+' + d.jam + ' jam';
    if (d.alasan === 'gangguan_sistem') return 'Gangguan sistem · +' + d.detik + ' detik';
    if (d.jumlah !== undefined) return d.jumlah + ' foto' + (d.kurang_dari_kuota ? ' · kurang dari kuota ' + d.kuota : '');
    if (d.status_bayar) return d.status_bayar === 'lunas' ? 'Lunas' + (d.metode ? ' · ' + d.metode : '') : 'Belum bayar';
    if (d.editor_status) return d.editor_status;
    if (d.error) return d.error;
    return '';
  }

  function exportBar(s, picked) {
    var fmt = ME.studio.format_salin || 'lightroom';
    var withExt = true;
    var box = h('div', { style: { marginBottom: '16px' } });
    function draw() {
      box.innerHTML = '';
      var text = F.fileList(picked, fmt, { total: s.nomor_total, ext: withExt });
      box.appendChild(h('div.row', { style: { justifyContent: 'space-between', marginBottom: '10px' } },
        h('div.pills', Object.keys(F.FORMATS).map(function (k) { return h('button', { type: 'button', class: fmt === k ? 'on' : '', onclick: function () { fmt = k; draw(); } }, F.FORMATS[k].label); })),
        h('div.row',
          fmt === 'baris' || fmt === 'koma' ? h('label.row.small', { style: { gap: '6px' } }, h('input', { type: 'checkbox', checked: withExt, onchange: function (e) { withExt = e.target.checked; draw(); } }), 'Dengan ekstensi') : null,
          h('button.btn.btn-amber', { type: 'button', onclick: function () { UI.copy(text, picked.length + ' nama file tersalin'); } }, ic('salin'), 'Salin daftar'),
          h('a.btn.btn-secondary', { href: '/api/sesis/' + s.id + '/ekspor.csv' }, ic('unduh'), 'CSV'),
          h('a.btn.btn-secondary', { href: '/api/sesis/' + s.id + '/ekspor.txt?path=1' }, ic('unduh'), 'TXT + path'))));
      box.appendChild(h('div.codebox', text));
      var hint = { lightroom: 'Lightroom: Library › Filter Teks › "Berisi" lalu tempel. Semua file pilihan langsung tersaring.', windows: 'Windows Explorer: tempel di kotak pencarian folder.', nomor: 'Nomor tetap sama dengan yang dilihat pelanggan.' }[fmt];
      var dups = picked.filter(function (x) { return x.nama_kembar; });
      box.appendChild(h('p.small.muted', { style: { margin: '8px 0 0' } }, hint || '', dups.length ? h('span.dup', ' Ada ' + dups.length + ' nama file kembar: cek kolom path di CSV agar tidak tertukar.') : null));
    }
    draw();
    return box;
  }
  function tagihanCard(s) {
    var t = s.tagihan || { jumlah_foto: 0, total_rupiah: 0, status_bayar: 'belum_bayar' };
    var card = h('section.card', h('h2.title', 'Foto tambahan'));
    card.appendChild(h('div.kv', h('span', 'Jumlah'), h('span', t.jumlah_foto + ' foto × ' + F.rupiah(s.harga_foto_tambahan))));
    if (s.harga_bertingkat && s.harga_bertingkat.length) card.appendChild(h('div.kv', h('span', 'Harga bertingkat'), h('span', tiersLabel(s.harga_bertingkat))));
    card.appendChild(h('div.kv', h('span', 'Total'), h('span', { style: { fontWeight: 700 } }, F.rupiah(t.total_rupiah))));
    card.appendChild(h('div.kv', h('span', 'Status bayar'), h('span', h('span.badge.' + (t.status_bayar === 'lunas' ? 'st-siap' : 'st-segera'), t.status_bayar === 'lunas' ? 'Lunas' : 'Belum bayar'))));
    if (can('tagihan.kelola') && t.jumlah_foto > 0) {
      var met = h('select.select', { 'aria-label': 'Metode bayar', style: { width: 'auto' } }, ['Tunai', 'Transfer', 'QRIS', 'Lainnya'].map(function (m) { return h('option', { selected: t.metode === m }, m); }));
      card.appendChild(h('div.row', { style: { marginTop: '12px' } }, met,
        t.status_bayar === 'lunas'
          ? h('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: function () { setBayar('belum_bayar'); } }, 'Tandai belum bayar')
          : h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: function () { setBayar('lunas'); } }, 'Tandai lunas')));
      if (t.status_bayar !== 'lunas' && ME.integrasi.payment && fitur('bayar_online')) {
        card.appendChild(h('div.row', { style: { marginTop: '10px' } }, h('button.btn.btn-amber.btn-sm', { type: 'button', onclick: function () {
          api('POST', '/api/sesis/' + s.id + '/bayar-link').then(function (r) {
            UI.modal({ title: 'Link pembayaran online', body: h('div.stack', { style: { gap: '10px' } }, h('p.muted', 'QRIS / virtual account / e-wallet. Status otomatis jadi Lunas setelah dibayar.'), h('div.codebox', r.url)),
              actions: [{ label: 'Tutup' }, { label: 'Salin link', cls: 'btn-secondary', onClick: function () { UI.copy(r.url, 'Link bayar tersalin'); } }].concat(r.wa_url ? [{ label: 'Kirim via WhatsApp', cls: 'btn-amber', onClick: function (c) { window.open(r.wa_url, '_blank'); c(); } }] : []) });
          }).catch(err);
        } }, ic('kartu'), 'Link bayar online')));
      }
      if (t.dibayar_pada) card.appendChild(h('p.small.muted', 'Dibayar ' + UI.fmtDateTime(t.dibayar_pada, tz()) + (t.metode ? ' · ' + t.metode : '')));
      function setBayar(v) { api('PUT', '/api/sesis/' + s.id + '/tagihan', { status_bayar: v, metode: met.value }).then(function () { UI.toast('Status bayar disimpan'); route(); }).catch(err); }
    }
    return card;
  }
  function editorCard(s) {
    var card = h('section.card', h('h2.title', 'Editor'));
    var stSel = h('select.select', { 'aria-label': 'Status editor' }, [['antre', 'Antre'], ['dikerjakan', 'Dikerjakan'], ['selesai', 'Selesai']].map(function (o) { return h('option', { value: o[0], selected: s.editor_status === o[0] }, o[1]); }));
    var edSel = can('sesi.kelola') ? h('select.select', { 'aria-label': 'Ditugaskan ke' }, h('option', { value: '' }, 'Belum ditugaskan'), s.editors.map(function (e) { return h('option', { value: e.id, selected: s.editor_id === e.id }, e.nama + ' (' + e.peran + ')'); })) : null;
    card.appendChild(h('div.grid-2', edSel ? h('label.field', h('span', 'Ditugaskan ke'), edSel) : null, h('label.field', h('span', 'Status pengerjaan'), stSel)));
    card.appendChild(h('div.row', { style: { marginTop: '12px' } }, h('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: function () {
      var b = { editor_status: stSel.value }; if (edSel) b.editor_id = edSel.value || null;
      api('PUT', '/api/sesis/' + s.id + '/editor', b).then(function () { UI.toast('Disimpan'); route(); refreshMe(); }).catch(err);
    } }, 'Simpan')));
    return card;
  }
  function settingsCard(s) {
    var f = {};
    function num(k, label, hint) { f[k] = h('input.input', { type: 'number', min: 0, value: s[k] }); return h('label.field', h('span', label), f[k], hint ? h('span.hint', hint) : null); }
    f.judul = h('input.input', { value: s.judul, maxlength: 120 });
    f.pelanggan_nama = h('input.input', { value: s.pelanggan_nama, maxlength: 80 });
    f.pelanggan_wa = h('input.input', { value: s.pelanggan_wa || '', inputmode: 'tel' });
    var tn = h('input', { type: 'checkbox', checked: s.tampil_nama_file }), tc = h('input', { type: 'checkbox', checked: s.izin_catatan });
    var det = h('details', h('summary', { style: { cursor: 'pointer', fontWeight: 700, fontSize: '18px' } }, 'Ubah pengaturan sesi'),
      h('div.stack', { style: { gap: '14px', marginTop: '16px' } },
        h('div.grid-2', h('label.field', h('span', 'Judul'), f.judul), h('label.field', h('span', 'Nama pelanggan'), f.pelanggan_nama), h('label.field', h('span', 'WhatsApp pelanggan'), f.pelanggan_wa),
          num('kuota', 'Kuota'), num('durasi_pilih_menit', 'Durasi pilih (menit)', '0 = tenggat saja'), num('harga_foto_tambahan', 'Harga foto tambahan'), num('maks_foto_tambahan', 'Batas foto tambahan'),
          h('label.field', h('span', 'Harga bertingkat'), f.harga_bertingkat = h('input.input', { value: tiersText(s.harga_bertingkat), placeholder: '5=100000, 10=180000' }))),
        h('div', h('div.toggle-row', h('b', 'Tampilkan nama file ke pelanggan'), h('label.switch', tn, h('span'))), h('div.toggle-row', h('b', 'Izinkan catatan per foto'), h('label.switch', tc, h('span')))),
        h('div.row', { style: { justifyContent: 'space-between' } },
          can('sesi.hapus') ? h('button.btn.btn-danger.btn-sm', { type: 'button', onclick: hapus }, 'Hapus galeri & data pelanggan') : h('span'),
          h('button.btn.btn-primary', { type: 'button', onclick: simpan }, 'Simpan'))));
    function simpan() {
      var b = { tampil_nama_file: tn.checked, izin_catatan: tc.checked };
      Object.keys(f).forEach(function (k) { b[k] = f[k].value; });
      api('PUT', '/api/sesis/' + s.id, b).then(function () { UI.toast('Pengaturan sesi disimpan'); route(); }).catch(err);
    }
    function hapus() {
      UI.confirm('Hapus galeri ini?', 'Semua pilihan, catatan, log, dan pratinjau terhapus permanen. File asli di Google Drive tidak ikut terhapus.', 'Hapus', 'btn-danger').then(function (ok) {
        if (ok) api('DELETE', '/api/sesis/' + s.id).then(function () { UI.toast('Galeri dihapus'); go('#/galeri'); }).catch(err);
      });
    }
    return h('section.card', det);
  }
  function hasilCard(s) {
    var inp = h('input.input', { value: s.hasil_link || '', placeholder: 'https://drive.google.com/… (folder hasil edit)', type: 'url' });
    var card = h('section.card', h('h2.title', 'Hasil akhir'),
      h('p.small.muted', { style: { marginTop: '-8px' } }, s.hasil_dikirim_pada ? 'Dikirim ke pelanggan ' + UI.rel(s.hasil_dikirim_pada) + '. Link juga tampil di galeri pelanggan.' : 'Link tampil di galeri pelanggan setelah disimpan, dan bisa dikirim lewat WhatsApp.'),
      h('div.row', { style: { flexWrap: 'nowrap' } }, inp, h('button.btn.btn-secondary', { type: 'button', onclick: function () {
        api('PUT', '/api/sesis/' + s.id + '/hasil', { hasil_link: inp.value.trim() }).then(function () { UI.toast('Link hasil disimpan'); route(); }).catch(err);
      } }, 'Simpan')));
    if (s.hasil_link) {
      card.appendChild(h('div.row', { style: { marginTop: '12px' } },
        h('button.btn.btn-amber.btn-sm', { type: 'button', onclick: function () {
          var w = window.open('about:blank', '_blank');
          api('POST', '/api/sesis/' + s.id + '/hasil/kirim', { lewat: 'link' }).then(function (r) { if (w) w.location.href = r.wa_url; route(); }).catch(function (e) { if (w) w.close(); err(e); });
        } }, ic('wa'), 'Kirim via WhatsApp'),
        ME.integrasi.wa_api && fitur('wa_api') && s.pelanggan_wa ? h('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: function () {
          api('POST', '/api/sesis/' + s.id + '/hasil/kirim', { lewat: 'api' }).then(function () { UI.toast('Hasil terkirim via WhatsApp API'); route(); }).catch(err);
        } }, 'Kirim otomatis (API)') : null));
    }
    return card;
  }
  function terpilihCard(s, reload) {
    var st = s.terpilih_status;
    return h('section.card', h('h2.title', 'Folder "Terpilih" di Drive'),
      h('p.small.muted', { style: { marginTop: '-8px' } }, 'Salin file pilihan ke subfolder "Terpilih" di folder sesi. Email layanan harus menjadi Editor folder.'),
      st ? h('p.small', h('b', { style: { color: st === 'gagal' ? 'var(--scarlet)' : 'inherit' } }, { berjalan: 'Menyalin… ', selesai: 'Selesai: ', gagal: 'Gagal: ' }[st] || ''), s.terpilih_info || '') : null,
      h('button.btn.btn-secondary.btn-sm', { type: 'button', disabled: st === 'berjalan' || !s.jumlah_pilihan, onclick: function () {
        api('POST', '/api/sesis/' + s.id + '/terpilih', {}).then(function () { UI.toast('Penyalinan dimulai'); reload(); }).catch(err);
      } }, ic('drive'), st === 'selesai' ? 'Salin ulang' : 'Salin ke folder Terpilih'));
  }
  function showQr(s) {
    var img = h('img', { src: '/api/sesis/' + s.id + '/qr.svg', alt: 'QR galeri', style: { width: '260px', height: '260px', margin: '0 auto' } });
    UI.modal({ title: 'QR galeri ' + s.judul, body: h('div.stack', { style: { gap: '12px', textAlign: 'center' } }, img, h('p.small.muted', 'Pindai di studio untuk membuka galeri. Pelanggan tetap memasukkan PIN ', h('b.mono', s.pin || ''), '.')),
      actions: [{ label: 'Tutup' }, { label: 'Unduh SVG', cls: 'btn-secondary', onClick: function () { location.href = '/api/sesis/' + s.id + '/qr.svg?unduh=1'; } },
        { label: 'Cetak', cls: 'btn-primary', onClick: function () {
          var w = window.open('', '_blank'); if (!w) return;
          w.document.write('<title>QR ' + s.judul.replace(/</g, '') + '</title><body style="font-family:sans-serif;text-align:center;padding:40px"><h1>' + s.judul.replace(/</g, '&lt;') + '</h1><img src="/api/sesis/' + s.id + '/qr.svg" style="width:320px"><p>PIN: <b>' + (s.pin || '') + '</b></p><script>setTimeout(function(){print()},400)<\/script></body>');
          w.document.close();
        } }] });
  }
  function openKiosk(id) {
    api('POST', '/api/sesis/' + id + '/kiosk').then(function (r) { location.href = r.url; }).catch(err);
  }

  function lightbox(s, x) {
    var list = s.fotos.filter(function (f) { return !f.dihapus || f.dipilih; });
    var idx = list.indexOf(x);
    var lb = h('div.lightbox', { role: 'dialog', 'aria-modal': 'true' });
    function draw() {
      var f = list[idx];
      lb.innerHTML = '';
      lb.appendChild(h('div.bar', h('div.row', h('span.lb-no' + (f.dipilih ? '.sel' : ''), { style: { font: '700 18px var(--f-mono)', background: f.dipilih ? 'var(--amber)' : '#fff', color: 'var(--abyss)', padding: '4px 10px', borderRadius: '8px' } }, F.pad(f.nomor, s.nomor_total)),
        h('span.mono', (f.path_subfolder ? f.path_subfolder + '/' : '') + f.nama_file), f.catatan ? h('span.badge.st-segera', '“' + f.catatan + '”') : null),
        h('div.row', h('button.icon-btn', { type: 'button', 'aria-label': 'Salin nama file', onclick: function () { UI.copy(f.nama_file, 'Nama file tersalin'); } }, ic('salin')),
          h('button.icon-btn', { type: 'button', 'aria-label': 'Sebelumnya', onclick: function () { idx = (idx - 1 + list.length) % list.length; draw(); } }, ic('kiri')),
          h('button.icon-btn', { type: 'button', 'aria-label': 'Berikutnya', onclick: function () { idx = (idx + 1) % list.length; draw(); } }, ic('kanan')),
          h('button.icon-btn', { type: 'button', 'aria-label': 'Tutup', onclick: close }, ic('x')))));
      lb.appendChild(h('div.stagebox', h('img', { src: f.preview, alt: 'Foto ' + f.nomor })));
    }
    function key(e) { if (e.key === 'Escape') close(); if (e.key === 'ArrowLeft') { idx = (idx - 1 + list.length) % list.length; draw(); } if (e.key === 'ArrowRight') { idx = (idx + 1) % list.length; draw(); } }
    function close() { lb.remove(); document.removeEventListener('keydown', key); }
    document.addEventListener('keydown', key);
    document.body.appendChild(lb); draw();
  }

  // ---------- S5: Pilihan masuk ----------
  function pagePilihan(selId) {
    main.appendChild(head('Pilihan masuk', 'Daftar file untuk editor'));
    var box = h('div'); main.appendChild(box); box.appendChild(h('div.card.skeleton', { style: { height: '160px' } }));
    api('GET', '/api/sesis?status=masuk').then(function (masuk) {
      return api('GET', '/api/sesis?status=selesai&limit=12').then(function (sel) { return masuk.concat(sel); });
    }).then(function (rows) {
      box.innerHTML = '';
      if (!rows.length) { box.appendChild(h('div.card.empty', h('p.title', 'Belum ada pilihan masuk'), h('p', 'Pilihan muncul di sini setelah pelanggan menekan Kirim atau waktunya habis.'))); return; }
      var cur = selId ? rows.filter(function (r) { return r.id === selId; })[0] : rows[0];
      box.appendChild(h('div.inbox', rows.map(function (r) {
        var on = cur && r.id === cur.id;
        return h('a', { href: '#/pilihan/' + r.id, class: on ? 'on' : '' }, h('div.t', h('span', r.judul), r.editor_status === 'antre' && r.status !== 'selesai' ? h('span.badge.st-siap', 'Baru') : r.status === 'selesai' ? h('span.badge.st-selesai', 'Selesai') : h('span.badge.st-waktu_habis', 'Dikerjakan')),
          h('div.small' + (on ? '' : '.muted'), [r.jenis, UI.fmtDate(r.tanggal_sesi ? r.tanggal_sesi + 'T12:00:00Z' : r.dibuat_pada, tz())].filter(Boolean).join(' · ')),
          h('div.small', h('b', r.jumlah_pilihan + ' foto'), ' · ', UI.rel(r.dikirim_pada), r.status === 'waktu_habis' ? ' · otomatis' : ''));
      })));
      if (!cur) return;
      var panel = h('section.card'); box.appendChild(panel);
      api('GET', '/api/sesis/' + cur.id).then(function (s) {
        var picked = s.fotos.filter(function (x) { return x.dipilih; });
        panel.appendChild(h('div.page-head', { style: { marginBottom: '16px' } },
          h('div', h('div.label', [s.jenis, s.tanggal_sesi ? UI.fmtDate(s.tanggal_sesi + 'T12:00:00Z', tz()) : null].filter(Boolean).join(' · ')), h('h2.display-lg', { style: { fontSize: '30px' } }, s.judul + ' · ' + picked.length + ' foto'),
            h('div.small.muted', 'Dikirim ' + UI.rel(s.dikirim_pada) + (s.dikirim_otomatis ? ' (otomatis, waktu habis)' : '') + ' dari galeri ' + s.jumlah_foto + ' foto' + (picked.length < s.kuota ? ' · kurang dari kuota ' + s.kuota : ''))),
          h('div.row', h('a.btn.btn-secondary', { href: '#/galeri/' + s.id }, 'Detail sesi'),
            s.editor_status !== 'selesai' ? h('button.btn.btn-primary', { type: 'button', onclick: function () { api('PUT', '/api/sesis/' + s.id + '/editor', { editor_status: s.editor_status === 'antre' ? 'dikerjakan' : 'selesai' }).then(function () { refreshMe(); route(); }).catch(err); } }, s.editor_status === 'antre' ? 'Mulai kerjakan' : 'Tandai selesai') : null)));
        panel.appendChild(exportBar(s, picked));
        if (s.catatan_umum) panel.appendChild(h('div.alert', { style: { marginBottom: '16px' } }, h('b', 'Catatan umum: '), s.catatan_umum));
        panel.appendChild(h('div.photo-grid', picked.map(function (x) {
          return h('div.tile.sel', h('div.ph', { onclick: function () { lightbox({ fotos: picked, nomor_total: s.nomor_total }, x); } }, h('span.no', F.pad(x.nomor, s.nomor_total)), h('img', { src: x.thumb, alt: '', loading: 'lazy' }), x.is_tambahan ? h('span.extra', 'Tambahan') : null),
            h('div.info', h('span.filename', x.nama_file, x.nama_kembar ? h('span.dup', ' · ' + x.path_subfolder) : null)), x.catatan ? h('div.note-chip', '“' + x.catatan + '”') : null);
        })));
        // F-50 (bonus): kenali nomor/link dari teks chat
        var ta = h('textarea.textarea', { placeholder: 'Tempel teks dari pelanggan (mis. chat WhatsApp) — nomor dan link galeri dikenali otomatis.' });
        var out = h('div');
        panel.appendChild(h('details', { style: { marginTop: '20px' } }, h('summary', { style: { cursor: 'pointer', fontWeight: 700 } }, 'Cocokkan teks tempelan'), h('div.stack', { style: { gap: '10px', marginTop: '12px' } }, ta, out)));
        ta.addEventListener('input', function () {
          var nums = F.parsePasted(ta.value);
          var found = s.fotos.filter(function (x) { return nums.indexOf(x.nomor) >= 0; });
          out.innerHTML = '';
          if (!nums.length) return;
          out.appendChild(h('p.small', found.length + ' file cocok dari ' + nums.length + ' nomor.'));
          out.appendChild(h('div.codebox', F.fileList(found, 'baris', { total: s.nomor_total })));
          out.appendChild(h('button.btn.btn-amber.btn-sm', { type: 'button', style: { marginTop: '8px' }, onclick: function () { UI.copy(F.fileList(found, ME.studio.format_salin, { total: s.nomor_total }), 'Tersalin'); } }, ic('salin'), 'Salin'));
        });
      }).catch(err);
    }).catch(err);
  }

  // ---------- Notifikasi ----------
  function pageNotif() {
    main.appendChild(head('Notifikasi', null, [h('button.btn.btn-secondary', { type: 'button', onclick: function () { api('POST', '/api/notifikasi/baca', {}).then(function () { refreshMe(); route(); }); } }, 'Tandai semua dibaca')]));
    api('GET', '/api/notifikasi').then(function (rows) {
      main.appendChild(h('section.card', rows.length ? h('ul.feed', rows.map(function (a) {
        return h('li', h('i.dot', { style: { background: a.dibaca ? 'var(--line)' : 'var(--amber)' } }), h('div', a.sesi_id ? h('a', { href: '#/galeri/' + a.sesi_id }, a.dibaca ? a.pesan : h('b', a.pesan)) : a.pesan, h('div.small.muted', UI.fmtDateTime(a.dibuat_pada, tz()))));
      })) : h('div.empty', 'Belum ada notifikasi.')));
      if (rows.some(function (r) { return !r.dibaca; })) api('POST', '/api/notifikasi/baca', {}).then(refreshMe);
    }).catch(err);
  }

  // ---------- S6: Paket ----------
  function pagePaket() {
    var edit = can('paket.kelola');
    main.appendChild(head('Paket & harga', 'Nilai default saat membuat sesi', edit ? [h('button.btn.btn-primary', { type: 'button', onclick: function () { form(null); } }, ic('tambah'), 'Paket baru')] : null));
    var box = h('section.card'); main.appendChild(box);
    function load() {
      api('GET', '/api/pakets').then(function (rows) {
        box.innerHTML = '';
        box.appendChild(h('div.table-wrap', h('table.tbl', h('thead', h('tr', h('th', 'Paket'), h('th', 'Kuota'), h('th', 'Durasi pilih'), h('th', 'Masa aktif'), h('th', 'Foto tambahan'), h('th', ''))),
          h('tbody', rows.map(function (p) {
            return h('tr', h('td', h('b', p.nama)), h('td.mono', p.kuota + ' foto'), h('td', p.durasi_pilih_menit ? p.durasi_pilih_menit + ' menit' : 'Tenggat saja'), h('td', p.masa_aktif_jam >= 24 ? p.masa_aktif_jam / 24 + ' hari' : p.masa_aktif_jam + ' jam'),
              h('td', p.maks_foto_tambahan ? [F.rupiah(p.harga_foto_tambahan) + ' · maks ' + p.maks_foto_tambahan, p.harga_bertingkat && p.harga_bertingkat.length ? h('div.small.muted', tiersLabel(p.harga_bertingkat)) : null] : 'Tidak'),
              h('td', edit ? h('div.row', { style: { justifyContent: 'flex-end' } }, h('button.btn.btn-sm.btn-secondary', { type: 'button', onclick: function () { form(p); } }, 'Ubah'),
                h('button.btn.btn-sm.btn-text', { type: 'button', onclick: function () { UI.confirm('Arsipkan paket ' + p.nama + '?', 'Sesi lama tidak berubah karena menyimpan salinan nilai paket.', 'Arsipkan').then(function (ok) { if (ok) api('DELETE', '/api/pakets/' + p.id).then(load).catch(err); }); } }, 'Arsipkan')) : null));
          })))));
      }).catch(err);
    }
    function form(p) {
      p = p || { nama: '', kuota: 10, durasi_pilih_menit: 0, masa_aktif_jam: 168, harga_foto_tambahan: 0, maks_foto_tambahan: 0, harga_bertingkat: [] };
      p = Object.assign({}, p, { harga_bertingkat: tiersText(p.harga_bertingkat) });
      var f = {};
      function fld(k, label, attrs, hint) { f[k] = h('input.input', Object.assign({ value: p[k] }, attrs || { type: 'number', min: 0 })); return h('label.field', h('span', label), f[k], hint ? h('span.hint', hint) : null); }
      UI.modal({ title: p.id ? 'Ubah paket' : 'Paket baru', body: h('div.stack', { style: { gap: '12px' } },
        fld('nama', 'Nama paket', { maxlength: 80 }), h('div.grid-2', fld('kuota', 'Kuota foto', { type: 'number', min: 1 }), fld('durasi_pilih_menit', 'Durasi pilih (menit)', null, '0 = tenggat saja'),
          fld('masa_aktif_jam', 'Masa aktif link (jam)', { type: 'number', min: 1 }), fld('harga_foto_tambahan', 'Harga per foto tambahan (Rp)'), fld('maks_foto_tambahan', 'Batas foto tambahan', null, '0 = tidak boleh lebih')),
        fld('harga_bertingkat', 'Harga bertingkat (opsional)', { placeholder: '5=100000, 10=180000' }, 'Paket foto tambahan lebih murah, format jumlah=harga.')),
      actions: [{ label: 'Batal' }, { label: 'Simpan', cls: 'btn-primary', onClick: function (c) {
        var b = {}; Object.keys(f).forEach(function (k) { b[k] = f[k].value; });
        api(p.id ? 'PUT' : 'POST', '/api/pakets' + (p.id ? '/' + p.id : ''), b).then(function () { c(); UI.toast('Paket disimpan'); load(); }).catch(err);
      } }] });
    }
    load();
  }

  // ---------- S7: Tim ----------
  function pageTim() {
    var kelola = can('tim.kelola');
    main.appendChild(head('Tim & peran', ME.studio.nama));
    var box = h('div.stack'); main.appendChild(box);
    function load() {
      api('GET', '/api/tim').then(function (d) {
        box.innerHTML = '';
        if (kelola) {
          var em = h('input.input', { type: 'email', placeholder: 'email@studio.id', 'aria-label': 'Email anggota' });
          var pr = h('select.select', { 'aria-label': 'Peran', style: { width: 'auto' } }, h('option', { value: 'admin' }, 'Admin / kasir'), h('option', { value: 'editor' }, 'Editor'));
          box.appendChild(h('section.card', h('h2.title', 'Undang anggota'), h('div.row', { style: { flexWrap: 'nowrap' } }, em, pr, h('button.btn.btn-primary', { type: 'button', onclick: function () {
            api('POST', '/api/tim/undang', { email: em.value, peran: pr.value }).then(function (r) {
              UI.modal({ title: 'Link undangan', body: h('div.stack', { style: { gap: '10px' } }, h('p.muted', 'Kirim link ini ke ' + em.value + '. Berlaku 7 hari.'), h('div.codebox', r.link)),
                actions: [{ label: 'Tutup' }, { label: 'Salin link', cls: 'btn-amber', onClick: function (c) { UI.copy(r.link, 'Link undangan tersalin'); c(); } }] });
              load();
            }).catch(err);
          } }, 'Buat undangan')),
          h('p.small.muted', 'Admin: buat sesi, kirim link, perpanjang waktu, catat pembayaran. Editor: lihat pilihan masuk, salin nama file, tandai selesai.')));
        }
        var hasCab = ME.cabangs.length > 0;
        box.appendChild(h('section.card', h('h2.title', 'Anggota'), h('div.table-wrap', h('table.tbl', h('thead', h('tr', h('th', 'Nama'), h('th', 'Email'), h('th', 'Peran'), hasCab ? h('th', 'Cabang') : null, h('th', 'Status'), h('th', ''))),
          h('tbody', d.users.map(function (u) {
            var pr = kelola && u.peran !== 'owner' ? h('select.select', { style: { width: 'auto', minHeight: '36px' }, onchange: function (e) { api('PUT', '/api/tim/' + u.id, { peran: e.target.value }).then(function () { UI.toast('Peran diubah'); }).catch(err); } },
              h('option', { value: 'admin', selected: u.peran === 'admin' }, 'Admin'), h('option', { value: 'editor', selected: u.peran === 'editor' }, 'Editor')) : u.peran;
            var cb = hasCab ? (kelola && u.peran !== 'owner' ? cabangSelect(u.cabang_id, 'Semua cabang', { style: { width: 'auto', minHeight: '36px' }, onchange: function (e) { api('PUT', '/api/tim/' + u.id, { cabang_id: e.target.value || null }).then(function () { UI.toast('Cabang diubah'); }).catch(err); } })
              : ((ME.cabangs.filter(function (c) { return c.id === u.cabang_id; })[0] || {}).nama || 'Semua')) : null;
            return h('tr', h('td', h('b', u.nama)), h('td', u.email), h('td', pr), hasCab ? h('td', cb) : null, h('td', u.aktif ? 'Aktif' : 'Nonaktif'),
              h('td', kelola && u.peran !== 'owner' ? h('button.btn.btn-sm.btn-text', { type: 'button', onclick: function () { api('PUT', '/api/tim/' + u.id, { aktif: !u.aktif }).then(load).catch(err); } }, u.aktif ? 'Nonaktifkan' : 'Aktifkan') : null));
          }))))));
        if (d.invites.length) {
          box.appendChild(h('section.card', h('h2.title', 'Undangan tertunda'), h('ul.feed', d.invites.map(function (i) {
            return h('li', h('div', h('b', i.email), ' · ' + i.peran + ' · berlaku sampai ' + UI.fmtDate(i.kedaluwarsa, tz())), h('button.btn.btn-sm.btn-text', { type: 'button', onclick: function () { api('DELETE', '/api/tim/undang/' + i.id).then(load).catch(err); } }, 'Batalkan'));
          }))));
        }
      }).catch(err);
    }
    load();
  }

  // ---------- S8: Pengaturan studio ----------
  function pagePengaturan() {
    var st = ME.studio, f = {};
    main.appendChild(head('Pengaturan', ME.studio.nama));
    function inp(k, attrs) { f[k] = h('input.input', Object.assign({ value: st[k] == null ? '' : st[k] }, attrs || {})); return f[k]; }
    var logoPrev = h('div.logo-mark', { style: { width: '72px', height: '72px', borderRadius: '18px', fontSize: '18px' } }, st.logo_url ? h('img', { src: st.logo_url, alt: 'Logo' }) : UI.initials(st.nama));
    var file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml', hidden: true, onchange: function () {
      var fl = file.files[0]; if (!fl) return;
      var rd = new FileReader();
      rd.onload = function () { api('POST', '/api/studio/logo', { data_url: rd.result }).then(function () { UI.toast('Logo diperbarui'); return refreshMe(); }).then(function () { route(); }).catch(err); };
      rd.readAsDataURL(fl);
    } });
    f.zona_waktu = h('select.select', [['Asia/Jakarta', 'WIB (Asia/Jakarta)'], ['Asia/Makassar', 'WITA (Asia/Makassar)'], ['Asia/Jayapura', 'WIT (Asia/Jayapura)']].map(function (o) { return h('option', { value: o[0], selected: st.zona_waktu === o[0] }, o[1]); }));
    f.format_salin = h('select.select', Object.keys(F.FORMATS).map(function (k) { return h('option', { value: k, selected: st.format_salin === k }, F.FORMATS[k].label + ' — ' + F.FORMATS[k].hint); }));
    f.template_wa = h('textarea.textarea', { rows: 7, placeholder: 'Kosongkan untuk template default' }); f.template_wa.value = st.template_wa || '';
    f.warna = h('input', { type: 'color', value: st.warna || '#005F73', 'aria-label': 'Warna studio', style: { width: '56px', height: '44px', border: 0, background: 'none' } });
    main.appendChild(h('div.stack',
      h('section.card', h('h2.title', 'Profil studio'),
        h('div.row', { style: { marginBottom: '16px' } }, logoPrev, h('div', h('b', 'Logo studio'), h('p.small.muted', { style: { margin: '2px 0 8px' } }, 'PNG/JPG/SVG, minimal 400×400 px. Tampil di galeri pelanggan.'), h('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: function () { file.click(); } }, 'Unggah logo')), file),
        h('div.grid-2',
          h('label.field', h('span', 'Nama studio'), inp('nama', { maxlength: 80 })),
          h('label.field', h('span', 'WhatsApp studio'), inp('no_wa', { inputmode: 'tel', placeholder: '62812…' }), h('span.hint', 'Tujuan tombol "Kirim pilihan" & bantuan di galeri.')),
          h('label.field', h('span', 'Zona waktu'), f.zona_waktu),
          h('label.field', h('span', 'Warna studio'), f.warna))),
      h('section.card', h('h2.title', 'Galeri pelanggan'), h('div.grid-2',
        h('label.field', h('span', 'Teks watermark'), inp('watermark', { maxlength: 60, placeholder: st.nama }), h('span.hint', 'Berlaku untuk pratinjau yang dibuat setelah ini.')),
        h('label.field', h('span', 'Retensi pratinjau (hari)'), inp('retensi_hari', { type: 'number', min: 1, max: 365 }), h('span.hint', 'Pratinjau dihapus otomatis setelah sesi selesai. Default 30.')),
        h('label.field', h('span', 'Format salin default untuk editor'), f.format_salin))),
      h('section.card', h('h2.title', 'Template pesan WhatsApp'),
        h('p.small.muted', 'Variabel: {nama} {judul} {studio} {link} {pin} {kuota} {durasi} {tambahan} {tenggat} {zona}'), f.template_wa),
      waSection(f),
      cabangSection(),
      h('div.row', { style: { justifyContent: 'flex-end' } }, h('button.btn.btn-primary', { type: 'button', onclick: function () {
        var b = {}; Object.keys(f).forEach(function (k) { b[k] = f[k].type === 'checkbox' ? f[k].checked : f[k].value; });
        if (!b.wa_token) delete b.wa_token;
        api('PUT', '/api/studio', b).then(function () { UI.toast('Pengaturan disimpan'); return refreshMe(); }).catch(err);
      } }, 'Simpan perubahan'))));
  }

  // ---------- Profil ----------
  function pageProfil() {
    main.appendChild(head(ME.user.nama, ME.user.peran + ' · ' + ME.studio.nama));
    var nama = h('input.input', { value: ME.user.nama, maxlength: 80 });
    var pl = h('input.input', { type: 'password', autocomplete: 'current-password' }), pb = h('input.input', { type: 'password', autocomplete: 'new-password', minlength: 8 });
    var dev = h('ul.feed');
    main.appendChild(h('div.two-col',
      h('section.card', h('h2.title', 'Data diri'), h('div.stack', { style: { gap: '14px' } },
        h('label.field', h('span', 'Nama lengkap'), nama), h('label.field', h('span', 'Email'), h('input.input', { value: ME.user.email, disabled: true })),
        h('label.field', h('span', 'Kata sandi lama'), pl), h('label.field', h('span', 'Kata sandi baru'), pb, h('span.hint', 'Minimal 8 karakter. Kosongkan jika tidak diganti.')),
        h('div', h('button.btn.btn-primary', { type: 'button', onclick: function () {
          api('PUT', '/api/me', { nama: nama.value, password_lama: pl.value || undefined, password_baru: pb.value || undefined }).then(function () { UI.toast('Profil disimpan'); pl.value = pb.value = ''; refreshMe(); }).catch(err);
        } }, 'Simpan profil')))),
      h('section.card', h('h2.title', 'Perangkat yang sedang masuk'), dev)));
    function loadDev() {
      api('GET', '/api/me/devices').then(function (rows) {
        dev.innerHTML = '';
        rows.forEach(function (d) {
          dev.appendChild(h('li', h('div', { style: { flex: 1, minWidth: 0 } }, h('b', shortUA(d.user_agent)), h('div.small.muted', d.ini ? 'Perangkat ini' : 'Masuk ' + UI.rel(d.dibuat_pada))),
            d.ini ? h('span.badge.st-siap', 'Aktif') : h('button.btn.btn-sm.btn-text', { type: 'button', onclick: function () { api('DELETE', '/api/me/devices/' + d.id).then(loadDev).catch(err); } }, 'Keluarkan')));
        });
      }).catch(err);
    }
    loadDev();
  }
  function shortUA(ua) {
    ua = ua || '';
    var b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : 'Browser';
    var o = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    return b + (o ? ' · ' + o : '');
  }

  // ---------- S10: Mode kiosk (F-45) ----------
  function pageKiosk() {
    main.appendChild(head('Mode kiosk', 'Sesi hari ini · buka tanpa PIN, timer mulai otomatis', [h('a.btn.btn-secondary', { href: '#/galeri/baru' }, ic('tambah'), 'Sesi baru')]));
    if (!fitur('kiosk')) { main.appendChild(h('div.alert', 'Mode kiosk tersedia di paket Pro. ', h('a', { href: '#/langganan' }, 'Lihat paket'))); return; }
    var box = h('div'); main.appendChild(box);
    function load() {
      api('GET', '/api/sesis?hari_ini=1&urut=nama').then(function (rows) {
        box.innerHTML = '';
        if (!rows.length) { box.appendChild(h('div.card.empty', h('p.title', 'Belum ada sesi hari ini'), h('p', 'Sesi berstatus Siap/Dibuka/Memilih yang dibuat hari ini atau bertanggal hari ini muncul di sini.'))); return; }
        box.appendChild(h('div.cards', rows.map(function (s) {
          return h('button.g-card', { type: 'button', style: { textAlign: 'left', cursor: 'pointer', font: 'inherit' }, onclick: function () { openKiosk(s.id); } },
            h('div.img', { style: { background: s.cover ? null : 'linear-gradient(' + TONE[s.id % TONE.length] + ' 55%, var(--deep-teal) 55%)' } }, s.cover ? h('img', { src: s.cover, alt: '' }) : null, UI.statusBadge(s.status)),
            h('div.body', h('b', { style: { fontSize: '22px' } }, s.judul), h('span.small.muted', [s.cabang_nama, s.jenis, 'pilih ' + s.kuota, s.durasi_pilih_menit ? s.durasi_pilih_menit + ' menit' : 'tenggat saja'].filter(Boolean).join(' · ')),
              h('span.btn.btn-primary.btn-sm', { style: { marginTop: '8px', alignSelf: 'flex-start' } }, ic('kiosk'), s.status === 'memilih' ? 'Lanjutkan' : 'Mulai di kiosk')));
        })));
      }).catch(err);
    }
    load();
    pollT = setInterval(load, 20000);
  }

  // ---------- S9: Laporan (F-44) ----------
  function pageLaporan() {
    main.appendChild(head('Laporan', ME.studio.nama));
    if (!fitur('laporan')) { main.appendChild(h('div.alert', 'Laporan tersedia di paket Pro. ', h('a', { href: '#/langganan' }, 'Lihat paket'))); return; }
    var today = new Date(), d30 = new Date(Date.now() - 29 * 86400000);
    var iso = function (d) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
    var dari = h('input.input', { type: 'date', value: iso(d30), 'aria-label': 'Dari' }), sampai = h('input.input', { type: 'date', value: iso(today), 'aria-label': 'Sampai' });
    var cab = ME.cabang_id ? null : cabangSelect('', 'Semua cabang');
    var box = h('div.stack');
    var csv = h('a.btn.btn-secondary', { href: '#' }, ic('unduh'), 'CSV');
    main.appendChild(h('div.filters', h('div.row', dari, sampai, cab, h('button.btn.btn-primary', { type: 'button', onclick: load }, 'Terapkan')), csv));
    main.appendChild(box);
    function load() {
      var q = 'dari=' + dari.value + '&sampai=' + sampai.value + (cab && cab.value ? '&cabang=' + cab.value : '');
      csv.href = '/api/laporan.csv?' + q;
      box.innerHTML = ''; box.appendChild(h('div.card.skeleton', { style: { height: '160px' } }));
      api('GET', '/api/laporan?' + q).then(function (d) {
        box.innerHTML = '';
        var t = d.total, pct = function (a, b) { return b ? Math.round(a / b * 100) + '%' : '–'; };
        var dur = function (x) { return x == null ? '–' : x < 60 ? '< 1 mnt' : x < 3600 ? Math.round(x / 60) + ' mnt' : (x / 3600).toFixed(1).replace('.', ',') + ' jam'; };
        box.appendChild(h('div.stats',
          h('div.stat', h('span.label', 'Sesi'), h('div.v', String(t.sesi)), h('div.small.muted', t.terkirim + ' terkirim · ' + t.kedaluwarsa + ' kedaluwarsa')),
          h('div.stat', h('span.label', 'Waktu sampai pilihan masuk'), h('div.v', dur(t.median_detik)), h('div.small.muted', 'Median · lama memilih ' + dur(t.median_pilih_detik))),
          h('div.stat', h('span.label', 'Tepat waktu'), h('div.v', pct(t.tepat_waktu, t.terkirim)), h('div.small.muted', 'Minta perpanjangan ' + pct(t.minta_waktu, t.sesi))),
          h('div.stat', h('span.label', 'Pendapatan foto tambahan'), h('div.v', { style: { fontSize: '26px' } }, F.rupiah(Number(t.pendapatan_lunas))), h('div.small.muted', F.rupiah(Number(t.pendapatan_belum)) + ' belum lunas · attach ' + pct(t.dengan_tambahan, t.terkirim)))));
        var max = Math.max.apply(null, d.per_hari.map(function (x) { return x.sesi; }).concat([1]));
        box.appendChild(h('section.card', h('h2.title', 'Sesi per hari'), d.per_hari.length ? h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '4px', height: '160px', overflowX: 'auto', paddingTop: '8px' } },
          d.per_hari.map(function (x) {
            return h('div', { title: x.hari + ': ' + x.sesi + ' sesi · ' + F.rupiah(Number(x.tambahan)), style: { flex: '1 0 14px', maxWidth: '56px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', height: '100%' } },
              h('span.small.mono', { style: { fontSize: '10px' } }, String(x.sesi)), h('i', { style: { display: 'block', width: '100%', height: Math.max(4, x.sesi / max * 120) + 'px', background: 'var(--teal)', borderRadius: '6px 6px 0 0' } }));
          })) : h('p.muted', 'Belum ada data.')));
        var tbl = function (rows, k, label) {
          return h('div.table-wrap', h('table.tbl', h('thead', h('tr', h('th', label), h('th', 'Sesi'), h('th', 'Terkirim'), h('th', 'Tepat waktu'), h('th', 'Foto tambahan'), h('th', 'Lunas'), h('th', 'Belum'))),
            h('tbody', rows.map(function (x) { return h('tr', h('td', h('b', x[k])), h('td.mono', String(x.sesi)), h('td.mono', String(x.terkirim == null ? '–' : x.terkirim)), h('td', x.terkirim != null ? pct(x.tepat_waktu, x.terkirim) : '–'), h('td.mono', String(x.foto_tambahan == null ? '–' : x.foto_tambahan)), h('td', x.pendapatan_lunas != null ? F.rupiah(Number(x.pendapatan_lunas)) : F.rupiah(Number(x.tambahan))), h('td', x.pendapatan_belum != null ? F.rupiah(Number(x.pendapatan_belum)) : '–')); }))));
        };
        box.appendChild(h('div.two-col', h('section.card', h('h2.title', 'Per cabang'), tbl(d.per_cabang, 'cabang', 'Cabang')),
          h('section.card', h('h2.title', 'Per paket'), h('div.table-wrap', h('table.tbl', h('thead', h('tr', h('th', 'Paket'), h('th', 'Sesi'), h('th', 'Tambahan'))),
            h('tbody', d.per_paket.map(function (x) { return h('tr', h('td', x.paket), h('td.mono', String(x.sesi)), h('td', F.rupiah(Number(x.tambahan)))); })))))));
      }).catch(function (e) { box.innerHTML = ''; err(e); });
    }
    load();
  }

  // ---------- Buat sesi massal dari CSV (F-12) ----------
  function pageMassal() {
    main.appendChild(head('Buat sesi massal', 'Untuk wisuda & event', null, h('div.crumb', h('a', { href: '#/galeri' }, 'Galeri'), ' / CSV massal')));
    if (!fitur('csv_massal')) { main.appendChild(h('div.alert', 'Buat sesi massal tersedia di paket Pro. ', h('a', { href: '#/langganan' }, 'Lihat paket'))); return; }
    var contoh = 'nama,no_wa,link_folder,paket,judul,tanggal,pin\nRina Lestari,081234567890,https://drive.google.com/drive/folders/XXXX,Wisuda,Wisuda Rina,2026-11-08,\nBudi Santoso,081298765432,https://drive.google.com/drive/folders/YYYY,Wisuda,,2026-11-08,4321';
    var ta = h('textarea.textarea', { rows: 9, class: 'textarea mono', style: { fontFamily: 'var(--f-mono)', fontSize: '13px' } }); ta.value = '';
    var file = h('input', { type: 'file', accept: '.csv,text/csv', onchange: function () { var f = file.files[0]; if (!f) return; var rd = new FileReader(); rd.onload = function () { ta.value = rd.result; }; rd.readAsText(f); } });
    var sumber = h('select.select', { style: { width: 'auto' } }, h('option', { value: 'service_account' }, 'Folder dibagikan ke email layanan'), h('option', { value: 'link_publik' }, 'Link publik'), CFG.demoSource ? h('option', { value: 'contoh' }, 'Foto contoh (uji coba, kolom link boleh kosong)') : null);
    var paketSel = h('select.select', { style: { width: 'auto' } }, h('option', { value: '' }, 'Paket default: dari kolom "paket"'));
    api('GET', '/api/pakets').then(function (ps) { ps.forEach(function (p) { paketSel.appendChild(h('option', { value: p.id }, 'Default: ' + p.nama)); }); });
    var cab = ME.cabang_id ? null : cabangSelect('', 'Tanpa cabang', { style: { width: 'auto' } });
    var kirim = h('input', { type: 'checkbox' });
    var out = h('div');
    var btn = h('button.btn.btn-primary', { type: 'button', onclick: function () {
      btn.disabled = true; out.innerHTML = ''; out.appendChild(h('p.muted', 'Membuat sesi…'));
      api('POST', '/api/sesis/massal', { csv: ta.value, kirim_wa: kirim.checked, default: { sumber: sumber.value, paket_id: paketSel.value || null, cabang_id: cab && cab.value ? cab.value : null } }).then(function (r) {
        btn.disabled = false; out.innerHTML = '';
        out.appendChild(h('p', h('b', r.dibuat + ' sesi dibuat'), r.gagal ? ', ' + r.gagal + ' gagal' : ''));
        var ok = r.hasil.filter(function (x) { return x.ok; });
        var allText = ok.map(function (x) { return x.nama + '\t' + (x.no_wa || '') + '\t' + x.link + '\tPIN ' + x.pin; }).join('\n');
        out.appendChild(h('div.row', { style: { marginBottom: '10px' } }, h('button.btn.btn-amber.btn-sm', { type: 'button', onclick: function () { UI.copy(allText, 'Semua link & PIN tersalin'); } }, ic('salin'), 'Salin semua link & PIN')));
        out.appendChild(h('div.table-wrap', h('table.tbl', h('thead', h('tr', h('th', 'Baris'), h('th', 'Nama'), h('th', 'Link'), h('th', 'PIN'), h('th', 'WhatsApp'))),
          h('tbody', r.hasil.map(function (x) {
            if (!x.ok) return h('tr', h('td.mono', String(x.baris)), h('td', x.nama || '–'), h('td', { colspan: 3 }, h('span.err-text', x.error)));
            var msg = 'Halo Kak ' + x.nama + ', foto kamu sudah siap dipilih.\nLink: ' + x.link + '\nPIN: ' + x.pin;
            return h('tr', h('td.mono', String(x.baris)), h('td', h('a', { href: '#/galeri/' + x.id }, x.nama)), h('td.mono.small', x.link), h('td.mono', x.pin),
              h('td', x.wa ? x.wa : x.no_wa ? h('a.btn.btn-sm.btn-secondary', { href: 'https://wa.me/' + x.no_wa + '?text=' + encodeURIComponent(msg), target: '_blank', rel: 'noopener' }, ic('wa'), 'Kirim') : '–'));
          })))));
      }).catch(function (e) { btn.disabled = false; out.innerHTML = ''; err(e); });
    } }, 'Buat semua sesi');
    main.appendChild(h('div.stack',
      h('section.card', h('h2.title', '1 · Siapkan CSV'), h('p.small.muted', 'Kolom: nama, no_wa, link_folder, paket (nama paket), judul, tanggal (YYYY-MM-DD), pin (opsional). Pemisah koma atau titik koma.'),
        h('div.row', h('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: function () {
          var a = h('a', { href: 'data:text/csv;charset=utf-8,' + encodeURIComponent(contoh), download: 'contoh-sesi-massal.csv' }); document.body.appendChild(a); a.click(); a.remove();
        } }, ic('unduh'), 'Unduh contoh CSV'), file),
        h('label.field', { style: { marginTop: '12px' } }, h('span', 'Isi CSV'), ta)),
      h('section.card', h('h2.title', '2 · Pengaturan'), h('div.row', sumber, paketSel, cab),
        ME.integrasi.wa_api && fitur('wa_api') ? h('div.toggle-row', h('div', h('b', 'Kirim link otomatis via WhatsApp API'), h('span.small.muted', 'Untuk baris yang punya no_wa.')), h('label.switch', kirim, h('span'))) : null,
        h('div.row', { style: { marginTop: '12px' } }, btn)),
      h('section.card', h('h2.title', 'Hasil'), out)));
  }

  // ---------- Langganan dibayar dari saldo; top up via QRIS statis (F-46) ----------
  function readImage(file) {
    return new Promise(function (res, rej) { var rd = new FileReader(); rd.onload = function () { res(rd.result); }; rd.onerror = rej; rd.readAsDataURL(file); });
  }
  function pageLangganan() {
    main.appendChild(head('Langganan & saldo', ME.studio.nama));
    var box = h('div.stack'); main.appendChild(box);
    function load() {
      api('GET', '/api/langganan').then(function (d) {
        box.innerHTML = '';
        var owner = can('studio.edit');
        var sisa = d.batas_sesi == null ? 'Tanpa batas' : Math.max(0, d.batas_sesi - d.pemakaian.sesi_bulan_ini) + ' dari ' + d.batas_sesi;
        box.appendChild(h('div.stats',
          h('div.stat', h('span.label', 'Saldo'), h('div.v', { style: { fontSize: '28px' } }, F.rupiah(d.saldo)), h('div.small.muted', 'Untuk membayar paket bulanan')),
          h('div.stat', h('span.label', 'Paket aktif'), h('div.v', d.nama), h('div.small.muted', d.plan_sampai ? 'Sampai ' + UI.fmtDate(d.plan_sampai, tz()) : d.plan === 'gratis' ? 'Gratis selamanya' : '')),
          h('div.stat', h('span.label', 'Sisa sesi bulan ini'), h('div.v', { style: { fontSize: '26px' } }, sisa), h('div.small.muted', d.pemakaian.sesi_bulan_ini + ' sesi dibuat bulan ini')),
          h('div.stat', h('span.label', 'Pengguna'), h('div.v', d.pemakaian.pengguna + (d.batas_pengguna ? '/' + d.batas_pengguna : '')), h('div.small.muted', 'Anggota tim aktif'))));
        if (owner) {
          var oto = h('input', { type: 'checkbox', checked: d.perpanjang_otomatis, onchange: function (e) { api('PUT', '/api/langganan/otomatis', { aktif: e.target.checked }).then(function () { UI.toast('Disimpan'); }).catch(err); } });
          box.appendChild(h('section.card', h('div.toggle-row', { style: { borderTop: 0, padding: 0 } }, h('div', h('b', 'Perpanjang otomatis dari saldo'), h('span.small.muted', 'Paket diperpanjang 1 bulan menjelang habis bila saldo cukup.')), h('label.switch', oto, h('span')))));
        }
        var bayar = function (plan, bulan, harga, nama) {
          UI.confirm('Bayar paket ' + nama + '?', F.rupiah(harga) + ' dipotong dari saldo (' + F.rupiah(d.saldo) + ').', 'Bayar dari saldo').then(function (ok) {
            if (ok) api('POST', '/api/langganan/bayar', { plan: plan, bulan: bulan }).then(function () { UI.toast('Paket aktif'); refreshMe(); load(); }).catch(err);
          });
        };
        box.appendChild(h('div.cards', d.katalog.map(function (p) {
          var cur = p.kode === d.plan;
          return h('section.card', { style: cur ? { border: '2px solid var(--amber)' } : null },
            h('div.row', { style: { justifyContent: 'space-between' } }, h('b', { style: { fontSize: '18px' } }, p.nama), cur ? h('span.badge.st-terkirim', 'Aktif') : null),
            h('div', { style: { font: '800 26px var(--f-display)', margin: '8px 0' } }, p.harga == null ? 'Negosiasi' : p.harga ? F.rupiah(p.harga) : 'Rp 0', p.harga ? h('span.small.muted', ' /bulan') : null),
            h('ul.small.muted', { style: { paddingLeft: '18px' } }, h('li', (p.sesi == null ? 'Sesi tanpa batas' : p.sesi + ' sesi/bulan')), h('li', (p.pengguna == null ? 'Pengguna tanpa batas' : p.pengguna + ' pengguna')), p.fitur.map(function (f) { return h('li', f); })),
            p.harga && owner ? h('div.row',
              h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: function () { bayar(p.kode, 1, p.harga, p.nama + ' 1 bulan'); } }, cur ? 'Perpanjang 1 bulan' : '1 bulan'),
              h('button.btn.btn-sm.btn-secondary', { type: 'button', onclick: function () { bayar(p.kode, 12, p.harga * 10, p.nama + ' 12 bulan'); } }, '12 bulan (hemat 2)')) : null,
            p.harga == null ? h('p.small.muted', 'Multi-cabang, SLA, onboarding. Hubungi tim kami.') : null);
        })));
        if (!owner) return;
        // Top up
        var tu = h('section.card', h('h2.title', 'Top up saldo via QRIS'));
        if (!d.qris.ada) tu.appendChild(h('div.alert', 'QRIS belum disiapkan admin platform.'));
        else {
          tu.appendChild(h('p.small.muted', { style: { marginTop: '-8px' } }, 'Pilih nominal, scan QRIS, transfer TEPAT sesuai jumlah (termasuk kode unik), lalu unggah bukti. Saldo masuk setelah dicek admin.'));
          tu.appendChild(h('div.pills', d.nominal.map(function (n) {
            return h('button', { type: 'button', onclick: function () {
              api('POST', '/api/langganan/topup', { nominal: n }).then(function (t) { showTopup(t, d); load(); }).catch(err);
            } }, F.rupiah(n));
          })));
        }
        box.appendChild(tu);
        if (d.topups.length) box.appendChild(h('section.card', h('h2.title', 'Permintaan top up'), h('div.table-wrap', h('table.tbl',
          h('thead', h('tr', h('th', 'No'), h('th', 'Transfer'), h('th', 'Status'), h('th', 'Dibuat'), h('th', ''))),
          h('tbody', d.topups.map(function (t) {
            var stt = { menunggu: ['st-segera', 'Menunggu'], disetujui: ['st-siap', 'Masuk'], ditolak: ['st-kedaluwarsa', 'Ditolak'], batal: ['st-selesai', 'Batal'] }[t.status];
            return h('tr', h('td.mono', 'TU-' + t.id), h('td', h('b.mono', F.rupiah(t.jumlah_transfer))), h('td', h('span.badge.' + stt[0], stt[1]), t.catatan ? h('div.small.muted', t.catatan) : null),
              h('td.small.muted', UI.fmtDateTime(t.dibuat_pada, tz())),
              h('td', t.status === 'menunggu' ? h('div.row', { style: { justifyContent: 'flex-end' } },
                h('button.btn.btn-sm.btn-secondary', { type: 'button', onclick: function () { showTopup(t, d); } }, t.ada_bukti ? 'Ganti bukti' : 'Bayar / unggah bukti'),
                h('button.btn.btn-sm.btn-text', { type: 'button', onclick: function () { api('POST', '/api/langganan/topup/' + t.id + '/batal').then(load).catch(err); } }, 'Batal')) : null));
          }))))));
        if (d.mutasi.length) box.appendChild(h('section.card', h('h2.title', 'Mutasi saldo'), h('div.table-wrap', h('table.tbl',
          h('thead', h('tr', h('th', 'Waktu'), h('th', 'Keterangan'), h('th', 'Jumlah'), h('th', 'Saldo'))),
          h('tbody', d.mutasi.map(function (m) {
            return h('tr', h('td.small.muted', UI.fmtDateTime(m.waktu, tz())), h('td', m.keterangan), h('td.mono', { style: { color: m.jumlah < 0 ? 'var(--scarlet)' : 'var(--deep-teal)', fontWeight: 700 } }, (m.jumlah > 0 ? '+' : '−') + F.rupiah(Math.abs(m.jumlah)).replace('Rp ', 'Rp ')), h('td.mono', F.rupiah(m.saldo_akhir)));
          }))))));
      }).catch(err);
    }
    function showTopup(t, d) {
      var file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
      UI.modal({ title: 'Transfer ' + F.rupiah(t.jumlah_transfer), body: h('div.stack', { style: { gap: '12px', textAlign: 'center' } },
        h('img', { src: '/api/qris', alt: 'QRIS', style: { width: '260px', maxWidth: '100%', margin: '0 auto', borderRadius: '12px', border: '1px solid var(--line)' } }),
        d.qris.nama_penerima ? h('p.small', 'Penerima: ', h('b', d.qris.nama_penerima)) : null,
        h('div.alert', { style: { textAlign: 'left' } }, 'Masukkan jumlah ', h('b.mono', F.rupiah(t.jumlah_transfer)), ' persis (nominal ' + F.rupiah(t.nominal) + ' + kode unik ' + t.kode_unik + '). Berlaku 24 jam.'),
        h('label.field', { style: { textAlign: 'left' } }, h('span', 'Bukti transfer (screenshot)'), file)),
      actions: [{ label: 'Nanti' }, { label: 'Kirim bukti', cls: 'btn-primary', onClick: function (c) {
        if (!file.files[0]) { UI.toast('Pilih gambar bukti dulu', true); return; }
        readImage(file.files[0]).then(function (url) { return api('POST', '/api/langganan/topup/' + t.id + '/bukti', { data_url: url }); })
          .then(function () { c(); UI.toast('Bukti terkirim, menunggu konfirmasi admin'); load(); }).catch(err);
      } }] });
    }
    load();
  }

  // ---------- Super admin ----------
  function pageAdmin() {
    main.appendChild(head('Super admin', 'Platform'));
    var box = h('div.stack'); main.appendChild(box);
    var q = h('input.input.search', { type: 'search', placeholder: 'Cari studio', style: { width: '260px' } });
    function load() {
      Promise.all([api('GET', '/api/admin/ringkasan'), api('GET', '/api/admin/studios' + (q.value ? '?q=' + encodeURIComponent(q.value) : '')), api('GET', '/api/admin/audit')]).then(function (r) {
        var d = r[0], rows = r[1], aud = r[2];
        box.innerHTML = '';
        box.appendChild(h('div.stats',
          h('div.stat', h('span.label', 'Studio'), h('div.v', String(d.studio)), h('div.small.muted', d.studio_aktif + ' aktif')),
          h('div.stat', h('span.label', 'Studio aktif 14 hari'), h('div.v', String(d.studio_aktif_14h))),
          h('div.stat', h('span.label', 'Sesi 30 hari'), h('div.v', String(d.sesi_30h))),
          h('div.stat', h('span.label', 'Top up menunggu'), h('div.v', String(d.topup_menunggu)), h('div.small.muted', F.rupiah(Number(d.topup_30h)) + ' disetujui 30 hari')),
          h('div.stat', h('span.label', 'Pendapatan paket 30 hari'), h('div.v', { style: { fontSize: '24px' } }, F.rupiah(Number(d.pendapatan_30h))))));
        box.appendChild(topupPanel());
        box.appendChild(qrisPanel());
        box.appendChild(h('section.card', h('div.filters', h('h2.title', 'Tenant'), q), h('div.table-wrap', h('table.tbl',
          h('thead', h('tr', h('th', 'Studio'), h('th', 'Owner'), h('th', 'Paket'), h('th', 'Sampai'), h('th', 'Saldo'), h('th', 'Sesi bln ini'), h('th', 'Status'), h('th', ''))),
          h('tbody', rows.map(function (st) {
            return h('tr', h('td', h('b', st.nama), h('div.small.muted', '#' + st.id + ' · ' + st.pengguna + ' pengguna · ' + st.sesi_total + ' sesi')), h('td.small', st.owner_email || '–'),
              h('td', st.plan), h('td.small', st.plan_sampai ? UI.fmtDate(st.plan_sampai) : '–'), h('td.mono', F.rupiah(Number(st.saldo))), h('td.mono', String(st.sesi_bulan_ini)),
              h('td', st.aktif ? h('span.badge.st-siap', 'Aktif') : h('span.badge.st-kedaluwarsa', 'Ditangguhkan')),
              h('td', h('button.btn.btn-sm.btn-secondary', { type: 'button', onclick: function () { editStudio(st); } }, 'Ubah')));
          }))))));
        box.appendChild(h('section.card', h('h2.title', 'Audit'), h('ul.log', aud.map(function (a) {
          return h('li', h('time', UI.fmtDate(a.waktu, tz(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })), h('div', h('b', a.aksi), ' · ' + a.aktor + (a.studio_nama ? ' · ' + a.studio_nama : ''), a.detail ? h('div.small.muted.mono', JSON.stringify(a.detail)) : null));
        }))));
      }).catch(err);
    }
    function editStudio(st) {
      var plan = h('select.select', ['gratis', 'starter', 'pro', 'bisnis'].map(function (p) { return h('option', { value: p, selected: st.plan === p }, p); }));
      var sampai = h('input.input', { type: 'date', value: st.plan_sampai ? String(st.plan_sampai).slice(0, 10) : '' });
      var koreksi = h('input.input', { type: 'number', value: '', placeholder: 'mis. 50000 atau -50000' });
      var ket = h('input.input', { placeholder: 'Alasan koreksi (wajib bila diisi)' });
      var aktif = h('input', { type: 'checkbox', checked: st.aktif });
      UI.modal({ title: st.nama, body: h('div.stack', { style: { gap: '12px' } }, h('label.field', h('span', 'Paket'), plan), h('label.field', h('span', 'Berlaku sampai'), sampai, h('span.hint', 'Kosongkan untuk tanpa batas waktu')),
        h('div.toggle-row', h('b', 'Studio aktif'), h('label.switch', aktif, h('span'))),
        h('label.field', h('span', 'Koreksi saldo (Rp, saldo sekarang ' + F.rupiah(Number(st.saldo)) + ')'), koreksi, ket)),
      actions: [{ label: 'Batal' }, { label: 'Simpan', cls: 'btn-primary', onClick: function (c) {
        api('PUT', '/api/admin/studios/' + st.id, { plan: plan.value, plan_sampai: sampai.value, aktif: aktif.checked }).then(function () {
          if (!koreksi.value) return null;
          return api('POST', '/api/admin/studios/' + st.id + '/koreksi', { jumlah: koreksi.value, keterangan: ket.value });
        }).then(function () { c(); UI.toast('Disimpan'); load(); }).catch(err);
      } }] });
    }
    function topupPanel() {
      var sec = h('section.card', h('h2.title', 'Top up menunggu konfirmasi'), h('p.small.muted', { style: { marginTop: '-8px' } }, 'Cocokkan jumlah transfer (dengan kode unik) di mutasi rekening/QRIS sebelum menyetujui.'));
      var list = h('div'); sec.appendChild(list);
      api('GET', '/api/admin/topups?status=menunggu').then(function (rows) {
        if (!rows.length) { list.appendChild(h('p.muted', 'Tidak ada.')); return; }
        list.appendChild(h('div.table-wrap', h('table.tbl', h('thead', h('tr', h('th', 'No'), h('th', 'Studio'), h('th', 'Jumlah transfer'), h('th', 'Bukti'), h('th', 'Dibuat'), h('th', ''))),
          h('tbody', rows.map(function (t) {
            return h('tr', h('td.mono', 'TU-' + t.id), h('td', t.studio_nama), h('td', h('b.mono', F.rupiah(Number(t.jumlah_transfer)))),
              h('td', t.ada_bukti ? h('a', { href: '/api/langganan/topup/' + t.id + '/bukti', target: '_blank', rel: 'noopener' }, 'Lihat') : h('span.muted', 'Belum')),
              h('td.small.muted', UI.fmtDateTime(t.dibuat_pada, tz())),
              h('td', h('div.row', { style: { justifyContent: 'flex-end' } },
                h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: function () {
                  UI.confirm('Setujui TU-' + t.id + '?', 'Saldo ' + t.studio_nama + ' bertambah ' + F.rupiah(Number(t.jumlah_transfer)) + '. Pastikan dana sudah masuk.', 'Setujui').then(function (ok) {
                    if (ok) api('POST', '/api/admin/topups/' + t.id + '/setujui').then(function () { UI.toast('Saldo ditambahkan'); load(); }).catch(err);
                  });
                } }, 'Setujui'),
                h('button.btn.btn-sm.btn-text', { type: 'button', onclick: function () {
                  var cat = h('input.input', { placeholder: 'Alasan (mis. dana belum masuk)' });
                  UI.modal({ title: 'Tolak TU-' + t.id + '?', body: cat, actions: [{ label: 'Batal' }, { label: 'Tolak', cls: 'btn-danger', onClick: function (c) {
                    api('POST', '/api/admin/topups/' + t.id + '/tolak', { catatan: cat.value }).then(function () { c(); load(); }).catch(err);
                  } }] });
                } }, 'Tolak'))));
          })))));
      }).catch(err);
      return sec;
    }
    function qrisPanel() {
      var nama = h('input.input', { placeholder: 'Nama penerima QRIS' });
      var file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
      return h('section.card', h('h2.title', 'QRIS statis'), h('div.row', { style: { alignItems: 'flex-start' } },
        h('img', { src: '/api/qris?v=' + Date.now(), alt: 'QRIS', style: { width: '120px', borderRadius: '10px', border: '1px solid var(--line)', background: 'var(--s100)' }, onerror: function (e) { e.target.replaceWith(h('div.small.muted', 'Belum ada QRIS.')); } }),
        h('div.stack', { style: { gap: '10px', flex: '1', minWidth: '220px' } }, nama, file, h('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: function () {
          var go2 = file.files[0] ? readImage(file.files[0]) : Promise.resolve(null);
          go2.then(function (url) { var b = {}; if (url) b.data_url = url; if (nama.value) b.nama_penerima = nama.value; return api('PUT', '/api/admin/qris', b); })
            .then(function () { UI.toast('QRIS disimpan'); load(); }).catch(err);
        } }, 'Simpan QRIS'))));
    }
    var t; q.addEventListener('input', function () { clearTimeout(t); t = setTimeout(load, 300); });
    load();
  }

  // ---------- Pengaturan: cabang & WhatsApp ----------
  function cabangSection() {
    var sec = h('section.card', h('h2.title', 'Cabang'));
    if (!fitur('multi_cabang')) { sec.appendChild(h('p.muted', 'Multi-cabang tersedia di paket Bisnis.')); return sec; }
    var list = h('div');
    var nama = h('input.input', { placeholder: 'Nama cabang' }), alamat = h('input.input', { placeholder: 'Alamat (opsional)' }), wa = h('input.input', { placeholder: 'WA cabang (opsional)', inputmode: 'tel' });
    function load() {
      api('GET', '/api/cabangs').then(function (rows) {
        list.innerHTML = '';
        list.appendChild(rows.length ? h('ul.feed', rows.map(function (c) {
          return h('li', h('div', { style: { flex: 1 } }, h('b', c.nama), h('div.small.muted', [c.alamat, c.no_wa ? '+' + c.no_wa : null].filter(Boolean).join(' · '))),
            h('button.btn.btn-sm.btn-text', { type: 'button', onclick: function () { UI.confirm('Arsipkan cabang ' + c.nama + '?', 'Sesi lama tetap tersimpan.', 'Arsipkan').then(function (ok) { if (ok) api('DELETE', '/api/cabangs/' + c.id).then(function () { refreshMe(); load(); }).catch(err); }); } }, 'Arsipkan'));
        })) : h('p.muted', 'Belum ada cabang.'));
      }).catch(err);
    }
    sec.appendChild(list);
    sec.appendChild(h('div.grid-2', { style: { marginTop: '12px' } }, nama, alamat, wa, h('button.btn.btn-secondary', { type: 'button', onclick: function () {
      api('POST', '/api/cabangs', { nama: nama.value, alamat: alamat.value, no_wa: wa.value }).then(function () { nama.value = alamat.value = wa.value = ''; UI.toast('Cabang ditambahkan'); refreshMe(); load(); }).catch(err);
    } }, ic('tambah'), 'Tambah cabang')));
    load();
    return sec;
  }
  function waSection(f) {
    var st = ME.studio;
    f.wa_otomatis = h('input', { type: 'checkbox', checked: st.wa_otomatis });
    f.wa_phone_number_id = h('input.input', { value: st.wa_phone_number_id || '', placeholder: 'Kosongkan untuk memakai nomor platform', inputmode: 'numeric' });
    f.wa_token = h('input.input', { type: 'password', placeholder: st.wa_token_set ? '•••••• (tersimpan, isi untuk mengganti)' : 'Access token WhatsApp Cloud API', autocomplete: 'off' });
    f.template_hasil = h('textarea.textarea', { rows: 4, placeholder: 'Kosongkan untuk template default' }); f.template_hasil.value = st.template_hasil || '';
    var ok = ME.integrasi.wa_api;
    return h('section.card', h('h2.title', 'WhatsApp Business API'),
      !fitur('wa_api') ? h('div.alert', { style: { marginBottom: '12px' } }, 'WhatsApp otomatis tersedia di paket Pro.') : null,
      h('p.small', ok ? h('span.ok-text', 'Terhubung.') : h('span.muted', 'Belum terhubung — tombol WhatsApp tetap membuka chat manual (wa.me).')),
      h('div.toggle-row', h('div', h('b', 'Kirim link otomatis saat sesi dibuat'), h('span.small.muted', 'Butuh nomor WA pelanggan dan template pesan yang disetujui Meta.')), h('label.switch', f.wa_otomatis, h('span'))),
      h('div.grid-2', { style: { marginTop: '8px' } }, h('label.field', h('span', 'Phone number ID (opsional)'), f.wa_phone_number_id), h('label.field', h('span', 'Access token (opsional)'), f.wa_token)),
      h('label.field', { style: { marginTop: '12px' } }, h('span', 'Template pesan hasil akhir'), h('span.hint', 'Variabel: {nama} {judul} {studio} {link}'), f.template_hasil));
  }


  boot();
})();
