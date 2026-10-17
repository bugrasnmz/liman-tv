/**
 * Liman TV — Xtream Codes hesabı için hafif web oynatıcı sunucusu.
 *
 * Görevleri:
 *  - Xtream kimlik bilgilerini sunucuda tutar; tarayıcıya asla göndermez.
 *  - player_api.php çağrılarını önbellekleyip sadeleştirilmiş JSON olarak sunar.
 *  - Canlı yayınları (MPEG-TS ve HLS) aynı origin üzerinden proxy'ler;
 *    böylece CORS ve HTTPS/HTTP "mixed content" sorunları ortadan kalkar.
 *  - İsteğe bağlı şifre ile arayüzü korur.
 *
 * Harici runtime bağımlılığı yoktur (Node >= 20.12).
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* .env yoksa ortam değişkenleri kullanılır */
}

/* ────────────────────────────── Yapılandırma ────────────────────────────── */

function parseXtreamConfig() {
  let raw = (process.env.XTREAM_URL || '').trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  const url = new URL(raw);
  // M3U linki (get.php?username=..&password=..) yapıştırıldıysa bilgileri oradan al.
  const user = (process.env.XTREAM_USERNAME || '').trim() || url.searchParams.get('username') || '';
  const pass = (process.env.XTREAM_PASSWORD || '').trim() || url.searchParams.get('password') || '';
  return { base: url.origin, user, pass };
}

const XT = parseXtreamConfig();
if (!XT || !XT.user || !XT.pass) {
  console.error('\n✖ XTREAM_URL, XTREAM_USERNAME ve XTREAM_PASSWORD tanımlı olmalı.');
  console.error('  .env.example dosyasını .env olarak kopyalayıp doldurman yeterli.\n');
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
if (process.env.NODE_ENV === 'production' && APP_PASSWORD.length < 12) {
  console.error('Üretimde APP_PASSWORD en az 12 karakter olmalı.');
  process.exit(1);
}
const CACHE_TTL = (Number(process.env.CACHE_TTL_MINUTES) || 10) * 60_000;
const USER_AGENT = process.env.USER_AGENT || 'VLC/3.0.20 LibVLC/3.0.20';
const SESSION_DAYS = 30;
const SECRET =
  process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update(`${XT.base}|${XT.user}|${XT.pass}|${APP_PASSWORD}`).digest('hex');

const VENDOR_FILES = {
  '/vendor/hls.min.js': 'node_modules/hls.js/dist/hls.min.js',
  '/vendor/mpegts.min.js': 'node_modules/mpegts.js/dist/mpegts.js',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/* ────────────────────────────── Yardımcılar ────────────────────────────── */

const hmac = (value) => crypto.createHmac('sha256', SECRET).update(value).digest('base64url');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Sağlayıcı adreslerini gizle; token yalnızca üretildiği rota için geçerlidir. */
const PROXY_KEY = crypto.createHash('sha256').update(`proxy:${SECRET}`).digest();
function signUrl(route, target) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', PROXY_KEY, iv);
  cipher.setAAD(Buffer.from(route));
  const encrypted = Buffer.concat([cipher.update(target, 'utf8'), cipher.final()]);
  const token = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  return `${route}?token=${token}`;
}

function verifySigned(route, params) {
  try {
    const token = params.get('token');
    if (!token || token.length > 16384) return null;
    const data = Buffer.from(token, 'base64url');
    if (data.length < 29) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', PROXY_KEY, data.subarray(0, 12));
    decipher.setAAD(Buffer.from(route));
    decipher.setAuthTag(data.subarray(12, 28));
    const target = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    return /^https?:\/\//i.test(target) ? target : null;
  } catch {
    return null;
  }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

function sendJson(res, status, data, headers = {}) {
  if (res.headersSent) return res.end();
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* bozuk cookie'yi yok say */
    }
  }
  return out;
}

async function readJsonBody(req, limit = 4096) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, 'İstek çok büyük');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    throw httpError(400, 'Geçersiz istek');
  }
}

const normalize = (s) =>
  String(s || '')
    .toLocaleLowerCase('tr')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/ı/g, 'i');

function decodeBase64Text(value) {
  if (!value) return '';
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    // Base64 olmayan düz metinlerde anlamsız karakterler çıkarsa orijinali kullan.
    return /\uFFFD/.test(text) ? value : text;
  } catch {
    return value;
  }
}

function clientIp(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '').trim();
}

/* ────────────────────────────── Oturum ────────────────────────────── */

const COOKIE = 'liman_session';

