/* Galeri pelanggan: PL1–PL6 */
(function () {
  'use strict';
  var h = UI.h, ic = UI.ic, F = window.GSFormat;
  var m = location.pathname.match(/^\/g\/([A-Za-z0-9_-]+)(?:\/(\d+))?/);
  var TOKEN = m ? m[1] : '';
  var OPEN_NOMOR = m && m[2] ? parseInt(m[2], 10) : null;
  var BASE = '/g/' + TOKEN + '/api';
  var root = document.getElementById('root');

  var S = { info: null, state: null, filter: 'semua', sub: '', offset: 0, warned: {}, saving: 0, lb: null, timerT: null, pollT: null, submitting: false };

  function api(method, path, body) { return UI.api(method, BASE + path, body); }
  function serverNow() { return Date.now() + S.offset; }
  function syncClock(iso) { if (iso) S.offset = new Date(iso).getTime() - Date.now(); }
  function pad(n) { return F.pad(n, S.state ? S.state.nomor_total : 0); }
  function tz() { return (S.info && S.info.studio.zona_waktu) || 'Asia/Jakarta'; }
  function biaya(extra) { var i = S.state || S.info; return F.hargaTambahan(extra, i.harga_foto_tambahan, i.harga_bertingkat); }
  function kiosk() { return !!((S.state && S.state.kiosk) || /[?&]kiosk=1/.test(location.search)); }
  function waStudio(text) {
    var no = S.info && S.info.studio.no_wa;
    return 'https://wa.me/' + (no || '') + '?text=' + encodeURIComponent(text || '');
  }
  function setBrand() {
    if (!S.info) return;
    document.title = S.info.judul + ' · ' + S.info.studio.nama;
  }
  function brandBar(right) {
    var st = S.info.studio;
    return h('div.c-wrap', h('div.c-top',
      h('div.c-brand', h('div.logo-mark', st.logo_url ? h('img', { src: st.logo_url, alt: '' }) : UI.initials(st.nama)), h('span', st.nama)),
      right || null));
  }

  function load() {
    return api('GET', '/info').then(function (info) {
      S.info = info; syncClock(info.server_now); setBrand();
      if (info.perlu_pin) return renderPin();
      return loadState();
    }).catch(function (e) {
      root.innerHTML = '';
      root.appendChild(h('div.center-page', h('div.gate', h('h1.title', 'Galeri tidak ditemukan'), h('p.muted', e.message))));
    });
  }

  function loadState(keepScroll) {
    return api('GET', '/state').then(function (st) {
      S.state = st; S.info = Object.assign(S.info || {}, st); syncClock(st.server_now);
      render(keepScroll);
    }).catch(function (e) {
      if (e.status === 401) { S.info.perlu_pin = true; return renderPin(); }
      UI.toast(e.message, true);
    });
  }

  // ---------- PL1: PIN ----------
  function renderPin() {
    var i = S.info;
    var err = h('p.err-text', { role: 'alert' });
    var inp = h('input.input.pin-input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, pattern: '[0-9]*', 'aria-label': 'PIN galeri', placeholder: '••••••' });
    var btn = h('button.btn.btn-primary', { type: 'submit' }, 'Buka galeri');
    var form = h('form.stack', { onsubmit: function (e) {
      e.preventDefault();
      btn.disabled = true; err.textContent = '';
      api('POST', '/pin', { pin: inp.value.trim() }).then(function () { S.info.perlu_pin = false; return loadState(); })
        .catch(function (e2) { err.textContent = e2.message; btn.disabled = false; inp.select(); });
    } }, inp, err, btn);
    root.innerHTML = '';
    root.appendChild(h('div', brandBar(),
      h('div.center-page', { style: { minHeight: 'calc(100dvh - 70px)' } }, h('div.gate',
        h('div.label', [i.jenis, i.tanggal_sesi ? UI.fmtDate(i.tanggal_sesi + 'T12:00:00Z', tz()) : null].filter(Boolean).join(' · ') || 'Galeri foto'),
        h('h1.display-lg', i.judul),
        h('p.muted', 'Masukkan PIN dari studio untuk membuka galerimu.'),
        h('div.facts',
          h('div', h('span.label', 'Kuota'), h('b', i.kuota + ' foto')),
          h('div', h('span.label', 'Batas'), h('b', { style: { fontSize: '15px', fontFamily: 'var(--f-body)' } }, UI.fmtDateTime(i.tenggat_link, tz())))),
        form,
        i.studio.no_wa ? h('a.btn.btn-text', { href: waStudio('Halo, saya butuh bantuan membuka galeri ' + i.judul), target: '_blank', rel: 'noopener', style: { marginTop: '10px' } }, ic('wa'), 'Butuh bantuan? Chat studio') : null)),
      legal()));
    setTimeout(function () { inp.focus(); }, 50);
  }

  function legal() {
    return h('div.legal', 'Foto ini milik ', S.info ? S.info.studio.nama : 'studio', '. Pratinjau ber-watermark, bukan file akhir. ', h('a', { href: '/privasi', target: '_blank' }, 'Kebijakan privasi'),
      S.info && S.info.label_produk ? h('div', { style: { marginTop: '6px' } }, 'Dibuat dengan ', h('a', { href: '/', target: '_blank' }, 'Galeri Seleksi')) : null,
      S.state && !S.state.staff && !S.state.perlu_pin ? h('div', { style: { marginTop: '6px' } }, h('a', { href: '#', onclick: function (e) {
        e.preventDefault();
        var aktif = !!S.state.pengingat_mati;
        api('POST', '/pengingat', { aktif: aktif }).then(function () { S.state.pengingat_mati = !aktif; UI.toast(aktif ? 'Pengingat dinyalakan lagi' : 'Kamu tidak akan menerima pengingat lagi'); e.target.textContent = aktif ? 'Jangan ingatkan saya lagi' : 'Nyalakan pengingat lagi'; }).catch(function (x) { UI.toast(x.message, true); });
      } }, S.state.pengingat_mati ? 'Nyalakan pengingat lagi' : 'Jangan ingatkan saya lagi')) : null);
  }

  // ---------- Router fase ----------
  function render(keepScroll) {
    var f = S.state.fase;
    clearTimeout(S.pollT);
    if (f === 'menyiapkan') return renderPreparing();
    if (f === 'sebelum_mulai') return renderBeforeStart();
    if ((f === 'terkirim' || f === 'waktu_habis' || f === 'kedaluwarsa') && !S.state.staff) return renderFinal();
    renderGallery(keepScroll);
  }

  function renderPreparing() {
    var p = S.state.progres || { selesai: 0, total: 0 };
    root.innerHTML = '';
    root.appendChild(h('div.center-page', h('div.gate', h('div.spinner', { style: { margin: '0 auto 16px' } }), h('h1.title', 'Galeri sedang disiapkan'),
      h('p.muted', 'Studio sedang memproses foto' + (p.total ? ' (' + p.selesai + ' dari ' + p.total + ')' : '') + '. Halaman ini akan terbuka sendiri.'))));
    S.pollT = setTimeout(function () { loadState(); }, 4000);
  }

  // ---------- PL2: Sebelum mulai ----------
  function renderBeforeStart() {
    var i = S.state;
    var btn = h('button.btn.btn-primary', { type: 'button', onclick: function () {
      btn.disabled = true;
      api('POST', '/mulai').then(function () { return loadState(); }).catch(function (e) { UI.toast(e.message, true); btn.disabled = false; loadState(); });
    } }, 'Mulai pilih');
    root.innerHTML = '';
    root.appendChild(h('div', brandBar(h('span.small.muted', 'Batas ' + UI.fmtDateTime(i.tenggat_link, tz()))),
      h('div.center-page', { style: { minHeight: 'calc(100dvh - 70px)' } }, h('div.gate',
        h('div.label', [i.jenis, i.jumlah_foto + ' foto'].filter(Boolean).join(' · ')),
        h('h1.display-lg', i.judul),
        h('p.muted', 'Setiap foto punya nomor. Ketuk lingkaran di sudut foto untuk memilih, ketuk fotonya untuk melihat besar.'),
        h('div.facts',
          h('div', h('span.label', 'Kuota'), h('b', i.kuota + ' foto')),
          h('div', h('span.label', 'Waktu pilih'), h('b', i.durasi_pilih_menit + ' menit')),
          i.maks_foto_tambahan > 0 ? h('div', h('span.label', 'Foto tambahan'), h('b', { style: { fontSize: '17px' } }, F.rupiah(i.harga_foto_tambahan)), h('span.small.muted', 'per foto, maks ' + i.maks_foto_tambahan),
            (i.harga_bertingkat || []).length ? h('div.small.muted', i.harga_bertingkat.map(function (t) { return '+' + t.jumlah + ' foto ' + F.rupiah(t.harga); }).join(' · ')) : null) : null),
        h('div.alert', { style: { textAlign: 'left', marginBottom: '16px' } }, 'Timer ', h('b', i.durasi_pilih_menit + ' menit'), ' mulai berjalan saat kamu menekan "Mulai pilih" dan tetap berjalan walau halaman ditutup. Saat waktu habis, pilihanmu terkirim otomatis.'),
        btn)),
      legal()));
  }

  // ---------- PL6: Status akhir ----------
  function renderFinal() {
    var i = S.state, f = i.fase;
    var picked = i.fotos.filter(function (x) { return x.dipilih; });
    root.innerHTML = '';
    var box;
    if (f === 'kedaluwarsa') {
      box = h('div.final.expired', h('div.label', { style: { color: '#F3C9C6' } }, 'Kedaluwarsa'), h('h1.display-lg', 'Waktu galeri habis'),
        h('p', 'Batas memilih sudah lewat (' + UI.fmtDateTime(i.tenggat_link, tz()) + '). Hubungi studio kalau masih ingin memilih.'),
        actionMintaWaktu(true),
        i.studio.no_wa ? h('a.btn.btn-ghost-dark', { href: waStudio('Halo, galeri ' + i.judul + ' sudah kedaluwarsa. Bisa dibuka lagi?'), target: '_blank', rel: 'noopener' }, ic('wa'), 'Hubungi studio') : null);
    } else {
      var auto = f === 'waktu_habis';
      box = h('div.final' + (auto ? '.timeout' : ''),
        h('div.label', { style: { color: '#94D2BD' } }, (auto ? 'Waktu habis · terkirim otomatis' : 'Terkirim') + ' · ' + UI.fmtDateTime(i.dikirim_pada, tz())),
        h('h1.display-lg', picked.length + ' pilihan terkirim'),
        h('p', auto ? 'Waktu memilih habis, jadi pilihanmu dikirim apa adanya ke studio.' : i.studio.nama + ' sudah menerima daftarmu. Simpan nomor ini kalau mau menanyakan foto tertentu.'),
        picked.length < i.kuota ? h('p', { style: { color: '#E9D8A6' } }, 'Kamu memilih ' + picked.length + ' dari kuota ' + i.kuota + ' foto. Studio akan menghubungi untuk langkah berikutnya.') : null,
        h('div.chips', picked.map(function (p) { return h('span.chip-num', pad(p.nomor)); })),
        i.hasil_link ? h('a.btn', { href: i.hasil_link, target: '_blank', rel: 'noopener', style: { background: 'var(--mint)', color: 'var(--abyss)' } }, ic('unduh'), 'Hasil edit sudah siap — buka') : null,
        tagihanBox(i),
        kiosk() ? h('a.btn.btn-amber', { href: '/app#/kiosk' }, 'Selesai — kembalikan ke admin') : null,
        picked.length && !kiosk() ? h('button.btn.btn-amber', { type: 'button', onclick: function () { UI.copy(selectionText(), 'Daftar pilihan tersalin'); } }, ic('salin'), 'Salin daftar nomor') : null,
        i.studio.no_wa && !kiosk() ? h('a.btn.btn-ghost-dark', { href: waStudio(selectionText()), target: '_blank', rel: 'noopener' }, ic('wa'), 'Kirim daftar ke WhatsApp studio') : null,
        h('p.small', { style: { marginTop: '16px' } }, 'Mau ubah pilihan? Hubungi studio, mereka bisa membuka kuncinya.'));
    }
    root.appendChild(h('div', brandBar(), h('div.center-page', { style: { minHeight: 'calc(100dvh - 70px)' } }, box), legal()));
  }

  // F-35: tagihan foto tambahan + bayar online
  function tagihanBox(i) {
    var t = i.tagihan;
    if (!t || !t.total) return null;
    if (t.status_bayar === 'lunas') return h('p', { style: { color: '#94D2BD', fontWeight: 700 } }, 'Foto tambahan ' + F.rupiah(t.total) + ' sudah lunas' + (t.metode ? ' (' + t.metode + ')' : '') + '. Terima kasih!');
    var b = i.bayar_online && !kiosk() ? h('button.btn.btn-amber', { type: 'button', onclick: function (e) {
      var btn = e.currentTarget; btn.disabled = true;
      api('POST', '/bayar').then(function (r) { location.href = r.url; }).catch(function (er) { UI.toast(er.message, true); btn.disabled = false; });
    } }, 'Bayar ' + F.rupiah(t.total) + ' (QRIS / VA)') : null;
    return h('div', { style: { background: 'rgba(255,255,255,.08)', borderRadius: '16px', padding: '14px', margin: '12px 0' } },
      h('div', h('b', t.jumlah_foto + ' foto tambahan · ' + F.rupiah(t.total))), h('div.small', { style: { color: '#C9D3D5' } }, b ? 'Bayar online sekarang, atau di kasir.' : 'Bayar di kasir atau transfer sesuai arahan studio.'), b);
  }

  function actionMintaWaktu(dark) {
    return h('button.btn.' + (dark ? 'btn-amber' : 'btn-secondary'), { type: 'button', onclick: function (e) {
      var b = e.currentTarget; b.disabled = true;
      api('POST', '/minta-waktu').then(function () { UI.toast('Permintaan terkirim ke studio'); b.textContent = 'Permintaan terkirim'; })
        .catch(function (er) { UI.toast(er.message, true); b.disabled = false; });
    } }, ic('waktu'), 'Minta tambah waktu');
  }

  // ---------- PL3: Galeri ----------
  var els = {};
  function renderGallery(keepScroll) {
    var y = window.scrollY;
    var i = S.state;
    var readOnly = i.staff || !(i.fase === 'memilih');
    root.innerHTML = '';
    els.timer = h('span.timer', { role: 'timer', 'aria-live': 'off' });
    els.counter = h('span.counter');
    els.saved = h('span.saved', { 'aria-live': 'polite' });
    els.warn = h('div.warn-banner', { hidden: true, role: 'alert' });
    var subs = uniq(i.fotos.map(function (f) { return f.subfolder || ''; }));
    var sticky = h('div.c-sticky',
      i.staff ? h('div.staff-banner', 'Mode pratinjau staf — pelanggan melihat galeri ini lewat PIN. ', h('a', { href: i.staff_url }, 'Buka di dasbor')) : null,
      els.warn,
      h('div.c-wrap', h('div.row', { style: { gap: '10px' } }, els.counter, els.saved), els.timer));
    var seg = h('div.seg', { role: 'tablist' });
    [['semua', 'Semua'], ['dipilih', 'Dipilih'], ['belum', 'Belum dipilih']].forEach(function (t) {
      seg.appendChild(h('button', { type: 'button', role: 'tab', class: S.filter === t[0] ? 'on' : '', 'aria-selected': String(S.filter === t[0]), onclick: function () { S.filter = t[0]; renderGallery(); } }, t[1], ' · ', h('span', { 'data-count': t[0] })));
    });
    // F-11: subfolder sebagai tab (mis. per lokasi atau kamera)
    var subSel = subs.length > 1 && i.tampil_nama_file ? h('div.seg.subtabs', { role: 'tablist', 'aria-label': 'Folder' },
      [''].concat(subs).map(function (sf) {
        var n = sf === '' ? i.fotos.length : i.fotos.filter(function (x) { return (x.subfolder || '') === sf; }).length;
        return h('button', { type: 'button', role: 'tab', class: S.sub === sf ? 'on' : '', 'aria-selected': String(S.sub === sf), onclick: function () { S.sub = sf; renderGallery(); } }, (sf === '' ? 'Semua folder' : sf || 'Utama') + ' · ' + n);
      })) : null;
    els.grid = h('div.photo-grid');
    var head = h('div.c-head',
      h('div.label', [i.jenis, i.jumlah_foto + ' foto', 'pilih ' + i.kuota].filter(Boolean).join(' · ')),
      h('h1.display-lg', i.judul),
      readOnly && !i.staff ? h('p.muted', 'Galeri ini hanya bisa dilihat.') : h('p.muted.small', { style: { margin: '6px 0 0' } }, 'Ketuk lingkaran untuk memilih · ketuk foto untuk melihat besar, menulis catatan, atau menyalin link.'));
    root.appendChild(h('div', sticky, h('div.c-wrap', brandBar().firstChild, head, h('div.toolbar', seg, h('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: function () { startCompare(null); } }, ic('banding'), 'Bandingkan')), subSel ? h('div.toolbar', subSel) : null, els.grid)));
    els.bar = h('div.selbar');
    if (!i.staff) root.appendChild(els.bar);
    root.appendChild(legal());
    drawGrid();
    updateCounts();
    tick();
    clearInterval(S.timerT); S.timerT = setInterval(tick, 1000);
    if (keepScroll) window.scrollTo(0, y);
    if (OPEN_NOMOR) { var n = OPEN_NOMOR; OPEN_NOMOR = null; var f = find(n); if (f) openLb(n); }
  }

  function uniq(a) { var o = []; a.forEach(function (x) { if (o.indexOf(x) < 0) o.push(x); }); return o; }
  function find(n) { return S.state.fotos.filter(function (f) { return f.nomor === n; })[0]; }
  function visible() {
    return S.state.fotos.filter(function (f) {
      if (S.sub && (f.subfolder || '') !== S.sub) return false;
      if (S.filter === 'dipilih') return f.dipilih;
      if (S.filter === 'belum') return !f.dipilih;
      return true;
    });
  }
  function picked() { return S.state.fotos.filter(function (f) { return f.dipilih; }).sort(function (a, b) { return a.nomor - b.nomor; }); }
  function canEdit() { return !S.state.staff && S.state.fase === 'memilih' && !S.submitting; }

  var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (ents) {
    ents.forEach(function (e) { if (e.isIntersecting) { var img = e.target; img.src = img.dataset.src; io.unobserve(img); } });
  }, { rootMargin: '600px 0px' }) : null;

  function tile(f) {
    var img = h('img', { alt: 'Foto ' + pad(f.nomor), draggable: 'false', decoding: 'async', oncontextmenu: function (e) { e.preventDefault(); } });
    if (io) { img.dataset.src = f.thumb; io.observe(img); } else img.src = f.thumb;
    var t = h('div.tile' + (f.dipilih ? '.sel' : ''), { 'data-n': f.nomor },
      h('div.ph', { onclick: function () { openLb(f.nomor); }, oncontextmenu: function (e) { e.preventDefault(); } },
        h('span.no', pad(f.nomor)), img,
        f.catatan ? h('span.flag', { title: 'Ada catatan' }, ic('catatan')) : null,
        f.dipilih && f.is_tambahan ? h('span.extra', 'Tambahan') : null),
      S.state.staff ? null : h('button.pick', { type: 'button', 'aria-pressed': String(!!f.dipilih), 'aria-label': (f.dipilih ? 'Batal pilih foto ' : 'Pilih foto ') + pad(f.nomor), onclick: function (e) { e.stopPropagation(); toggle(f.nomor); } }, h('i', ic('check'))),
      f.nama_file ? h('div.info', h('span.filename', { title: (f.subfolder ? f.subfolder + '/' : '') + f.nama_file }, f.nama_file, f.nama_kembar ? h('span.dup', ' · ' + (f.subfolder || 'kembar')) : null)) : null);
    return t;
  }
  function drawGrid() {
    els.grid.innerHTML = '';
    var list = visible();
    if (!list.length) {
      els.grid.appendChild(h('div.empty', { style: { gridColumn: '1/-1' } }, h('p.title', S.filter === 'dipilih' ? 'Belum ada foto dipilih' : 'Tidak ada foto'), h('p', S.filter === 'dipilih' ? 'Ketuk lingkaran di sudut foto untuk memilih.' : '')));
      return;
    }
    var frag = document.createDocumentFragment();
    list.forEach(function (f) { frag.appendChild(tile(f)); });
    els.grid.appendChild(frag);
  }
  function redrawTile(n) {
    var old = els.grid && els.grid.querySelector('.tile[data-n="' + n + '"]');
    var f = find(n);
    if (!old || !f) return;
    if ((S.filter === 'dipilih' && !f.dipilih) || (S.filter === 'belum' && f.dipilih)) { old.remove(); return; }
    var nt = tile(f);
    var img = old.querySelector('img');
    if (img && img.src) { var ni = nt.querySelector('img'); ni.src = img.src; if (io) io.unobserve(ni); }
    old.replaceWith(nt);
  }

  function updateCounts() {
    var i = S.state, p = picked(), n = p.length;
    var extra = Math.max(0, n - i.kuota);
    els.counter.innerHTML = '';
    els.counter.appendChild(h('span', h('b', String(n)), ' / ' + i.kuota + ' dipilih'));
    document.querySelectorAll('[data-count]').forEach(function (s) {
      var k = s.getAttribute('data-count');
      s.textContent = k === 'semua' ? i.fotos.length : k === 'dipilih' ? n : i.fotos.length - n;
    });
    if (!els.bar || i.staff) return;
    els.bar.innerHTML = '';
    var pct = Math.min(100, (n / i.kuota) * 100);
    var editable = canEdit();
    els.bar.appendChild(h('div.top',
      h('div', h('div.count', h('b', String(n)), ' / ' + i.kuota + ' dipilih'),
        extra > 0 ? h('div.extra-cost', '+' + extra + ' foto tambahan · ' + F.rupiah(biaya(extra))) : null),
      h('div.acts',
        h('button.btn.btn-amber.btn-sm', { type: 'button', disabled: !n, onclick: function () { UI.copy(selectionText(), n + ' pilihan tersalin'); } }, ic('salin'), 'Salin semua pilihan'),
        editable ? h('button.btn.btn-sm', { type: 'button', style: { background: '#fff', color: 'var(--abyss)' }, onclick: openSummary }, 'Kirim pilihan') : null)));
    els.bar.appendChild(h('div.progress', h('i', { style: { width: pct + '%' } })));
    if (n) {
      els.bar.appendChild(h('div.chips', p.map(function (f) {
        return h('span.chip-num', h('a', { href: '#', style: { color: 'inherit', textDecoration: 'none' }, onclick: function (e) { e.preventDefault(); openLb(f.nomor); } }, pad(f.nomor)),
          editable ? h('button', { type: 'button', 'aria-label': 'Batal pilih ' + pad(f.nomor), onclick: function () { toggle(f.nomor); } }, '×') : null);
      })));
    }
  }

  // ---------- Timer (jam server acuan) ----------
  function tick() {
    var i = S.state;
    if (!i || !els.timer) return;
    var end = i.fase === 'memilih' && i.berakhir_pada ? new Date(i.berakhir_pada).getTime() : (i.tenggat_link ? new Date(i.tenggat_link).getTime() : null);
    if (!end) { els.timer.hidden = true; return; }
    var left = end - serverNow();
    var countdown = i.durasi_pilih_menit > 0 && i.fase === 'memilih';
    els.timer.hidden = false;
    els.timer.innerHTML = '';
    els.timer.appendChild(ic('waktu'));
    els.timer.appendChild(document.createTextNode(left > 0 ? (countdown ? UI.dur(left) : 'Sisa ' + UI.dur(left)) : 'Waktu habis'));
    els.timer.setAttribute('aria-label', 'Sisa waktu ' + UI.dur(left));
    var warn = i.fase === 'memilih' && left <= 5 * 60 * 1000;
    els.timer.classList.toggle('warn', warn && left > 0);
    if (i.fase !== 'memilih' || i.staff) return;
    [[5, 'Sisa 5 menit! Pastikan pilihanmu sudah lengkap.'], [1, 'Sisa 1 menit! Pilihan akan terkirim otomatis.']].forEach(function (w) {
      if (left <= w[0] * 60000 && left > 0 && !S.warned[w[0]]) {
        S.warned[w[0]] = true;
        els.warn.hidden = false; els.warn.textContent = w[1];
        els.timer.setAttribute('aria-live', 'assertive');
        if (navigator.vibrate) try { navigator.vibrate(w[0] === 1 ? [200, 100, 200] : 200); } catch (e) { /* abaikan */ }
      }
    });
    if (left <= 5 * 60 * 1000 && left > 0 && els.warn.hidden === false && !els.warn.querySelector('button')) {
      els.warn.appendChild(document.createTextNode(' '));
      els.warn.appendChild(h('button.btn.btn-sm', { type: 'button', style: { background: '#fff', color: 'var(--scarlet)', minHeight: '30px', marginLeft: '8px' }, onclick: function (e) {
        var b = e.currentTarget; b.disabled = true;
        api('POST', '/minta-waktu').then(function () { b.textContent = 'Permintaan terkirim'; UI.toast('Studio sudah diberi tahu'); }).catch(function (er) { UI.toast(er.message, true); b.disabled = false; });
      } }, 'Minta tambah waktu'));
    }
    if (left <= 0 && !S.expiring) {
      S.expiring = true;
      clearInterval(S.timerT);
      els.warn.hidden = false; els.warn.textContent = 'Waktu habis — pilihanmu sedang dikirim…';
      // Server mengunci sesi; tunggu masa tenggang lalu muat ulang
      setTimeout(function () { S.expiring = false; closeLb(); loadState(); }, 11000);
    }
  }

  // ---------- Pilih / batal ----------
  function toggle(n) {
    if (!canEdit()) { if (S.state.fase !== 'memilih') UI.toast('Pilihan tidak bisa diubah lagi.', true); return; }
    var f = find(n); if (!f) return;
    var want = !f.dipilih;
    var count = picked().length, i = S.state;
    if (want && count >= i.kuota) {
      var max = i.kuota + i.maks_foto_tambahan;
      if (count >= max) return quotaFull(n, false);
      if (!f._confirmExtra) return quotaFull(n, true);
    }
    f._confirmExtra = false;
    f.dipilih = want; f.is_tambahan = want && count >= i.kuota; if (!want) f.catatan = null;
    redrawTile(n); updateCounts(); updateLb();
    saving(1);
    api('POST', '/pilih', { nomor: n, pilih: want }).then(function (r) {
      saving(-1);
      if (r.berakhir_pada) S.state.berakhir_pada = r.berakhir_pada;
      setExtras(r.tambahan_nomor || []);
    }).catch(function (e) {
      saving(-1, true);
      f.dipilih = !want; redrawTile(n); updateCounts(); updateLb();
      UI.toast(e.message, true);
      if (e.status === 409) loadState(true);
    });
  }
  function setExtras(list) {
    // samakan tanda "tambahan" dengan server (urutan waktu pilih)
    S.state.fotos.forEach(function (f) {
      var ex = f.dipilih && list.indexOf(f.nomor) >= 0;
      if (!!f.is_tambahan !== ex) { f.is_tambahan = ex; redrawTile(f.nomor); }
    });
  }
  function saving(d, failed) {
    S.saving += d;
    if (!els.saved) return;
    els.saved.textContent = S.saving > 0 ? 'Menyimpan…' : failed ? 'Gagal simpan' : 'Tersimpan ✓';
  }
  function quotaFull(n, extraAllowed) {
    var i = S.state;
    var acts = [{ label: 'Ganti pilihan', cls: 'btn-secondary', onClick: function (c) { c(); closeLb(); S.filter = 'dipilih'; renderGallery(); UI.toast('Batalkan salah satu foto untuk mengganti'); } }];
    if (extraAllowed) acts.push({ label: 'Tambah foto (' + F.rupiah(i.harga_foto_tambahan) + ')', cls: 'btn-amber', onClick: function (c) { c(); var f = find(n); f._confirmExtra = true; toggle(n); } });
    UI.modal({
      title: 'Kuota ' + i.kuota + ' foto sudah penuh',
      body: extraAllowed
        ? 'Kamu bisa menambah foto dengan biaya ' + F.rupiah(i.harga_foto_tambahan) + ' per foto (maks ' + i.maks_foto_tambahan + ' tambahan), atau mengganti salah satu pilihan.'
        : (i.maks_foto_tambahan > 0 ? 'Batas foto tambahan juga sudah tercapai. ' : '') + 'Batalkan salah satu pilihan untuk menggantinya.',
      actions: acts,
    });
  }

  function galleryUrl() { return S.state.gallery_url; }
  function selectionText() {
    var i = S.state, p = picked();
    return F.selectionText({ nama: i.pelanggan, judul: i.judul, items: p, kuota: i.kuota, galleryUrl: galleryUrl(), total: i.nomor_total,
      showName: i.tampil_nama_file, catatanUmum: i.catatan_umum, tambahan: Math.max(0, p.length - i.kuota), harga: i.harga_foto_tambahan, total: biaya(Math.max(0, p.length - i.kuota)) });
  }

  // ---------- PL4: Layar penuh ----------
  function openLb(n) {
    if (!find(n)) return;
    closeLb(true);
    var lb = { n: n };
    S.lb = lb;
    lb.el = h('div.lb', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Foto ' + pad(n) });
    document.body.appendChild(lb.el);
    document.body.style.overflow = 'hidden';
    lb.key = function (e) {
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.key === 'Escape') closeLb(); else if (e.key === 'ArrowLeft') step(-1); else if (e.key === 'ArrowRight') step(1); else if (e.key === ' ') { e.preventDefault(); toggle(S.lb.n); }
    };
    document.addEventListener('keydown', lb.key);
    history.replaceState(null, '', '/g/' + TOKEN + '/' + pad(n));
    updateLb();
  }
  function closeLb(silent) {
    if (!S.lb) return;
    document.removeEventListener('keydown', S.lb.key);
    S.lb.el.remove(); S.lb = null;
    document.body.style.overflow = '';
    if (!silent) history.replaceState(null, '', '/g/' + TOKEN);
  }
  function step(d) {
    var list = visible(); if (!S.lb) return;
    var idx = list.findIndex(function (f) { return f.nomor === S.lb.n; });
    if (idx < 0) list = S.state.fotos, idx = list.findIndex(function (f) { return f.nomor === S.lb.n; });
    var nx = list[(idx + d + list.length) % list.length];
    if (nx) { S.lb.n = nx.nomor; history.replaceState(null, '', '/g/' + TOKEN + '/' + pad(nx.nomor)); updateLb(); }
  }
  function updateLb() {
    var lb = S.lb; if (!lb) return;
    var f = find(lb.n), i = S.state, el = lb.el;
    el.innerHTML = '';
    var img = h('img', { src: f.preview, alt: 'Foto ' + pad(f.nomor), draggable: 'false', oncontextmenu: function (e) { e.preventDefault(); } });
    var stage = h('div.lb-stage', { ondblclick: function () { stage.classList.toggle('zoomed'); } }, img,
      h('button.lb-nav.l', { type: 'button', 'aria-label': 'Sebelumnya', onclick: function (e) { e.stopPropagation(); step(-1); } }, ic('kiri')),
      h('button.lb-nav.r', { type: 'button', 'aria-label': 'Berikutnya', onclick: function (e) { e.stopPropagation(); step(1); } }, ic('kanan')));
    // geser (swipe)
    var sx = null, sy = null;
    stage.addEventListener('touchstart', function (e) { if (e.touches.length === 1 && !stage.classList.contains('zoomed')) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; } else sx = null; }, { passive: true });
    stage.addEventListener('touchend', function (e) {
      if (sx === null) return;
      var dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; sx = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
    });
    var editable = canEdit();
    var line = F.photoLine(f, galleryUrl(), i.nomor_total, i.tampil_nama_file);
    el.appendChild(h('div.lb-top',
      h('div.row', { style: { gap: '10px', minWidth: 0, flexWrap: 'nowrap' } }, h('span.lb-no' + (f.dipilih ? '.sel' : ''), pad(f.nomor)), f.nama_file ? h('span.fname', f.nama_file) : null),
      h('div.row', { style: { gap: '8px' } },
        h('button.icon-btn', { type: 'button', 'aria-label': 'Bandingkan dengan foto lain', title: 'Bandingkan', onclick: function () { startCompare(f.nomor); } }, ic('banding')),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Perbesar', onclick: function () { stage.classList.toggle('zoomed'); } }, ic('zoom')),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Tutup', onclick: function () { closeLb(); } }, ic('x')))));
    el.appendChild(stage);
    var bot = h('div.lb-bot',
      h('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: function () { UI.copy(line, 'Link foto ' + pad(f.nomor) + ' tersalin'); } }, ic('tautan'), 'Salin link'),
      editable ? h('button.btn.' + (f.dipilih ? 'btn-amber' : 'btn-secondary'), { type: 'button', 'aria-pressed': String(!!f.dipilih), onclick: function () { toggle(f.nomor); } }, ic('check'), f.dipilih ? 'Dipilih' : 'Pilih') : (f.dipilih ? h('span.badge.st-terkirim', 'Dipilih') : null));
    el.appendChild(bot);
    if (f.dipilih && i.izin_catatan && editable) {
      var note = h('input.input', { value: f.catatan || '', maxlength: 500, placeholder: 'Catatan untuk editor (mis. crop lebih rapat)', 'aria-label': 'Catatan untuk foto ' + pad(f.nomor) });
      var saveBtn = h('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: saveNote }, 'Simpan');
      function saveNote() {
        var v = note.value.trim(); saveBtn.disabled = true;
        api('PUT', '/catatan', { nomor: f.nomor, catatan: v }).then(function () { f.catatan = v || null; UI.toast('Catatan tersimpan'); redrawTile(f.nomor); saveBtn.disabled = false; })
          .catch(function (e) { UI.toast(e.message, true); saveBtn.disabled = false; });
      }
      note.addEventListener('keydown', function (e) { if (e.key === 'Enter') saveNote(); });
      bot.appendChild(h('div.lb-note', ic('catatan'), note, saveBtn));
    } else if (f.catatan) {
      bot.appendChild(h('div.lb-note.small', ic('catatan'), '“' + f.catatan + '”'));
    }
  }

  // ---------- PL7: Bandingkan dua foto (F-26) ----------
  function startCompare(a) {
    closeLb();
    var list = visible();
    if (list.length < 2) { UI.toast('Butuh minimal 2 foto untuk dibandingkan', true); return; }
    var A = a || list[0].nomor;
    var idx = list.findIndex(function (f) { return f.nomor === A; });
    var B = (list[(idx + 1) % list.length] || list[0]).nomor;
    var el = h('div.lb.cmp', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Bandingkan foto' });
    document.body.appendChild(el); document.body.style.overflow = 'hidden';
    function key(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', key);
    function close() { el.remove(); document.removeEventListener('keydown', key); document.body.style.overflow = ''; }
    function side(n, setN) {
      var f = find(n);
      var pos = list.findIndex(function (x) { return x.nomor === n; });
      var mv = function (d) { setN(list[(pos + d + list.length) % list.length].nomor); draw(); };
      var pane = h('div.cmp-pane',
        h('div.cmp-img', h('img', { src: f.preview, alt: 'Foto ' + pad(n), draggable: 'false', oncontextmenu: function (e) { e.preventDefault(); } }),
          h('span.lb-no' + (f.dipilih ? '.sel' : ''), { style: { position: 'absolute', top: '8px', left: '8px' } }, pad(n))),
        h('div.cmp-bar',
          h('button.icon-btn', { type: 'button', 'aria-label': 'Foto sebelumnya', onclick: function () { mv(-1); } }, ic('kiri')),
          canEdit() ? h('button.btn.btn-sm.' + (f.dipilih ? 'btn-amber' : 'btn-secondary'), { type: 'button', 'aria-pressed': String(!!f.dipilih), onclick: function () { toggle(n); setTimeout(draw, 50); } }, ic('check'), f.dipilih ? 'Dipilih' : 'Pilih') : null,
          h('button.icon-btn', { type: 'button', 'aria-label': 'Foto berikutnya', onclick: function () { mv(1); } }, ic('kanan'))));
      var sx = null;
      pane.addEventListener('touchstart', function (e) { sx = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
      pane.addEventListener('touchend', function (e) { if (sx === null) return; var dx = e.changedTouches[0].clientX - sx; sx = null; if (Math.abs(dx) > 50) mv(dx < 0 ? 1 : -1); });
      return pane;
    }
    function draw() {
      el.innerHTML = '';
      el.appendChild(h('div.lb-top', h('b', 'Bandingkan ' + pad(A) + ' & ' + pad(B)), h('button.icon-btn', { type: 'button', 'aria-label': 'Tutup', onclick: close }, ic('x'))));
      el.appendChild(h('div.cmp-wrap', side(A, function (v) { A = v; }), side(B, function (v) { B = v; })));
    }
    draw();
  }

  // ---------- PL5: Ringkasan & kirim ----------
  function openSummary() {
    var i = S.state, p = picked();
    var extra = Math.max(0, p.length - i.kuota);
    var umum = h('textarea.textarea', { maxlength: 2000, placeholder: 'Catatan umum untuk editor (opsional)', 'aria-label': 'Catatan umum' });
    umum.value = i.catatan_umum || '';
    var body = h('div',
      p.length < i.kuota ? h('div.alert', 'Kamu baru memilih ' + p.length + ' dari ' + i.kuota + ' foto. Tetap bisa dikirim, tapi sisanya tidak bisa ditambah setelah terkirim.') : null,
      h('div.sum-list', p.map(function (f) {
        return h('div.sum-item', h('img', { src: f.thumb, alt: '' }),
          h('div.t', h('div.num', pad(f.nomor)), f.nama_file ? h('div.filename', f.nama_file) : null, f.catatan ? h('div.small.muted', '“' + f.catatan + '”') : null),
          f.is_tambahan ? h('span.badge.st-waktu_habis', 'Tambahan') : null);
      })),
      extra > 0 ? h('div.sum-total', h('span', 'Foto tambahan ' + extra + ' foto'), h('span', F.rupiah(biaya(extra)))) : null,
      extra > 0 ? h('p.small.muted', i.bayar_online ? 'Setelah dikirim, kamu bisa langsung bayar online (QRIS / virtual account) atau di kasir.' : 'Bayar foto tambahan di kasir atau transfer sesuai arahan studio.') : null,
      h('label.field', h('span', 'Catatan umum'), umum),
      h('p.small.muted', 'Setelah dikirim, pilihan terkunci. Hanya studio yang bisa membukanya lagi.'));
    var mdl = UI.modal({ title: 'Kirim ' + p.length + ' pilihan?', body: body, actions: [
      { label: 'Periksa lagi', cls: 'btn-secondary' },
      { label: 'Salin semua pilihan', cls: 'btn-amber', onClick: function () { saveUmum().then(function () { UI.copy(selectionText(), 'Daftar pilihan tersalin'); }); } },
      { label: 'Kirim pilihan', cls: 'btn-primary', onClick: function (close) {
        // Buka tab WhatsApp lebih dulu (sinkron dengan klik) agar tidak diblokir browser
        var w = i.studio.no_wa && !kiosk() ? window.open('about:blank', '_blank') : null;
        S.submitting = true;
        saveUmum().then(function () { return api('POST', '/kirim'); }).then(function () {
          S.submitting = false; close();
          var txt = selectionText();
          if (w) { try { w.location.href = waStudio(txt); } catch (e) { /* abaikan */ } }
          clearInterval(S.timerT); closeLb(); loadState();
        }).catch(function (e) { S.submitting = false; if (w) w.close(); UI.toast(e.message, true); loadState(true); });
      } },
    ] });
    function saveUmum() {
      var v = umum.value.trim();
      if (v === (i.catatan_umum || '')) return Promise.resolve();
      return api('PUT', '/catatan-umum', { catatan: v }).then(function () { i.catatan_umum = v || null; });
    }
    return mdl;
  }

  // Muat ulang saat tab kembali aktif (pilihan sama di semua perangkat, F-20)
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && S.state && !S.lb && !document.querySelector('.modal-bg')) loadState(true);
  });

  load();
})();
