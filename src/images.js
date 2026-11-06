'use strict';
// Pratinjau ber-watermark (WebP 400 px & 1600 px) disimpan di disk DATA_DIR/previews.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const config = require('./config');
const drive = require('./drive');

const SIZES = { thumb: 400, preview: 1600 };
const QUALITY = { thumb: 68, preview: 74 };

function filePath(sesiId, fotoId, kind) {
  return path.join(config.dataDir, 'previews', String(sesiId), `${fotoId}-${SIZES[kind]}.webp`);
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function watermarkSvg(w, h, text) {
  const t = escapeXml(text || '');
  const fs1 = Math.max(14, Math.round(Math.min(w, h) / 14));
  const stepX = fs1 * Math.max(6, t.length * 0.62);
  const stepY = fs1 * 5;
  let rows = '';
  for (let y = -h; y < h * 2; y += stepY) {
    for (let x = -w; x < w * 2; x += stepX) {
      rows += `<text x="${x.toFixed(0)}" y="${y.toFixed(0)}">${t}</text>`;
    }
  }
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <g transform="rotate(-28 ${w / 2} ${h / 2})" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700"
     font-size="${fs1}" fill="#ffffff" fill-opacity="0.22" stroke="#001219" stroke-opacity="0.12" stroke-width="1">${rows}</g>
</svg>`);
}

async function render(input, kind, wmText) {
  const size = SIZES[kind];
  const base = sharp(input, { failOn: 'none', limitInputPixels: 100e6 }).rotate().resize(size, size, { fit: 'inside', withoutEnlargement: true });
  const { data, info } = await base.toBuffer({ resolveWithObject: true });
  let img = sharp(data);
  if (wmText) img = img.composite([{ input: watermarkSvg(info.width, info.height, wmText), top: 0, left: 0 }]);
  return img.webp({ quality: QUALITY[kind], effort: 4 }).toBuffer();
}

// Gambar contoh (sumber 'contoh') — blok warna palette, dipakai untuk demo/uji tanpa Google Drive.
const PALETTE = [['#94D2BD', '#005F73'], ['#E9D8A6', '#CA6702'], ['#D3E2E5', '#0A9396'], ['#E9D8A6', '#BB3E03'],
  ['#94D2BD', '#14292E'], ['#D3E2E5', '#005F73'], ['#C9D3CE', '#617C64'], ['#E9D8A6', '#9B2226']];
function demoSource(nomor, nama) {
  const [a, b] = PALETTE[(nomor * 7 + 3) % PALETTE.length];
  const split = 45 + ((nomor * 13) % 25);
  const w = 1600; const h = 1200;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <rect width="${w}" height="${h}" fill="${a}"/>
  <rect y="${(h * split) / 100}" width="${w}" height="${h}" fill="${b}"/>
  <circle cx="${300 + ((nomor * 97) % 1000)}" cy="${h * 0.25}" r="70" fill="#ffffff" fill-opacity="0.75"/>
  <text x="60" y="${h - 60}" font-family="DejaVu Sans Mono, monospace" font-size="54" fill="#ffffff" fill-opacity="0.85">${escapeXml(nama)}</text>
</svg>`);
}

async function sourceFor(sesi, foto, size) {
  if (sesi.sumber === 'contoh') return demoSource(foto.nomor, foto.nama_file);
  return drive.fetchImage({ sumber: sesi.sumber, folderId: sesi.drive_folder_id, resourceKey: sesi.resource_key }, foto, size);
}

async function ensure(sesi, foto, kind, wmText) {
  const p = filePath(sesi.id, foto.id, kind);
  if (fs.existsSync(p)) return p;
  const src = await sourceFor(sesi, foto, SIZES[kind]);
  const buf = await render(src, kind, wmText);
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.promises.writeFile(tmp, buf);
  try {
    await fs.promises.rename(tmp, p);
  } catch (e) {
    await fs.promises.rm(tmp, { force: true });
    if (!fs.existsSync(p)) throw e;
  }
  return p;
}

async function removeSesi(sesiId) {
  await fs.promises.rm(path.join(config.dataDir, 'previews', String(sesiId)), { recursive: true, force: true });
}
async function removeFoto(sesiId, fotoId) {
  for (const k of Object.keys(SIZES)) await fs.promises.rm(filePath(sesiId, fotoId, k), { force: true });
}

module.exports = { ensure, filePath, removeSesi, removeFoto, SIZES, render, demoSource };