function createSessionCookie(req) {
  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  return [
    `${COOKIE}=${exp}.${hmac(`session:${exp}`)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 86_400}`,
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

function isAuthed(req) {
  if (!APP_PASSWORD) return true;
  const raw = parseCookies(req)[COOKIE];
  if (!raw) return false;
  const [exp, sig] = raw.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, hmac(`session:${exp}`));
}

const loginAttempts = new Map();
function isRateLimited(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.reset) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= 10;
}
function recordFailedLogin(ip) {
  const entry = loginAttempts.get(ip) || { count: 0, reset: Date.now() + 15 * 60_000 };
  entry.count += 1;
  loginAttempts.set(ip, entry);
}

/* ────────────────────────────── Sağlayıcı erişimi ────────────────────────────── */

/**
 * fetch sarmalayıcı. `timeout` yalnızca yanıt başlıklarına kadar geçerlidir;
 * böylece uzun süren canlı yayın gövdesi kesilmez.
 */
async function upstream(url, { signal, timeout = 20_000 } = {}) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(new Error('Sağlayıcı zaman aşımı')), timeout);
  try {
    return await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
    });
  } catch (err) {
    // URL ve sağlayıcı kimlik bilgilerini loglama.
    console.warn('[upstream]', JSON.stringify({
      error: err.name, code: err.cause?.code || err.code || null,
      causes: err.cause?.errors?.map(e => e.code),
      aborted: ctrl.signal.aborted,
    }));
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function xtApi(params = {}) {
  const url = new URL('/player_api.php', XT.base);
  url.searchParams.set('username', XT.user);
  url.searchParams.set('password', XT.pass);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  let res;
  try {
    res = await upstream(url, { signal: AbortSignal.timeout(60_000) });
  } catch {
    throw httpError(502, 'Sağlayıcıya ulaşılamadı');
  }
  if (!res.ok) throw httpError(502, `Sağlayıcı ${res.status} yanıtı döndürdü`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(502, 'Sağlayıcıdan beklenmeyen bir yanıt geldi');
  }
}

/** Basit önbellek: süresi dolunca eski veriyi sunar, arkada tazeler (stale-while-revalidate). */
const cache = new Map();
function cached(key, ttl, loader) {
  let entry = cache.get(key);
  if (!entry) cache.set(key, (entry = {}));
  if (entry.value !== undefined && entry.expires > Date.now()) return Promise.resolve(entry.value);

  if (!entry.pending) {
    entry.pending = loader()
      .then((value) => {
        entry.value = value;
        entry.expires = Date.now() + ttl;
        return value;
      })
      .finally(() => {
        entry.pending = null;
      });
  }
  if (entry.value !== undefined) {
    entry.pending.catch((err) => console.warn(`[cache] ${key} tazelenemedi:`, err.message));
    return Promise.resolve(entry.value);
  }
  return entry.pending;
}

/* ────────────────────────────── Katalog ────────────────────────────── */

function getLiveCatalog() {
  return cached('live', CACHE_TTL, async () => {
    const [rawCats, rawStreams] = await Promise.all([
      xtApi({ action: 'get_live_categories' }),
      xtApi({ action: 'get_live_streams' }),
    ]);
    const cats = Array.isArray(rawCats) ? rawCats : [];
    const streams = Array.isArray(rawStreams) ? rawStreams : [];

    const byId = new Map();
    const byCat = new Map();
    const index = [];

    streams.forEach((s, i) => {
      const id = Number(s.stream_id);
      if (!Number.isFinite(id)) return;
      const icon = typeof s.stream_icon === 'string' ? s.stream_icon.trim() : '';
      const item = {
        id,
        num: Number(s.num) || i + 1,
        name: String(s.name ?? '').trim() || `Kanal ${id}`,
        logo: /^https?:\/\//i.test(icon) ? signUrl('/img', icon) : null,
        cat: String(s.category_id ?? ''),
        archive: Number(s.tv_archive) === 1,
      };
      byId.set(id, item);
      if (!byCat.has(item.cat)) byCat.set(item.cat, []);
      byCat.get(item.cat).push(item);
      index.push([normalize(item.name), item]);
    });

    const categories = [];
    const known = new Set();
    for (const c of cats) {
      const id = String(c.category_id);
      known.add(id);
      const count = byCat.get(id)?.length || 0;
      if (count) categories.push({ id, name: String(c.category_name || '').trim() || 'Adsız', count });
    }
    const orphans = [...byCat.keys()].filter((id) => !known.has(id));
    if (orphans.length) {
      const items = orphans.flatMap((id) => byCat.get(id));
      byCat.set('__other', items);
      items.forEach((it) => (it.cat = '__other'));
      categories.push({ id: '__other', name: 'Diğer', count: items.length });
    }

    console.log(`[katalog] ${categories.length} kategori, ${byId.size} kanal yüklendi`);
    return { categories, byId, byCat, index, total: byId.size, loadedAt: Date.now() };
  });
}

/* ────────────────────────────── API işleyicileri ────────────────────────────── */

async function handleAccount(res) {
  const data = await cached('account', 60_000, () => xtApi());
  const u = data?.user_info || {};
  sendJson(res, 200, {
    status: u.status || 'Bilinmiyor',
    expiresAt: u.exp_date ? Number(u.exp_date) * 1000 : null,
    maxConnections: Number(u.max_connections) || null,
    activeConnections: Number(u.active_cons) || 0,
    trial: u.is_trial === '1' || u.is_trial === 1,
  });
}

async function handleCategories(res) {
  const cat = await getLiveCatalog();
  sendJson(res, 200, { total: cat.total, categories: cat.categories, loadedAt: cat.loadedAt });
}

async function handleStreams(res, params) {
  const cat = await getLiveCatalog();
  const ids = params.get('ids');
  const q = normalize(params.get('q')).trim();
  const category = params.get('category');

  let items;
  if (ids) {
    items = ids
      .split(',')
      .map((v) => cat.byId.get(Number(v)))
      .filter(Boolean);
  } else if (q) {
    const terms = q.split(/\s+/);
    items = [];
    for (const [name, item] of cat.index) {
      if (category && category !== 'all' && item.cat !== category) continue;
      if (terms.every((t) => name.includes(t))) items.push(item);
      if (items.length >= 500) break;
    }
  } else if (category && category !== 'all') {
    items = cat.byCat.get(category) || [];
  } else {
    items = cat.index.map(([, item]) => item);
  }
  sendJson(res, 200, { count: items.length, items });
}

async function handleEpg(res, id) {
  const data = await cached(`epg:${id}`, 120_000, () =>
    xtApi({ action: 'get_short_epg', stream_id: id, limit: 8 }),
  );
  const now = Date.now();
  const listings = (Array.isArray(data?.epg_listings) ? data.epg_listings : [])
    .map((l) => ({
      title: decodeBase64Text(l.title),
      desc: decodeBase64Text(l.description),
      start: Number(l.start_timestamp) * 1000,
      end: Number(l.stop_timestamp) * 1000,
    }))
    .filter((l) => l.start && l.end > now)
    .sort((a, b) => a.start - b.start)
    .slice(0, 5);
  sendJson(res, 200, { listings });
}

/* ────────────────────────────── Yayın proxy ────────────────────────────── */

function upstreamFailure(res, status) {
  console.warn('[upstream] HTTP', status);
  if (status === 401 || status === 403) {
    return sendJson(res, 403, {
      error: 'Sağlayıcı yayını reddetti. Bağlantı sınırı dolmuş ya da hesap süresi bitmiş olabilir.',
    });
  }
  if (status === 404) return sendJson(res, 404, { error: 'Bu yayın sağlayıcıda bulunamadı.' });
  return sendJson(res, 502, { error: `Sağlayıcı ${status} yanıtı döndürdü.` });
}

/** Sağlayıcıdan gelen akışı istemciye aktarır; istemci ayrılınca sağlayıcı bağlantısını da keser. */
async function pipeUpstream(res, url, { contentType, cacheControl = 'no-store' } = {}) {
  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());

  let up;
  try {
    up = await upstream(url, { signal: ctrl.signal, timeout: 15_000 });
  } catch {
    if (!ctrl.signal.aborted) sendJson(res, 502, { error: 'Yayına ulaşılamadı.' });
    return;
  }
  if (!up.ok || !up.body) {
    up.body?.cancel().catch(() => {});
    return upstreamFailure(res, up.status);
  }

  const headers = {
    'Content-Type': contentType || up.headers.get('content-type') || 'application/octet-stream',
    'Cache-Control': cacheControl,
  };
  const len = up.headers.get('content-length');
  if (len && !contentType?.includes('mp2t')) headers['Content-Length'] = len;
  res.writeHead(200, headers);

  try {
    await pipeline(Readable.fromWeb(up.body), res);
  } catch {
    /* istemci kanalı değiştirdi ya da sayfayı kapattı */
  }
}

