/* Masuk / daftar / terima undangan (S1) */
(function () {
  'use strict';
  var h = UI.h, api = UI.api;
  var box = document.getElementById('box');
  var path = location.pathname;
  var next = new URLSearchParams(location.search).get('next');
  var dest = next && /^\/app/.test(next) ? next : '/app';
  var cfg = {};

  function field(label, attrs) { var i = h('input.input', attrs); return { el: h('label.field', h('span', label), i), input: i }; }
  function done() { location.href = dest; }

  function googleButton(extra) {
    if (!cfg.googleClientId) return null;
    var holder = h('div', { style: { minHeight: '44px', display: 'flex', justifyContent: 'center' } });
    var s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = function () {
      google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: function (resp) {
        api('POST', '/api/auth/google', Object.assign({ credential: resp.credential }, extra ? extra() : {})).then(done).catch(function (e) { UI.toast(e.message, true); });
      } });
      google.accounts.id.renderButton(holder, { theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', width: 320, locale: 'id' });
    };
    document.head.appendChild(s);
    return [holder, h('div.or', 'atau dengan email')];
  }

  function login() {
    var em = field('Email', { type: 'email', required: true, autocomplete: 'email' });
    var pw = field('Kata sandi', { type: 'password', required: true, autocomplete: 'current-password' });
    var er = h('p.err-text', { role: 'alert' });
    var btn = h('button.btn.btn-primary', { type: 'submit' }, 'Masuk');
    box.appendChild(h('form', { onsubmit: function (e) {
      e.preventDefault(); btn.disabled = true; er.textContent = '';
      api('POST', '/api/auth/login', { email: em.input.value, password: pw.input.value }).then(done).catch(function (x) { er.textContent = x.message; btn.disabled = false; });
    } }, h('h2.display-lg', 'Masuk'), h('p.muted', { style: { margin: 0 } }, 'Kelola galeri dan pilihan pelangganmu.'), googleButton(), em.el, pw.el, er, btn,
    h('p.small', 'Belum punya studio? ', h('a', { href: '/daftar' + location.search }, 'Daftar gratis'))));
  }

  function daftar() {
    var st = field('Nama studio', { required: true, maxlength: 80, placeholder: 'Studio Ajie Wicaksono' });
    var nm = field('Nama kamu', { required: true, maxlength: 80 });
    var wa = field('WhatsApp studio', { inputmode: 'tel', placeholder: '0812…' });
    var em = field('Email', { type: 'email', required: true, autocomplete: 'email' });
    var pw = field('Kata sandi', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' });
    var er = h('p.err-text', { role: 'alert' });
    var btn = h('button.btn.btn-primary', { type: 'submit' }, 'Buat studio');
    box.appendChild(h('form', { onsubmit: function (e) {
      e.preventDefault(); btn.disabled = true; er.textContent = '';
      api('POST', '/api/auth/register', { studio_nama: st.input.value, nama: nm.input.value, no_wa: wa.input.value, email: em.input.value, password: pw.input.value })
        .then(function () { location.href = '/app#/galeri/baru'; }).catch(function (x) { er.textContent = x.message; btn.disabled = false; });
    } }, h('h2.display-lg', 'Daftar studio'), h('p.muted', { style: { margin: 0 } }, 'Gratis untuk mulai. Foto asli tetap di Google Drive kamu.'),
    googleButton(function () { return { studio_nama: st.input.value }; }), st.el, nm.el, wa.el, em.el, pw.el, er, btn,
    h('p.small.muted', 'Dengan mendaftar kamu menyetujui ', h('a', { href: '/privasi' }, 'kebijakan privasi'), '.'),
    h('p.small', 'Sudah punya akun? ', h('a', { href: '/masuk' + location.search }, 'Masuk'))));
  }

  function undangan(token) {
    api('GET', '/api/auth/invite/' + encodeURIComponent(token)).then(function (inv) {
      var nm = field('Nama kamu', { required: true, maxlength: 80 });
      var pw = field('Buat kata sandi', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' });
      var er = h('p.err-text', { role: 'alert' });
      var btn = h('button.btn.btn-primary', { type: 'submit' }, 'Gabung');
      box.appendChild(h('form', { onsubmit: function (e) {
        e.preventDefault(); btn.disabled = true;
        api('POST', '/api/auth/invite/accept', { token: token, nama: nm.input.value, password: pw.input.value }).then(done).catch(function (x) { er.textContent = x.message; btn.disabled = false; });
      } }, h('h2.display-lg', 'Gabung tim'), h('p.muted', 'Kamu diundang ke ', h('b', inv.studio_nama), ' sebagai ', h('b', inv.peran), ' (' + inv.email + ').'), nm.el, pw.el, er, btn));
    }).catch(function (e) { box.appendChild(h('div.alert.err', e.message)); });
  }

  api('GET', '/api/config').then(function (c) { cfg = c; }).catch(function () {}).then(function () {
    var m = path.match(/^\/undangan\/([\w-]+)/);
    if (m) return undangan(m[1]);
    if (path === '/daftar') return daftar();
    // sudah login? langsung ke dasbor
    api('GET', '/api/me').then(done).catch(login);
  });
})();
