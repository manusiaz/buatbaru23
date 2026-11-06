// Format teks salin — dipakai di browser (window.GSFormat) dan server (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GSFormat = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function pad(n, total) {
    var w = Math.max(3, String(total || 0).length);
    var s = String(n);
    while (s.length < w) s = '0' + s;
    return s;
  }
  function stripExt(name) { return String(name).replace(/\.[^.]+$/, ''); }
  function rupiah(n) {
    return 'Rp ' + Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  // items: [{nomor, nama_file, path_subfolder}]
  var FORMATS = {
    nomor: { label: 'Nomor saja', hint: '003, 007, 012' },
    baris: { label: 'Nama file per baris', hint: 'DSC_4503.JPG ↵ DSC_4507.JPG' },
    koma: { label: 'Nama file, koma', hint: 'DSC_4503.JPG, DSC_4507.JPG' },
    lightroom: { label: 'Lightroom / Bridge', hint: 'DSC_4503 DSC_4507 DSC_4512' },
    windows: { label: 'Windows Explorer', hint: 'DSC_4503 OR DSC_4507' },
  };
  function fileList(items, format, opts) {
    opts = opts || {};
    var total = opts.total;
    var withExt = opts.ext !== false;
    var names = items.map(function (i) { return withExt ? i.nama_file : stripExt(i.nama_file); });
    switch (format) {
      case 'nomor': return items.map(function (i) { return pad(i.nomor, total); }).join(', ');
      case 'baris': return names.join('\n');
      case 'koma': return names.join(', ');
      case 'lightroom': return items.map(function (i) { return stripExt(i.nama_file); }).join(' ');
      case 'windows': return items.map(function (i) { return stripExt(i.nama_file); }).join(' OR ');
      default: return names.join('\n');
    }
  }

  // Satu baris per foto (F-48 / F-49): "#012  IMG_0735.JPG  https://domain/g/<kode>/012"
  function photoLine(item, galleryUrl, total, showName) {
    var no = pad(item.nomor, total);
    var parts = ['#' + no];
    if (showName && item.nama_file) parts.push(item.nama_file);
    parts.push(galleryUrl.replace(/\/$/, '') + '/' + no);
    return parts.join('  ');
  }
  function selectionText(opts) {
    // opts: {nama, judul, items, kuota, galleryUrl, total, showName, catatanUmum, tambahan, harga}
    var lines = [];
    var head = 'Pilihan ' + opts.nama + (opts.judul && opts.judul !== opts.nama ? ' · ' + opts.judul : '') +
      ' · ' + opts.items.length + ' dari ' + opts.kuota + ' foto';
    lines.push(head);
    opts.items.forEach(function (i) { lines.push(photoLine(i, opts.galleryUrl, opts.total, opts.showName)); });
    opts.items.forEach(function (i) {
      if (i.catatan) lines.push('Catatan #' + pad(i.nomor, opts.total) + ': ' + i.catatan);
    });
    if (opts.tambahan > 0) lines.push('Foto tambahan: ' + opts.tambahan + ' foto = ' + rupiah(opts.total != null ? opts.total : opts.tambahan * opts.harga));
    if (opts.catatanUmum) lines.push('Catatan umum: ' + opts.catatanUmum);
    return lines.join('\n');
  }

  function csv(items, total) {
    var esc = function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var rows = [['nomor', 'nama_file', 'path_subfolder', 'path_lengkap', 'nama_kembar', 'tambahan', 'catatan']];
    items.forEach(function (i) {
      var full = (i.path_subfolder ? i.path_subfolder + '/' : '') + i.nama_file;
      rows.push([pad(i.nomor, total), i.nama_file, i.path_subfolder || '', full, i.nama_kembar ? 'ya' : '', i.is_tambahan ? 'ya' : '', i.catatan || '']);
    });
    return rows.map(function (r) { return r.map(esc).join(','); }).join('\r\n') + '\r\n';
  }

  // F-50 (bonus): kenali nomor dan link di teks tempelan
  function parsePasted(text) {
    var nums = {};
    String(text || '').replace(/\/g\/[A-Za-z0-9_-]+\/(\d{1,5})/g, function (_, n) { nums[parseInt(n, 10)] = 1; return ''; })
      .replace(/#?\b(\d{3,5})\b/g, function (_, n) { nums[parseInt(n, 10)] = 1; return ''; });
    return Object.keys(nums).map(Number).sort(function (a, b) { return a - b; });
  }

  // F-36: harga foto tambahan termurah dari harga satuan + paket bertingkat [{jumlah, harga}]
  function hargaTambahan(n, satuan, tiers) {
    n = Math.max(0, n | 0); satuan = Number(satuan) || 0;
    var t = (tiers || []).filter(function (x) { return x && x.jumlah > 0 && x.harga >= 0; });
    var best = [0];
    for (var i = 1; i <= n; i++) {
      var b = best[i - 1] + satuan;
      t.forEach(function (x) { var prev = Math.max(0, i - x.jumlah); var c = best[prev] + Number(x.harga); if (c < b) b = c; });
      best[i] = b;
    }
    return best[n];
  }
  function parseTiers(text) {
    var out = [];
    String(text || '').split(/[,;\n]+/).forEach(function (part) {
      var m = part.replace(/\./g, '').match(/(\d+)\s*[=:x×]\s*(?:rp)?\s*(\d+)/i);
      if (m) out.push({ jumlah: parseInt(m[1], 10), harga: parseInt(m[2], 10) });
    });
    return out.sort(function (a, b) { return a.jumlah - b.jumlah; });
  }

  return { hargaTambahan: hargaTambahan, parseTiers: parseTiers, pad: pad, stripExt: stripExt, rupiah: rupiah, FORMATS: FORMATS, fileList: fileList, photoLine: photoLine, selectionText: selectionText, csv: csv, parsePasted: parsePasted };
}));