function rewritePlaylist(text, baseUrl) {
  const proxify = (ref, forcePlaylist) => {
    if (/^(data|skd):/i.test(ref)) return ref;
    const abs = new URL(ref, baseUrl);
    const isPlaylist = forcePlaylist || /\.m3u8?$/i.test(abs.pathname);
    return signUrl(isPlaylist ? '/hls/pl' : '/hls/seg', abs.href);
  };

  let nextIsPlaylist = false;
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        if (t.startsWith('#EXT-X-STREAM-INF')) nextIsPlaylist = true;
        const attrIsPlaylist = /^#EXT-X-(MEDIA|I-FRAME-STREAM-INF)/.test(t);
        return t.replace(/URI="([^"]+)"/g, (_, ref) => `URI="${proxify(ref, attrIsPlaylist)}"`);
      }
      const out = proxify(t, nextIsPlaylist);
      nextIsPlaylist = false;
      return out;
    })
    .join('\n');
}

async function servePlaylist(res, url) {
  let up;
  try {
    up = await upstream(url, { signal: AbortSignal.timeout(20_000), timeout: 15_000 });
  } catch {
    return sendJson(res, 502, { error: 'Yayın listesine ulaşılamadı.' });
  }
  if (!up.ok) return upstreamFailure(res, up.status);
  const text = await up.text();
  if (!text.trimStart().startsWith('#EXTM3U')) {
    console.warn('[upstream] invalid-playlist', JSON.stringify({status: up.status, type: up.headers.get('content-type'), length: text.length, html: /<(?:html|!doctype)/i.test(text)}));
    return sendJson(res, 502, { error: 'Sağlayıcı geçerli bir HLS listesi döndürmedi.' });
  }
  res.writeHead(200, {
    'Content-Type': 'application/vnd.apple.mpegurl',
    'Cache-Control': 'no-store',
  });
  res.end(rewritePlaylist(text, up.url || url));
}

