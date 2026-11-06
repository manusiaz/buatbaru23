/* Helper UI bersama (tanpa framework) */
(function () {
  'use strict';
  var P = {
    galeri: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    pilih: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
    salin: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    kirim: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
    tautan: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    drive: '<path d="M8 3h8l6 11-4 7H6l-4-7z"/><path d="m8 3 8 18M16 3 6 21M2 14h20"/>',
    waktu: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    cari: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    catatan: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    unduh: '<path d="M12 3v12m0 0-5-5m5 5 5-5"/><path d="M5 21h14"/>',
    tambah: '<path d="M12 5v14M5 12h14"/>',
    lihat: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    dasbor: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
    pengaturan: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    keluar: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
    tim: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M16 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3"/>',
    paket: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    kiri: '<path d="m15 18-6-6 6-6"/>',
    kanan: '<path d="m9 18 6-6-6-6"/>',
    lonceng: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    sinkron: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
    kunci: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    wa: '<path d="M3 21l1.6-4.7A8.5 8.5 0 1 1 7.7 19.4z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1.2-1.4-2-1-1 .9a4 4 0 0 1-2.2-2.2l.9-1-1-2z"/>',
    kiosk: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    laporan: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
    kartu: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
    qr: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
    banding: '<rect x="3" y="4" width="8" height="16" rx="1"/><rect x="13" y="4" width="8" height="16" rx="1"/>',
    zoom: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M11 8v6M8 11h6"/>',
  };
  function icon(name, cls) {
    return '<svg class="icon ' + (cls || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[name] || '') + '</svg>';
  }

  // h('div.cls#id', {attrs/on*}, children...)
  function h(sel, attrs) {
    var m = sel.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
    var el = document.createElement((m && m[1]) || 'div');
    if (m && m[2]) m[2].replace(/([.#])([\w-]+)/g, function (_, t, v) { if (t === '.') el.classList.add(v); else el.id = v; });
    var kids = Array.prototype.slice.call(arguments, 2);
    if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    append(el, kids);
    return el;
  }
  function append(el, kids) {
    kids.forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) return append(el, c);
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    });
  }
  function ic(name, cls) { var s = document.createElement('span'); s.style.display = 'inline-flex'; s.innerHTML = icon(name, cls); return s.firstChild; }

  function api(method, url, body) {
    var opt = { method: method, headers: { accept: 'application/json' }, credentials: 'same-origin' };
    if (body === undefined && method !== 'GET' && method !== 'HEAD') body = {};
    if (body !== undefined) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch(url, opt).then(function (res) {
      return res.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : {}; } catch (e) { j = { error: t }; }
        if (!res.ok) { var err = new Error((j && j.error) || ('HTTP ' + res.status)); err.status = res.status; err.data = j; throw err; }
        return j;
      });
    });
  }

  var toastWrap;
  function toast(msg, isErr) {
    if (!toastWrap) { toastWrap = h('div.toast-wrap', { role: 'status', 'aria-live': 'polite' }); document.body.appendChild(toastWrap); }
    var t = h('div.toast' + (isErr ? '.err' : ''), msg);
    toastWrap.appendChild(t);
    setTimeout(function () { t.remove(); }, isErr ? 4000 : 2200);
  }

  function copy(text, okMsg) {
    var done = function () { toast(okMsg || 'Tersalin'); return true; };
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(done, function () { return fallback(); });
    }
    return Promise.resolve(fallback());
    function fallback() {
      var ta = h('textarea', { style: { position: 'fixed', top: '-1000px', opacity: '0' } });
      ta.value = text; document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      if (ok) return done();
      toast('Gagal menyalin, salin manual ya', true); return false;
    }
  }

  function modal(opts) {
    // opts: {title, body(Node|string), actions:[{label, cls, onClick(close)}], onClose}
    var bg = h('div.modal-bg', { role: 'dialog', 'aria-modal': 'true' });
    var box = h('div.modal');
    function close() { bg.remove(); document.removeEventListener('keydown', esc); if (opts.onClose) opts.onClose(); }
    function esc(e) { if (e.key === 'Escape') close(); }
    if (opts.title) box.appendChild(h('h3', opts.title));
    if (opts.body) box.appendChild(typeof opts.body === 'string' ? h('p.muted', opts.body) : opts.body);
    if (opts.actions) {
      box.appendChild(h('div.actions', opts.actions.map(function (a) {
        return h('button.btn.' + (a.cls || 'btn-secondary'), { type: 'button', onclick: function () { a.onClick ? a.onClick(close) : close(); } }, a.label);
      })));
    }
    bg.appendChild(box);
    bg.addEventListener('click', function (e) { if (e.target === bg) close(); });
    document.addEventListener('keydown', esc);
    document.body.appendChild(bg);
    var f = box.querySelector('input,textarea,select,button'); if (f) setTimeout(function () { f.focus(); }, 30);
    return { close: close, box: box };
  }
  function confirmBox(title, text, okLabel, cls) {
    return new Promise(function (resolve) {
      modal({ title: title, body: text, onClose: function () { resolve(false); }, actions: [
        { label: 'Batal', cls: 'btn-secondary', onClick: function (c) { c(); } },
        { label: okLabel || 'Ya', cls: cls || 'btn-primary', onClick: function (c) { resolve(true); c(); } },
      ] });
    });
  }

  var ZONA = { 'Asia/Jakarta': 'WIB', 'Asia/Makassar': 'WITA', 'Asia/Jayapura': 'WIT' };
  function fmtDate(d, tz, opts) {
    if (!d) return '–';
    try { return new Intl.DateTimeFormat('id-ID', Object.assign({ timeZone: tz || 'Asia/Jakarta' }, opts || { day: 'numeric', month: 'short', year: 'numeric' })).format(new Date(d)); } catch (e) { return String(d); }
  }
  function fmtDateTime(d, tz) {
    if (!d) return '–';
    return fmtDate(d, tz, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' ' + (ZONA[tz || 'Asia/Jakarta'] || '');
  }
  function rel(d) {
    if (!d) return '';
    var s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
    var fut = s < 0; s = Math.abs(s);
    var t = s < 60 ? 'baru saja' : s < 3600 ? Math.round(s / 60) + ' menit' : s < 86400 ? Math.round(s / 3600) + ' jam' : Math.round(s / 86400) + ' hari';
    if (t === 'baru saja') return t;
    return fut ? 'dalam ' + t : t + ' lalu';
  }
  function dur(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000), hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    if (hh >= 48) return Math.floor(hh / 24) + ' hari';
    return (hh ? hh + ':' + p(mm) : mm) + ':' + p(ss);
  }
  function initials(n) { return String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase(); }

  var STATUS = {
    menyinkron: 'Menyinkron', siap: 'Siap dikirim', dibuka: 'Dibuka', memilih: 'Sedang memilih', terkirim: 'Pilihan masuk',
    waktu_habis: 'Waktu habis', selesai: 'Selesai', kedaluwarsa: 'Kedaluwarsa',
  };
  function statusBadge(st) { return h('span.badge.st-' + st, STATUS[st] || st); }

  window.UI = { h: h, ic: ic, icon: icon, api: api, toast: toast, copy: copy, modal: modal, confirm: confirmBox,
    fmtDate: fmtDate, fmtDateTime: fmtDateTime, rel: rel, dur: dur, initials: initials, STATUS: STATUS, statusBadge: statusBadge, ZONA: ZONA };
})();
