// aviram.app — Worker for the Depth Reel site.
//   /api/*    JSON API (site content, admin login, uploads to R2)
//   /media/*  videos stored in R2, served with HTTP Range support (needed by iPhone Safari)
//   anything else → static files in ./public
//
// Bindings (wrangler.jsonc): MEDIA (R2 bucket), DB (D1, visit stats), ASSETS (static files)
// Secrets: ADMIN_PASSWORD (required for /admin), SESSION_SECRET (optional, rotates logins)

const SITE_KEY = 'content/site.json';
const HISTORY_PREFIX = 'content/history/';
const MEDIA_PREFIX = 'media/';
const COOKIE = 'aviram_admin';
const SESSION_DAYS = 14;
const enc = new TextEncoder();

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path.startsWith('/api/')) return await api(req, env, url);
      if (path.startsWith('/media/')) return await serveMedia(req, env, decodeURIComponent(path.slice(1)));
      if (path.startsWith('/videos/')) return await serveBundledVideo(req, env, url);
      return env.ASSETS.fetch(req);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Something went wrong on the server.' }, 500);
    }
  },
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ------------------------------------------------------------------ API */

async function api(req, env, url) {
  const route = `${req.method} ${url.pathname}`;

  // public
  if (route === 'GET /api/site') return json(await readSite(env, url.origin), 200, { 'cache-control': 'no-store' });
  if (route === 'GET /api/me') return json({ admin: await isAdmin(req, env), configured: !!env.ADMIN_PASSWORD });
  if (route === 'POST /api/login') return login(req, env);
  if (route === 'POST /api/visit') return visitStart(req, env);
  if (route === 'POST /api/visit/beat') return visitBeat(req, env);
  if (route === 'POST /api/logout') return json({ ok: true }, 200, { 'set-cookie': cookie('', 0) });

  // everything below needs an admin session + the CSRF header
  if (!(await isAdmin(req, env))) throw new HttpError(401, 'Not logged in.');
  if (req.method !== 'GET' && req.headers.get('x-aviram') !== '1') throw new HttpError(403, 'Missing request header.');

  if (route === 'PUT /api/site') return saveSite(req, env);
  if (route === 'GET /api/stats') return stats(env, url.searchParams);
  if (route === 'GET /api/media') return listMedia(env);
  if (route === 'DELETE /api/media') return deleteMedia(env, url.searchParams.get('key'));
  if (route === 'POST /api/uploads') return startUpload(req, env);
  if (route === 'PUT /api/uploads/part') return uploadPart(req, env, url.searchParams);
  if (route === 'POST /api/uploads/complete') return completeUpload(req, env);
  if (route === 'POST /api/uploads/abort') return abortUpload(req, env);
  if (route === 'POST /api/migrate') return migrateBundled(req, env, url.origin);

  throw new HttpError(404, 'No such endpoint.');
}

/* ---------------------------------------------------------- site content */

async function readSite(env, origin) {
  const obj = await env.MEDIA.get(SITE_KEY);
  if (obj) return obj.json();
  // First run: fall back to the defaults shipped with the site.
  const res = await env.ASSETS.fetch(new Request(origin + '/site.default.json'));
  if (!res.ok) throw new HttpError(500, 'Default content is missing.');
  return res.json();
}

async function saveSite(req, env) {
  const text = await req.text();
  if (text.length > 512 * 1024) throw new HttpError(413, 'Content is too large.');
  let site;
  try { site = JSON.parse(text); } catch { throw new HttpError(400, 'Content is not valid JSON.'); }
  const clean = validateSite(site);
  const body = JSON.stringify(clean, null, 2);
  const meta = { httpMetadata: { contentType: 'application/json' } };
  await env.MEDIA.put(SITE_KEY, body, meta);
  // keep every saved version, so a bad edit can be rolled back from the R2 dashboard
  await env.MEDIA.put(`${HISTORY_PREFIX}${new Date().toISOString()}.json`, body, meta);
  return json({ ok: true, site: clean });
}