async function serveImage(res, url) {
  let up;
  try {
    up = await upstream(url, { signal: AbortSignal.timeout(12_000), timeout: 8_000 });
  } catch {
    return sendJson(res, 404, { error: 'Logo alınamadı' });
  }
  const type = up.headers.get('content-type') || '';
  if (!up.ok || !(type.startsWith('image/') || type.includes('octet-stream') || !type)) {
    up.body?.cancel().catch(() => {});
    return sendJson(res, 404, { error: 'Logo alınamadı' });
  }
  const buf = Buffer.from(await up.arrayBuffer());
  if (buf.length > 3 * 1024 * 1024) return sendJson(res, 413, { error: 'Logo çok büyük' });
  res.writeHead(200, {
    'Content-Type': type.startsWith('image/') ? type : 'image/png',
    'Content-Length': buf.length,
    'Cache-Control': 'private, max-age=86400',
  });
  res.end(buf);
}

/* ────────────────────────────── Statik dosyalar ────────────────────────────── */

async function serveStatic(req, res, pathname) {
  let file;
  let cacheControl = 'no-cache';
  if (VENDOR_FILES[pathname]) {
    file = path.join(ROOT, VENDOR_FILES[pathname]);
    cacheControl = 'public, max-age=604800';
  } else {
    let rel;
    try {
      rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    } catch {
      return sendJson(res, 400, { error: 'Geçersiz yol' });
    }
    file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'Bulunamadı' });
  }

  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': cacheControl,
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  } catch {
    sendJson(res, 404, { error: 'Bulunamadı' });
  }
}

/* ────────────────────────────── Yönlendirici ────────────────────────────── */

const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "script-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'self'",
].join('; ');

