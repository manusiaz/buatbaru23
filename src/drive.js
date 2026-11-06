'use strict';
// Akses Google Drive lewat REST (tanpa SDK): service account (JWT RS256) atau API key untuk folder publik.
const crypto = require('crypto');
const fs = require('fs');
const config = require('./config');

const API = 'https://www.googleapis.com/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|tiff?|gif|bmp|cr2|cr3|nef|arw|raf|orf|rw2|dng|pef|srw)$/i;

let saCache = null;
function serviceAccount() {
  if (saCache !== null) return saCache;
  let raw = config.googleServiceAccountJson;
  if (!raw && config.googleServiceAccountFile) {
    try { raw = fs.readFileSync(config.googleServiceAccountFile, 'utf8'); } catch { raw = ''; }
  }
  if (raw && !raw.trim().startsWith('{')) {
    try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch { /* biarkan */ }
  }
  try { saCache = raw ? JSON.parse(raw) : false; } catch { saCache = false; }
  return saCache;
}
function serviceAccountEmail() {
  const sa = serviceAccount();
  return sa ? sa.client_email : null;
}

const tokenCaches = {};
async function saAccessToken(scope = 'https://www.googleapis.com/auth/drive.readonly') {
  const sa = serviceAccount();
  if (!sa) throw new DriveError('Service account Google belum dikonfigurasi (GOOGLE_SERVICE_ACCOUNT_JSON).', 'no_sa');
  const now = Math.floor(Date.now() / 1000);
  const tokenCache = tokenCaches[scope] || { token: null, exp: 0 };
  if (tokenCache.token && tokenCache.exp - 60 > now) return tokenCache.token;
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');
  const sig = crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(sa.private_key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${sig}`,
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new DriveError(`Gagal login service account: ${j.error_description || res.status}`, 'sa_auth');
  tokenCaches[scope] = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return j.access_token;
}

class DriveError extends Error {
  constructor(msg, code, status) { super(msg); this.code = code; this.status = status; }
}

function parseFolderLink(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return { folderId: s, resourceKey: null };
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!/(^|\.)google\.com$/.test(u.hostname)) return null;
  let id = null;
  const m = u.pathname.match(/\/folders\/([A-Za-z0-9_-]+)/);
  if (m) id = m[1];
  if (!id && u.searchParams.get('id')) id = u.searchParams.get('id');
  if (!id) return null;
  return { folderId: id, resourceKey: u.searchParams.get('resourcekey') || null };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ctx: { sumber: 'service_account'|'link_publik', resourceKey }
async function authHeaders(ctx, extraKeys) {
  const h = {};
  if (ctx.sumber === 'service_account') h.authorization = `Bearer ${await saAccessToken()}`;
  const keys = [];
  if (ctx.folderId && ctx.resourceKey) keys.push(`${ctx.folderId}/${ctx.resourceKey}`);
  if (extraKeys) keys.push(...extraKeys);
  if (keys.length) h['X-Goog-Drive-Resource-Keys'] = keys.join(',');
  return h;
}
function withKey(ctx, url) {
  if (ctx.sumber === 'link_publik') {
    if (!config.googleApiKey) throw new DriveError('GOOGLE_API_KEY belum diisi; link publik tidak bisa dibaca.', 'no_api_key');
    url.searchParams.set('key', config.googleApiKey);
  }
  return url;
}

// Exponential backoff untuk 403 (rate limit) / 429 / 5xx.
async function driveFetch(ctx, url, opts = {}, attempt = 0) {
  const headers = { ...(await authHeaders(ctx, opts.resourceKeys)), ...(opts.headers || {}) };
  const res = await fetch(url, { ...opts, headers });
  if (res.ok) return res;
  let body = null;
  try { body = await res.clone().json(); } catch { /* bukan json */ }
  const reason = body && body.error && body.error.errors && body.error.errors[0] && body.error.errors[0].reason;
  const retryable = res.status === 429 || res.status >= 500 ||
    (res.status === 403 && /rateLimit|userRateLimitExceeded|quotaExceeded/i.test(reason || ''));
  if (retryable && attempt < 6) {
    await sleep(Math.min(32000, 500 * 2 ** attempt) + Math.floor(Math.random() * 400));
    return driveFetch(ctx, url, opts, attempt + 1);
  }
  const msg = (body && body.error && body.error.message) || `HTTP ${res.status}`;
  throw new DriveError(msg, reason || 'http_' + res.status, res.status);
}

async function getFolder(ctx) {
  const url = withKey(ctx, new URL(`${API}/files/${encodeURIComponent(ctx.folderId)}`));
  url.searchParams.set('fields', 'id,name,mimeType,driveId');
  url.searchParams.set('supportsAllDrives', 'true');
  const res = await driveFetch(ctx, url);
  const f = await res.json();
  if (f.mimeType !== FOLDER_MIME) throw new DriveError('Link ini bukan folder Google Drive.', 'not_folder');
  return f;
}

// Cek akses folder + berikan langkah perbaikan bila gagal (F-07)
async function checkAccess(ctx) {
  try {
    const f = await getFolder(ctx);
    return { ok: true, nama: f.name };
  } catch (e) {
    const sa = serviceAccountEmail();
    let langkah;
    if (e.code === 'no_sa' || e.code === 'no_api_key') langkah = [e.message, 'Hubungi admin platform untuk melengkapi konfigurasi.'];
    else if (e.status === 404 || e.status === 403) {
      langkah = ctx.sumber === 'service_account'
        ? [`Buka folder di Google Drive → Bagikan.`, `Tambahkan ${sa || 'email layanan'} sebagai Viewer (Pelihat).`, 'Tekan "Cek ulang".']
        : ['Buka folder di Google Drive → Bagikan.', 'Ubah Akses umum ke "Siapa saja yang memiliki link" (Pelihat).', 'Tekan "Cek ulang".'];
    } else if (e.code === 'not_folder') langkah = ['Pastikan link yang ditempel adalah link folder, bukan link file.'];
    else langkah = ['Coba lagi beberapa saat lagi.'];
    return { ok: false, error: e.message, code: e.code, langkah };
  }
}

// files.list rekursif. Mengembalikan semua file gambar beserta path subfolder.
async function listImages(ctx, onProgress) {
  const out = [];
  const queue = [{ id: ctx.folderId, path: '', resourceKey: ctx.resourceKey }];
  const seen = new Set();
  while (queue.length) {
    const folder = queue.shift();
    if (seen.has(folder.id)) continue;
    seen.add(folder.id);
    let pageToken = null;
    do {
      const url = withKey(ctx, new URL(`${API}/files`));
      url.searchParams.set('q', `'${folder.id}' in parents and trashed = false`);
      url.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,size,md5Checksum,thumbnailLink,hasThumbnail,createdTime,resourceKey,imageMediaMetadata(time))');
      url.searchParams.set('pageSize', '1000');
      url.searchParams.set('supportsAllDrives', 'true');
      url.searchParams.set('includeItemsFromAllDrives', 'true');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const keys = folder.resourceKey ? [`${folder.id}/${folder.resourceKey}`] : [];
      const res = await driveFetch(ctx, url, { resourceKeys: keys });
      const j = await res.json();
      for (const f of j.files || []) {
        if (f.mimeType === FOLDER_MIME) {
          queue.push({ id: f.id, path: folder.path ? `${folder.path}/${f.name}` : f.name, resourceKey: f.resourceKey });
        } else if ((f.mimeType || '').startsWith('image/') || IMAGE_EXT.test(f.name)) {
          out.push({
            id: f.id,
            name: f.name,
            mime: f.mimeType,
            size: f.size ? Number(f.size) : null,
            checksum: f.md5Checksum || null,
            thumbnailLink: f.thumbnailLink || null,
            resourceKey: f.resourceKey || null,
            takenAt: parseExifTime(f.imageMediaMetadata && f.imageMediaMetadata.time) || f.createdTime || null,
            path: folder.path,
          });
        }
      }
      if (onProgress) onProgress(out.length);
      pageToken = j.nextPageToken;
    } while (pageToken);
  }
  return out;
}

function parseExifTime(t) {
  if (!t) return null;
  const m = String(t).match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}

async function getFileMeta(ctx, fileId, resourceKey) {
  const url = withKey(ctx, new URL(`${API}/files/${encodeURIComponent(fileId)}`));
  url.searchParams.set('fields', 'id,thumbnailLink,mimeType');
  url.searchParams.set('supportsAllDrives', 'true');
  const res = await driveFetch(ctx, url, { resourceKeys: resourceKey ? [`${fileId}/${resourceKey}`] : [] });
  return res.json();
}

// Ambil gambar sumber untuk pratinjau. Utamakan thumbnailLink (murah, tidak mengunduh file asli);
// thumbnailLink hanya berlaku beberapa jam, jadi minta yang baru lewat files.get bila perlu.
async function fetchImage(ctx, file, size) {
  const meta = await getFileMeta(ctx, file.drive_file_id, file.resource_key);
  if (meta.thumbnailLink) {
    const link = meta.thumbnailLink.replace(/=s\d+(-[a-z0-9-]+)?$/i, `=s${size}`);
    const headers = await authHeaders(ctx);
    const res = await fetch(link, { headers: headers.authorization ? { authorization: headers.authorization } : {} });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
  }
  // Fallback: unduh file asli (200 unit kuota). Hanya untuk format yang bisa dibaca sharp.
  if (!/^image\/(jpeg|png|webp|tiff|gif|heic|heif)$/i.test(meta.mimeType || '')) {
    throw new DriveError('Pratinjau tidak tersedia untuk format ini.', 'no_thumbnail');
  }
  const url = withKey(ctx, new URL(`${API}/files/${encodeURIComponent(file.drive_file_id)}`));
  url.searchParams.set('alt', 'media');
  url.searchParams.set('supportsAllDrives', 'true');
  const res = await driveFetch(ctx, url, { resourceKeys: file.resource_key ? [`${file.drive_file_id}/${file.resource_key}`] : [] });
  return Buffer.from(await res.arrayBuffer());
}

// F-51: bagikan folder yang dipilih lewat Google Picker ke service account (Viewer), memakai token drive.file milik studio.
async function shareFolderWithServiceAccount(userAccessToken, folderId) {
  const email = serviceAccountEmail();
  if (!email) throw new DriveError('Service account belum dikonfigurasi.', 'no_sa');
  const url = new URL(`${API}/files/${encodeURIComponent(folderId)}/permissions`);
  url.searchParams.set('sendNotificationEmail', 'false');
  url.searchParams.set('supportsAllDrives', 'true');
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${userAccessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'user', emailAddress: email }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new DriveError((j.error && j.error.message) || `Gagal membagikan folder (HTTP ${res.status})`, 'share_failed', res.status);
  }
  return true;
}

// F-42: salin file terpilih ke subfolder "Terpilih" (butuh service account sebagai Editor folder)
async function writeFetch(url, opts = {}, attempt = 0) {
  const token = await saAccessToken('https://www.googleapis.com/auth/drive');
  const res = await fetch(url, { ...opts, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(opts.headers || {}) } });
  if (res.ok) return res.json();
  const j = await res.json().catch(() => ({}));
  const reason = j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason;
  if ((res.status === 429 || res.status >= 500 || /rateLimit/i.test(reason || '')) && attempt < 5) {
    await sleep(500 * 2 ** attempt);
    return writeFetch(url, opts, attempt + 1);
  }
  throw new DriveError((j.error && j.error.message) || `HTTP ${res.status}`, reason || 'http_' + res.status, res.status);
}
async function ensureSubfolder(parentId, name) {
  const q = new URL(`${API}/files`);
  q.searchParams.set('q', `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME}' and trashed = false`);
  q.searchParams.set('fields', 'files(id)');
  q.searchParams.set('supportsAllDrives', 'true');
  q.searchParams.set('includeItemsFromAllDrives', 'true');
  const found = await writeFetch(q.toString());
  if (found.files && found.files[0]) return found.files[0].id;
  const c = new URL(`${API}/files`);
  c.searchParams.set('supportsAllDrives', 'true');
  const f = await writeFetch(c.toString(), { method: 'POST', body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }) });
  return f.id;
}
async function copyFile(fileId, parentId, name) {
  const u = new URL(`${API}/files/${encodeURIComponent(fileId)}/copy`);
  u.searchParams.set('supportsAllDrives', 'true');
  return writeFetch(u.toString(), { method: 'POST', body: JSON.stringify({ parents: [parentId], name }) });
}

module.exports = {
  ensureSubfolder, copyFile,
  DriveError, parseFolderLink, checkAccess, listImages, fetchImage,
  shareFolderWithServiceAccount, serviceAccountEmail, IMAGE_EXT,
};