const str = (v, max = 400) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max).trim();
const safeUrl = (v) => {
  const s = str(v, 600);
  if (!s) return '';
  if (/^(https?:\/\/|mailto:)/i.test(s)) return s;
  throw new HttpError(400, `Links must start with https:// — got "${s}".`);
};
const safeVideo = (v) => {
  const s = str(v, 600);
  if (!s) return '';
  if (/^\/(media|videos)\/[\w./-]+$/.test(s) || /^https:\/\//i.test(s)) return s;
  throw new HttpError(400, `Unexpected video path "${s}".`);
};
const SCENES = ['hero', 'runner', 'spiral', 'bust', 'skyline', 'tunnel', 'field', 'grid', 'pickle', 'pulse'];
const scene = (v, d) => (SCENES.includes(v) ? v : d);

function validateSite(s) {
  if (!s || typeof s !== 'object') throw new HttpError(400, 'Content must be an object.');
  const projects = Array.isArray(s.projects) ? s.projects : [];
  const apps = Array.isArray(s.apps) ? s.apps : [];
  const links = Array.isArray(s.links) ? s.links : [];
  if (projects.length > 60 || apps.length > 30 || links.length > 20) throw new HttpError(400, 'Too many items.');
  return {
    name: str(s.name, 80) || 'OMER AVIRAM',
    role: str(s.role, 120),
    base: str(s.base, 120),
    about: str(s.about, 1200),
    email: str(s.email, 200),
    links: links.map((l) => ({ label: str(l.label, 40), url: safeUrl(l.url) })).filter((l) => l.label && l.url),
    projects: projects.map((p) => ({
      title: str(p.title, 120) || 'Untitled',
      client: str(p.client, 120),
      year: str(p.year, 12),
      role: str(p.role, 120),
      runtime: str(p.runtime, 12),
      format: str(p.format, 12),
      blurb: str(p.blurb, 600),
      scene: scene(p.scene, 'runner'),
      video: safeVideo(p.video),
    })),
    apps: apps.map((a) => ({
      name: str(a.name, 80) || 'Untitled',
      line: str(a.line, 300),
      tag: str(a.tag, 40),
      url: safeUrl(a.url),
      scene: scene(a.scene, 'grid'),
    })),
  };
}

/* ------------------------------------------------------------- uploads */

const slug = (name) =>
  str(name, 120).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'clip';
const ext = (name) => (/\.(mp4|mov|m4v|webm)$/i.exec(name || '') || [, 'mp4'])[1].toLowerCase();
const mediaKey = (key) => {
  if (typeof key !== 'string' || !key.startsWith(MEDIA_PREFIX) || key.includes('..')) throw new HttpError(400, 'Bad key.');
  return key;
};

async function startUpload(req, env) {
  const { name, type } = await req.json();
  if (type && !/^video\//.test(type)) throw new HttpError(400, 'Only video files can be uploaded.');
  const key = `${MEDIA_PREFIX}${Date.now().toString(36)}-${slug(name)}.${ext(name)}`;
  const mpu = await env.MEDIA.createMultipartUpload(key, {
    httpMetadata: { contentType: type || 'video/mp4', cacheControl: 'public, max-age=31536000, immutable' },
  });
  return json({ key: mpu.key, uploadId: mpu.uploadId });
}

async function uploadPart(req, env, q) {
  const key = mediaKey(q.get('key'));
  const uploadId = q.get('uploadId');
  const n = Number(q.get('n'));
  if (!uploadId || !Number.isInteger(n) || n < 1 || n > 10000) throw new HttpError(400, 'Bad part.');
  if (!req.body) throw new HttpError(400, 'Empty part.');
  const part = await env.MEDIA.resumeMultipartUpload(key, uploadId).uploadPart(n, req.body);
  return json(part);
}

async function completeUpload(req, env) {
  const { key, uploadId, parts } = await req.json();
  const obj = await env.MEDIA.resumeMultipartUpload(mediaKey(key), uploadId).complete(parts);
  return json({ key: obj.key, url: '/' + obj.key, size: obj.size });
}

async function abortUpload(req, env) {
  const { key, uploadId } = await req.json();
  try { await env.MEDIA.resumeMultipartUpload(mediaKey(key), uploadId).abort(); } catch {}
  return json({ ok: true });
}

// Copy a video bundled with the site (public/videos/*) into R2, so it gets Range support.
async function migrateBundled(req, env, origin) {
  const { path } = await req.json();
  if (typeof path !== 'string' || !/^\/videos\/[\w.-]+\.mp4$/.test(path)) throw new HttpError(400, 'Bad path.');
  const res = await env.ASSETS.fetch(new Request(origin + path));
  if (!res.ok) throw new HttpError(404, `${path} is not in the site bundle.`);
  const key = `${MEDIA_PREFIX}${path.split('/').pop()}`;
  await env.MEDIA.put(key, await res.arrayBuffer(), {
    httpMetadata: { contentType: 'video/mp4', cacheControl: 'public, max-age=31536000, immutable' },
  });
  return json({ key, url: '/' + key });
}

async function listMedia(env) {
  const items = [];
  let cursor;
  do {
    const page = await env.MEDIA.list({ prefix: MEDIA_PREFIX, cursor, limit: 1000 });
    for (const o of page.objects) items.push({ key: o.key, url: '/' + o.key, size: o.size, uploaded: o.uploaded });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return json({ items });
}

async function deleteMedia(env, key) {
  await env.MEDIA.delete(mediaKey(key));
  return json({ ok: true });
}

/* ----------------------------------------------- bundled videos + Range */
// Static-asset serving stalls on Range requests, which every <video> makes.
// Fetch the whole file from ASSETS (no Range) and slice it here.
async function serveBundledVideo(req, env, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
  const res = await env.ASSETS.fetch(new Request(url.origin + url.pathname, { method: 'GET' }));
  if (!res.ok) return res;
  const headers = new Headers({
    'content-type': res.headers.get('content-type') || 'video/mp4',
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=300, must-revalidate',
  });
  const etag = res.headers.get('etag');
  if (etag) headers.set('etag', etag);
  const rh = req.headers.get('range');
  const len = Number(res.headers.get('content-length'));
  if (req.method === 'HEAD' && len) { res.body?.cancel(); headers.set('content-length', String(len)); return new Response(null, { headers }); }
  const buf = await res.arrayBuffer();
  const size = buf.byteLength;
  if (req.method === 'HEAD') { headers.set('content-length', String(size)); return new Response(null, { headers }); }
  const m = rh && /^bytes=(\d*)-(\d*)$/.exec(rh.trim());
  if (m && (m[1] || m[2])) {
    let start, end;
    if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
    else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
    if (start >= size || start > end) { headers.set('content-range', `bytes */${size}`); return new Response('Range not satisfiable', { status: 416, headers }); }
    headers.set('content-range', `bytes ${start}-${end}/${size}`);
    headers.set('content-length', String(end - start + 1));
    return new Response(buf.slice(start, end + 1), { status: 206, headers });
  }
  headers.set('content-length', String(size));
  return new Response(buf, { headers });
}

/* --------------------------------------------------------- media + Range */

async function serveMedia(req, env, key) {
  if (!key.startsWith(MEDIA_PREFIX) || key.includes('..')) return new Response('Not found', { status: 404 });
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });

  const head = await env.MEDIA.head(key);
  if (!head) return new Response('Not found', { status: 404 });
  const size = head.size;

  const headers = new Headers();
  head.writeHttpMetadata(headers);
  headers.set('etag', head.httpEtag);
  headers.set('accept-ranges', 'bytes');
  if (!headers.has('cache-control')) headers.set('cache-control', 'public, max-age=31536000, immutable');

  // Conditional GET: let browsers reuse their cached copy.
  const inm = req.headers.get('if-none-match');
  if (inm && inm.split(/\s*,\s*/).includes(head.httpEtag)) return new Response(null, { status: 304, headers });

  // Parse a single "bytes=a-b" / "bytes=a-" / "bytes=-n" range.
  const rh = req.headers.get('range');
  let range = null;
  if (rh) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rh.trim());
    if (m && (m[1] || m[2])) {
      let start, end;
      if (m[1] === '') { const n = Number(m[2]); start = Math.max(0, size - n); end = size - 1; }
      else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
      if (start >= size || start > end) {
        headers.set('content-range', `bytes */${size}`);
        return new Response('Range not satisfiable', { status: 416, headers });
      }
      range = { offset: start, length: end - start + 1 };
    }
  }

  if (req.method === 'HEAD') {
    headers.set('content-length', String(size));
    return new Response(null, { headers });
  }
  const obj = await env.MEDIA.get(key, range ? { range } : {});
  if (!obj) return new Response('Not found', { status: 404 });
  if (range) {
    headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);
    headers.set('content-length', String(range.length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('content-length', String(size));
  return new Response(obj.body, { headers });
}

/* -------------------------------------------------------------- visits */
// One row per page view. The page reports visible time every ~15s and when it closes.
// No IP addresses are stored; country comes from Cloudflare.

let tableReady = false;
async function ensureTable(env) {
  if (tableReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS visits (
    id TEXT PRIMARY KEY, started INTEGER NOT NULL, updated INTEGER NOT NULL,
    seconds INTEGER NOT NULL DEFAULT 0, entered INTEGER NOT NULL DEFAULT 0, plays INTEGER NOT NULL DEFAULT 0,
    clips TEXT, country TEXT, device TEXT, referrer TEXT)`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS visits_started ON visits(started)').run();
  tableReady = true;
}

async function visitStart(req, env) {
  if (!env.DB || (await isAdmin(req, env))) return json({ id: null }); // don't count yourself
  const ua = req.headers.get('user-agent') || '';
  if (/bot|crawler|spider|preview|facebookexternalhit|slurp|headless/i.test(ua)) return json({ id: null });
  let body = {};
  try { body = await req.json(); } catch {}
  let ref = '';
  try { const r = new URL(str(body.ref, 500)); if (r.host !== new URL(req.url).host) ref = r.host.replace(/^www\./, ''); } catch {}
  const device = /iPad|Tablet/i.test(ua) ? 'tablet' : /Mobi|iPhone|Android/i.test(ua) ? 'phone' : 'desktop';
  const id = crypto.randomUUID();
  const now = Date.now();
  await ensureTable(env);
  await env.DB.prepare('INSERT INTO visits (id, started, updated, country, device, referrer) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, now, now, (req.cf && req.cf.country) || '', device, ref).run();
  return json({ id });
}

async function visitBeat(req, env) {
  if (!env.DB) return json({ ok: true });
  let b;
  try { b = JSON.parse(await req.text()); } catch { throw new HttpError(400, 'Bad beat.'); }
  if (typeof b.id !== 'string' || !/^[0-9a-f-]{36}$/.test(b.id)) throw new HttpError(400, 'Bad id.');
  const seconds = Math.max(0, Math.min(6 * 3600, Math.round(Number(b.seconds) || 0)));
  const plays = Math.max(0, Math.min(500, Math.round(Number(b.plays) || 0)));
  const clips = {};
  if (b.clips && typeof b.clips === 'object')
    for (const [k, v] of Object.entries(b.clips).slice(0, 80)) clips[str(k, 120)] = Math.max(0, Math.min(6 * 3600, Math.round(Number(v) || 0)));
  await ensureTable(env);
  // only grows, and only for visits started in the last 6 hours
  await env.DB.prepare(`UPDATE visits SET updated = ?, seconds = MAX(seconds, ?), entered = MAX(entered, ?), plays = MAX(plays, ?), clips = ?
    WHERE id = ? AND started > ?`)
    .bind(Date.now(), seconds, b.entered ? 1 : 0, plays, JSON.stringify(clips), b.id, Date.now() - 6 * 3600e3).run();
  return json({ ok: true });
}

async function stats(env, q) {
  if (!env.DB) return json({ error: 'No database bound.' }, 500);
  await ensureTable(env);
  const days = Math.max(1, Math.min(3650, Number(q.get('days')) || 30));
  const since = Date.now() - days * 864e5;
  const { results } = await env.DB.prepare('SELECT * FROM visits WHERE started > ? ORDER BY started DESC LIMIT 20000').bind(since).all();
  const rows = results || [];
  const secs = rows.map((r) => r.seconds).sort((a, b) => a - b);
  const clipTime = {}, clipViews = {};
  for (const r of rows) {
    let c = {};
    try { c = JSON.parse(r.clips || '{}'); } catch {}
    for (const [k, v] of Object.entries(c)) if (v > 0) { clipTime[k] = (clipTime[k] || 0) + v; clipViews[k] = (clipViews[k] || 0) + 1; }
  }
  const count = (key) => rows.reduce((m, r) => ((m[r[key] || '—'] = (m[r[key] || '—'] || 0) + 1), m), {});
  const perDay = {};
  for (const r of rows) { const d = new Date(r.started).toISOString().slice(0, 10); perDay[d] = (perDay[d] || 0) + 1; }
  return json({
    days,
    visits: rows.length,
    entered: rows.filter((r) => r.entered).length,
    totalSeconds: secs.reduce((a, b) => a + b, 0),
    avgSeconds: rows.length ? Math.round(secs.reduce((a, b) => a + b, 0) / rows.length) : 0,
    medianSeconds: secs.length ? secs[Math.floor(secs.length / 2)] : 0,
    plays: rows.reduce((a, r) => a + r.plays, 0),
    clips: Object.keys(clipTime).map((k) => ({ title: k, seconds: clipTime[k], visits: clipViews[k] })).sort((a, b) => b.seconds - a.seconds),
    devices: count('device'), countries: count('country'), referrers: count('referrer'), perDay,
    recent: rows.slice(0, 100).map((r) => ({ started: r.started, seconds: r.seconds, entered: !!r.entered, plays: r.plays, country: r.country, device: r.device, referrer: r.referrer, clips: Object.keys(JSON.parse(r.clips || '{}')).length })),
  });
}

/* ---------------------------------------------------------------- auth */

async function login(req, env) {
  if (!env.ADMIN_PASSWORD) throw new HttpError(503, 'ADMIN_PASSWORD is not set on the Worker yet.');
  let password = '';
  try { ({ password = '' } = await req.json()); } catch {}
  const secret = sessionSecret(env);
  const ok = timingSafe(await hmac(secret, 'pw:' + password), await hmac(secret, 'pw:' + env.ADMIN_PASSWORD));
  if (!ok) {
    await new Promise((r) => setTimeout(r, 700)); // slow down guessing
    throw new HttpError(401, 'Wrong password.');
  }
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const value = `${exp}.${await hmac(secret, 'session:' + exp)}`;
  return json({ ok: true }, 200, { 'set-cookie': cookie(value, SESSION_DAYS * 86400) });
}

async function isAdmin(req, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const raw = (req.headers.get('cookie') || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  if (!raw) return false;
  const [exp, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return timingSafe(sig, await hmac(sessionSecret(env), 'session:' + exp));
}

const sessionSecret = (env) => `aviram|${env.ADMIN_PASSWORD}|${env.SESSION_SECRET || ''}`;
const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function timingSafe(a, b) {
  const A = enc.encode(a), B = enc.encode(b);
  if (A.length !== B.length) return false;
  return crypto.subtle.timingSafeEqual(A, B);
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}