const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', CSP);

  try {
    if (pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      return sendJson(res, 200, { ok: true });
    }

    /* — Oturum uçları (giriş gerektirmez) — */
    if (pathname === '/api/session') {
      return sendJson(res, 200, { authRequired: Boolean(APP_PASSWORD), authed: isAuthed(req) });
    }
    if (pathname === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req);
      if (isRateLimited(ip)) return sendJson(res, 429, { error: 'Biraz dinlen; birkaç dakika sonra tekrar dene.' });
      const { password } = await readJsonBody(req);
      if (!APP_PASSWORD || safeEqual(hmac(String(password || '')), hmac(APP_PASSWORD))) {
        loginAttempts.delete(ip);
        return sendJson(res, 200, { ok: true }, { 'Set-Cookie': createSessionCookie(req) });
      }
      recordFailedLogin(ip);
      return sendJson(res, 401, { error: 'Şifre eşleşmedi.' });
    }
    if (pathname === '/api/logout' && req.method === 'POST') {
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax` });
    }

    /* — Koruma altındaki uçlar — */
    const protectedRoute =
      pathname.startsWith('/api/') || pathname.startsWith('/live/') || pathname.startsWith('/hls/') || pathname === '/img';
    if (protectedRoute && !isAuthed(req)) return sendJson(res, 401, { error: 'Oturum gerekli' });

    if (pathname === '/api/refresh' && req.method === 'POST') {
      cache.clear();
      await getLiveCatalog();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Desteklenmeyen istek' });

    if (pathname === '/api/account') return await handleAccount(res);
    const diagnostic = pathname.match(/^\/api\/diagnostics\/(\d+)$/);
    if (diagnostic) {
      const results = [];
      for (const ext of ['m3u8', 'ts']) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        const started = Date.now();
        try {
          const target = `${XT.base}/live/${encodeURIComponent(XT.user)}/${encodeURIComponent(XT.pass)}/${diagnostic[1]}.${ext}`;
          const up = await upstream(target, { signal: ctrl.signal, timeout: 12000 });
          const reader = up.body?.getReader();
          const first = reader ? await reader.read() : null;
          const sample = new TextDecoder().decode(first?.value);
          const isHtml = /<(?:html|!doctype)/i.test(sample);
          const redact = value => [XT.user, XT.pass, APP_PASSWORD].filter(Boolean).reduce((s, secret) => s.split(secret).join('[redacted]'), value).replace(/https?:\/\/[^\s<>"']+/g, '[url]');
          const htmlMessage = isHtml ? redact(sample.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 700) : null;
          results.push({ format: ext, status: up.status, type: up.headers.get('content-type'), message: htmlMessage,
            bytes: first?.value?.length || 0, playlist: sample.trimStart().startsWith('#EXTM3U'),
            html: /<(?:html|!doctype)/i.test(sample), elapsed: Date.now() - started });
          await reader?.cancel();
        } catch (err) {
          results.push({format: ext, error: err.name, code: err.cause?.code || null, elapsed: Date.now() - started});
        } finally {
          clearTimeout(timer);
          ctrl.abort();
        }
      }
      return sendJson(res, 200, { results });
    }
    if (pathname === '/api/live/categories') return await handleCategories(res);
    if (pathname === '/api/live/streams') return await handleStreams(res, searchParams);

    let m = pathname.match(/^\/api\/epg\/(\d+)$/);
    if (m) return await handleEpg(res, m[1]);

    m = pathname.match(/^\/live\/(\d+)\.(ts|m3u8)$/);
    if (m) {
      const [, id, ext] = m;
      const target = `${XT.base}/live/${encodeURIComponent(XT.user)}/${encodeURIComponent(XT.pass)}/${id}.${ext}`;
      console.log(`[yayın] ${id}.${ext} ← ${clientIp(req)}`);
      return ext === 'ts'
        ? await pipeUpstream(res, target, { contentType: 'video/mp2t' })
        : await servePlaylist(res, target);
    }

    if (pathname === '/hls/pl' || pathname === '/hls/seg' || pathname === '/img') {
      const target = verifySigned(pathname, searchParams);
      if (!target) return sendJson(res, 403, { error: 'Geçersiz bağlantı' });
      if (pathname === '/hls/pl') return await servePlaylist(res, target);
      if (pathname === '/img') return await serveImage(res, target);
      return await pipeUpstream(res, target, { cacheControl: 'private, max-age=30' });
    }

    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Bulunamadı' });
    return await serveStatic(req, res, pathname);
  } catch (err) {
    if (!err.expose) console.error('[hata]', err);
    if (res.headersSent) return res.destroy();
    sendJson(res, err.status || 500, { error: err.expose ? err.message : 'Beklenmeyen bir hata oluştu.' });
  }
});

server.listen(PORT, HOST, () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${PORT}`);
  console.log('\n  Liman TV hazır.\n');
  console.log(`  Bu cihazda : http://localhost:${PORT}`);
  lan.forEach((u) => console.log(`  Yerel ağda : ${u}`));
  console.log(`  Giriş      : ${APP_PASSWORD ? 'şifre korumalı' : 'AÇIK (APP_PASSWORD tanımlı değil)'}\n`);
  // Kataloğu önceden ısıt; ilk açılış hızlı olsun.
  getLiveCatalog().catch((e) => console.warn('[katalog] ilk yükleme başarısız:', e.message));
});
