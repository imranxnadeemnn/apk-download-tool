'use strict';
/**
 * APK Download Tool — core resolver (Node port of the Apps Script version).
 *
 * resolveApk(input) -> { ok:true, package, app, download, attempts } | { ok:false, error:{code,message,hint,details} }
 *
 * Pipeline:  parse input  ->  multi-region Google Play lookup  ->  provider chain  ->  file probe
 */

const CONFIG = {
  APP_NAME: process.env.APP_NAME || 'APK Download Tool',

  PROVIDER_ORDER: (process.env.PROVIDER_ORDER || 'apkpure,aptoide,fdroid,apkcombo').split(',').map(s => s.trim()).filter(Boolean),

  PLAY_REGIONS: (process.env.PLAY_REGIONS || 'IN,US,GB,MX,BR,DE,FR,ES,IT,JP,KR,ID,PH,VN,TR,RU,AE,SA,NG,ZA,CA,AU,AR,CO,CL').split(','),
  PLAY_DEFAULT_REGION: process.env.PLAY_DEFAULT_REGION || 'IN',
  PLAY_MAX_REGION_LOOKUPS: Number(process.env.PLAY_MAX_REGION_LOOKUPS || 12),
  PLAY_CONCURRENCY: Number(process.env.PLAY_CONCURRENCY || 4),      // regions probed in parallel
  ALLOW_UNLISTED_APPS: (process.env.ALLOW_UNLISTED_APPS || 'true') === 'true',

  FETCH_TIMEOUT_MS: Number(process.env.FETCH_TIMEOUT_MS || 15000),
  RESULT_CACHE_SEC: Number(process.env.RESULT_CACHE_SEC || 1800),

  // Streaming proxy (/api/download): hard cap on bytes relayed per request.
  MAX_PROXY_BYTES: Number(process.env.MAX_PROXY_BYTES || 2 * 1024 * 1024 * 1024),

  USER_AGENT: process.env.USER_AGENT || 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
  DESKTOP_USER_AGENT: process.env.DESKTOP_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'
};

// ----------------------------------------------------------------------------
// Errors
// ----------------------------------------------------------------------------
const ERR = {
  EMPTY_INPUT: 'EMPTY_INPUT', INVALID_URL: 'INVALID_URL', NOT_PLAY_URL: 'NOT_PLAY_URL', INVALID_PACKAGE: 'INVALID_PACKAGE',
  APP_NOT_FOUND: 'APP_NOT_FOUND', PAID_APP: 'PAID_APP', PLAY_UNREACHABLE: 'PLAY_UNREACHABLE',
  PROVIDER_BLOCKED: 'PROVIDER_BLOCKED', PROVIDER_MISS: 'PROVIDER_MISS', NO_PROVIDER: 'NO_PROVIDER',
  RATE_LIMITED: 'RATE_LIMITED', PROXY_ERROR: 'PROXY_ERROR', INTERNAL: 'INTERNAL_ERROR'
};

class ApkToolError extends Error {
  constructor(code, message, hint = '', details = null) {
    super(message);
    this.name = 'ApkToolError';
    this.code = code; this.hint = hint; this.details = details;
  }
}

function toErrorPayload(e) {
  if (e instanceof ApkToolError) return { ok: false, error: { code: e.code, message: e.message, hint: e.hint, details: e.details } };
  return { ok: false, error: { code: ERR.INTERNAL, message: 'Something went wrong on the server: ' + (e && e.message || e), hint: 'Please try again in a minute.' } };
}

// ----------------------------------------------------------------------------
// HTTP
// ----------------------------------------------------------------------------
async function httpFetch(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || CONFIG.FETCH_TIMEOUT_MS);
  const headers = Object.assign({
    'User-Agent': CONFIG.USER_AGENT, 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9'
  }, opts.headers || {});
  try {
    return await fetch(url, { method: opts.method || 'GET', headers, redirect: opts.redirect || 'follow', signal: ctrl.signal });
  } catch (e) {
    throw new ApkToolError(ERR.PROVIDER_BLOCKED, `Network error talking to ${hostOf(url)}: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
  } finally { clearTimeout(t); }
}
const hostOf = u => { try { return new URL(u).host; } catch { return u; } };

/** HEAD (falls back to a 4-byte Range GET) to learn size / type / filename and confirm ZIP magic. */
async function probeFile(url, extraHeaders = {}) {
  let r;
  try {
    r = await httpFetch(url, { method: 'GET', headers: Object.assign({ Range: 'bytes=0-3' }, extraHeaders) });
  } catch (e) { return { ok: false, code: 'PROBE_NETWORK', message: e.message }; }
  const status = r.status;
  if ([403, 404, 410].includes(status)) { r.body?.cancel?.(); return { ok: false, code: 'PROBE_HTTP_' + status }; }
  const h = Object.fromEntries([...r.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
  const ct = (h['content-type'] || '').toLowerCase();
  if (/text\/html/.test(ct)) { r.body?.cancel?.(); return { ok: false, code: 'PROBE_HTML', message: 'Mirror returned an HTML page instead of a file.' }; }

  let size = null;
  const cr = h['content-range'] && h['content-range'].match(/\/(\d+)\s*$/);
  if (cr) size = Number(cr[1]); else if (h['content-length'] && status === 200) size = Number(h['content-length']);

  // ZIP magic "PK"
  try {
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length >= 2 && !(buf[0] === 0x50 && buf[1] === 0x4b)) return { ok: false, code: 'PROBE_NOT_ZIP' };
  } catch { /* stream may have been huge if Range ignored; ignore */ }

  let fileName = null;
  const cd = h['content-disposition'];
  if (cd) { const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i); if (m) { try { fileName = decodeURIComponent(m[1]); } catch { fileName = m[1]; } } }
  if (!fileName) { const m = url.match(/\/([^\/?#]+\.(?:apk|xapk))(?:[?#]|$)/i); if (m) fileName = m[1]; }
  let version = null;
  if (fileName) { const vm = fileName.match(/_v?(\d+(?:\.\d+)*)/); if (vm) version = vm[1]; }

  return { ok: true, sizeBytes: size, contentType: ct, fileName: fileName ? sanitizeFileName(fileName) : null, version, finalUrl: r.url || url };
}

// ----------------------------------------------------------------------------
// Input parsing
// ----------------------------------------------------------------------------
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

function queryParam(query, key) {
  for (const kv of String(query || '').split('&')) {
    const [k, v = ''] = kv.split('=');
    let dk; try { dk = decodeURIComponent(k || ''); } catch { dk = k; }
    if (dk === key) { try { return decodeURIComponent(v.replace(/\+/g, ' ')).trim(); } catch { return v.trim(); } }
  }
  return null;
}

function extractPackageName(input) {
  const raw = (input == null ? '' : String(input)).trim();
  if (!raw) throw new ApkToolError(ERR.EMPTY_INPUT, 'Please paste a Google Play Store URL.', 'Example: https://play.google.com/store/apps/details?id=com.whatsapp');
  if (PACKAGE_RE.test(raw)) return raw;

  const m = raw.match(/^market:\/\/details\?(.*)$/i);
  if (m) {
    const id = queryParam(m[1], 'id');
    if (id && PACKAGE_RE.test(id)) return id;
    throw new ApkToolError(ERR.INVALID_PACKAGE, 'The market:// link does not contain a valid package id.', 'It should look like market://details?id=com.example.app');
  }

  let url = raw; if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const parts = url.match(/^https?:\/\/([^\/?#]+)([^?#]*)(\?[^#]*)?/i);
  if (!parts) throw new ApkToolError(ERR.INVALID_URL, 'That does not look like a valid URL.', 'Copy the link from the address bar of the Play Store page.');
  const host = parts[1].toLowerCase(), path = parts[2] || '', query = (parts[3] || '').replace(/^\?/, '');
  if (!/(^|\.)play\.google\.com$/.test(host)) throw new ApkToolError(ERR.NOT_PLAY_URL, 'Only Google Play Store links are supported (play.google.com).', `You entered a link on "${host}". Open the app in Google Play and copy that URL instead.`);
  if (!/^\/store\/apps\/details(\/[^\/?#]*)?\/?$/.test(path)) throw new ApkToolError(ERR.NOT_PLAY_URL, 'This is a Play Store link, but not an app page.', 'App pages look like https://play.google.com/store/apps/details?id=<package>');
  const pkg = queryParam(query, 'id');
  if (!pkg) throw new ApkToolError(ERR.INVALID_PACKAGE, 'The link is missing the "id=" parameter with the package name.', 'Example: https://play.google.com/store/apps/details?id=com.whatsapp');
  if (!PACKAGE_RE.test(pkg)) throw new ApkToolError(ERR.INVALID_PACKAGE, `"${pkg}" is not a valid Android package name.`, 'Package names look like com.company.app');
  return pkg;
}

function extractStoreHints(input) {
  const s = String(input || '');
  const q = s.includes('?') ? s.slice(s.indexOf('?') + 1).split('#')[0] : '';
  const gl = queryParam(q, 'gl'), hl = queryParam(q, 'hl');
  return {
    gl: gl && /^[A-Za-z]{2}$/.test(gl) ? gl.toUpperCase() : null,
    hl: hl && /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/.test(hl) ? hl : null
  };
}

// ----------------------------------------------------------------------------
// Google Play (multi-region)
// ----------------------------------------------------------------------------
function decodeEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

async function fetchPlayMetadata(pkg, gl, hl = 'en') {
  const url = `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}`;
  let r;
  try { r = await httpFetch(url); } catch (e) { throw new ApkToolError(ERR.PLAY_UNREACHABLE, 'Could not reach Google Play to verify the app.', 'Try again in a minute.', e.message); }
  if (r.status === 404) { r.body?.cancel?.(); throw new ApkToolError(ERR.APP_NOT_FOUND, `No app with package "${pkg}" in the ${gl} Play Store.`, '', { region: gl }); }
  if (r.status !== 200) { r.body?.cancel?.(); throw new ApkToolError(ERR.PLAY_UNREACHABLE, `Google Play (${gl}) responded with HTTP ${r.status}.`, 'Google may be rate-limiting; wait a minute and retry.'); }
  const html = await r.text();
  const app = { package: pkg, title: pkg, developer: '', icon: '', price: '0', playUrl: url, free: true };
  const ld = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  if (ld) {
    try {
      const j = JSON.parse(ld[1]);
      if (j.name) app.title = decodeEntities(j.name);
      if (j.author && j.author.name) app.developer = decodeEntities(j.author.name);
      if (j.image) app.icon = String(j.image);
      const offer = Array.isArray(j.offers) ? j.offers[0] : j.offers;
      if (offer && offer.price != null) app.price = String(offer.price);
      if (j.aggregateRating && j.aggregateRating.ratingValue) app.rating = Number(j.aggregateRating.ratingValue).toFixed(1);
      if (j.contentRating) app.contentRating = String(j.contentRating);
    } catch { /* fall through */ }
  }
  if (app.title === pkg) { const t = html.match(/<title[^>]*>([^<]*)<\/title>/i); if (t) app.title = decodeEntities(t[1].replace(/\s*-\s*Apps on Google Play\s*$/i, '').trim()) || pkg; }
  if (!app.price || app.price === '0') { const p = html.match(/itemprop="price"\s+content="([^"]*)"/i); if (p) app.price = p[1]; }
  const priceNum = parseFloat(String(app.price).replace(/[^0-9.]/g, ''));
  app.free = !(priceNum > 0);
  if (!app.free) throw new ApkToolError(ERR.PAID_APP, `"${app.title}" is a paid app (${app.price}).`, 'Free mirrors only carry free apps.', { price: app.price });
  return app;
}

/** Region order: gl from link, default region, then CONFIG.PLAY_REGIONS. Probes in small parallel batches. */
async function fetchPlayMetadataAnyRegion(pkg, hints) {
  const order = [];
  const add = r => { r = (r || '').toUpperCase(); if (r && !order.includes(r)) order.push(r); };
  add(hints && hints.gl); add(CONFIG.PLAY_DEFAULT_REGION); CONFIG.PLAY_REGIONS.forEach(add);
  const regions = order.slice(0, CONFIG.PLAY_MAX_REGION_LOOKUPS);

  const tried = [];
  for (let i = 0; i < regions.length; i += CONFIG.PLAY_CONCURRENCY) {
    const batch = regions.slice(i, i + CONFIG.PLAY_CONCURRENCY);
    const results = await Promise.all(batch.map(gl => fetchPlayMetadata(pkg, gl, (hints && hints.hl) || 'en').then(app => ({ gl, app })).catch(e => ({ gl, err: e }))));
    for (const res of results) {
      tried.push(res.gl);
      if (res.app) {
        const app = res.app;
        app.region = res.gl; app.regionsTried = tried.slice(); app.geoRestricted = res.gl !== CONFIG.PLAY_DEFAULT_REGION; app.unlisted = false;
        return app;
      }
      if (res.err && res.err.code !== ERR.APP_NOT_FOUND) throw res.err;   // PAID_APP / PLAY_UNREACHABLE -> stop
    }
  }
  if (!CONFIG.ALLOW_UNLISTED_APPS) {
    throw new ApkToolError(ERR.APP_NOT_FOUND, `No Play Store listing for "${pkg}" in any of ${tried.length} countries (${tried.join(', ')}).`, 'The app may have been removed from Google Play. Check the package name.');
  }
  return { package: pkg, title: pkg, developer: '', icon: '', price: '0', free: true, playUrl: `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}`, region: null, regionsTried: tried, geoRestricted: true, unlisted: true };
}

// ----------------------------------------------------------------------------
// Providers
// ----------------------------------------------------------------------------
const PROVIDERS = {
  /** APKPure: redirect endpoint -> CDN file. Tries APK then XAPK. */
  async apkpure(pkg, app) {
    let lastCode = null;
    for (const kind of ['APK', 'XAPK']) {
      const url = `https://d.apkpure.com/b/${kind}/${encodeURIComponent(pkg)}?version=latest`;
      const hdr = { Referer: 'https://apkpure.com/', 'User-Agent': CONFIG.DESKTOP_USER_AGENT };
      const r = await httpFetch(url, { redirect: 'manual', headers: hdr });
      const status = r.status, loc = r.headers.get('location');
      r.body?.cancel?.();
      if (status >= 300 && status < 400 && loc) {
        if (/^https?:\/\/(www\.)?apkpure\.com\//i.test(loc) && !/\.(apk|xapk)(\?|$)/i.test(loc)) { lastCode = 'REDIRECT_TO_PAGE'; continue; }
        const probe = await probeFile(loc, hdr);
        if (!probe.ok) { lastCode = probe.code; continue; }
        return { provider: 'APKPure', url: loc, kind, fileName: probe.fileName || `${safeBase(app.title)}_${pkg}.${kind.toLowerCase()}`, sizeBytes: probe.sizeBytes, contentType: probe.contentType, version: probe.version || 'latest', headers: hdr,
          notes: kind === 'XAPK' ? 'XAPK bundle — install with the APKPure app / SAI, or unzip to get base APK + splits/OBB.' : '' };
      }
      if ([403, 429, 503].includes(status)) throw new ApkToolError(ERR.PROVIDER_BLOCKED, `APKPure blocked the request (HTTP ${status}).`, '', { status });
      lastCode = 'HTTP_' + status;
    }
    throw new ApkToolError(ERR.PROVIDER_MISS, `APKPure has no APK for this package (${lastCode}).`);
  },

  /** Aptoide: public JSON API. Newest TRUSTED-signed build across stores, then getMeta for the file path. */
  async aptoide(pkg, app) {
    const r = await httpFetch(`https://ws75.aptoide.com/api/7/listAppVersions?package_name=${encodeURIComponent(pkg)}&limit=25`);
    if ([403, 429].includes(r.status)) throw new ApkToolError(ERR.PROVIDER_BLOCKED, `Aptoide blocked the request (HTTP ${r.status}).`);
    if (r.status !== 200) throw new ApkToolError(ERR.PROVIDER_MISS, `Aptoide returned HTTP ${r.status}.`);
    let json; try { json = await r.json(); } catch { throw new ApkToolError(ERR.PROVIDER_MISS, 'Aptoide returned non-JSON.'); }
    const list = (json && (json.list || (json.datalist && json.datalist.list))) || [];
    let best = null;
    for (const it of list) {
      if (!it || it.package !== pkg || !it.file) continue;
      if ((it.file.malware && it.file.malware.rank) !== 'TRUSTED') continue;
      if (!best || (Number(it.file.vercode) || 0) > (Number(best.file.vercode) || 0)) best = it;
    }
    if (!best) throw new ApkToolError(ERR.PROVIDER_MISS, `Aptoide has no trusted-signed build of ${pkg}.`);
    const mr = await httpFetch(best.id ? `https://ws75.aptoide.com/api/7/app/getMeta?app_id=${encodeURIComponent(best.id)}` : `https://ws75.aptoide.com/api/7/app/getMeta?package_name=${encodeURIComponent(pkg)}`);
    if (mr.status !== 200) throw new ApkToolError(ERR.PROVIDER_MISS, `Aptoide getMeta returned HTTP ${mr.status}.`);
    let meta; try { meta = await mr.json(); } catch { throw new ApkToolError(ERR.PROVIDER_MISS, 'Aptoide getMeta returned non-JSON.'); }
    const d = meta && meta.data;
    if (!d || !d.file || !d.file.path) throw new ApkToolError(ERR.PROVIDER_MISS, `Aptoide getMeta has no file path for ${pkg}.`);
    if (d.file.malware && d.file.malware.rank && d.file.malware.rank !== 'TRUSTED') throw new ApkToolError(ERR.PROVIDER_MISS, 'Aptoide build is not TRUSTED-signed.');
    return { provider: 'Aptoide', url: d.file.path, kind: 'APK', fileName: `${safeBase(app.title)}_${d.file.vername || d.file.vercode}.apk`, sizeBytes: Number(d.file.filesize) || null, contentType: 'application/vnd.android.package-archive', version: d.file.vername || '', versionCode: d.file.vercode || null, md5: d.file.md5sum || '', store: d.store && d.store.name,
      notes: 'Signature verified TRUSTED by Aptoide (matches the Play developer key). Version may lag the Play Store listing.' };
  },

  /** F-Droid: open-source apps. */
  async fdroid(pkg, app) {
    const r = await httpFetch(`https://f-droid.org/api/v1/packages/${encodeURIComponent(pkg)}`);
    if (r.status === 404) throw new ApkToolError(ERR.PROVIDER_MISS, 'Not on F-Droid (closed-source or not packaged).');
    if (r.status !== 200) throw new ApkToolError(ERR.PROVIDER_MISS, `F-Droid returned HTTP ${r.status}.`);
    let j; try { j = await r.json(); } catch { throw new ApkToolError(ERR.PROVIDER_MISS, 'F-Droid returned non-JSON.'); }
    const vc = j.suggestedVersionCode || (j.packages && j.packages[0] && j.packages[0].versionCode);
    if (!vc) throw new ApkToolError(ERR.PROVIDER_MISS, `F-Droid has no build for ${pkg}.`);
    const vn = (j.packages || []).find(p => p.versionCode === vc)?.versionName || String(vc);
    const url = `https://f-droid.org/repo/${encodeURIComponent(pkg)}_${vc}.apk`;
    const probe = await probeFile(url);
    if (!probe.ok) throw new ApkToolError(ERR.PROVIDER_MISS, `F-Droid APK not reachable (${probe.code}).`);
    return { provider: 'F-Droid', url, kind: 'APK', fileName: `${safeBase(app.title)}_${vn}.apk`, sizeBytes: probe.sizeBytes, contentType: probe.contentType, version: vn, versionCode: vc,
      notes: 'Open-source build from F-Droid; may be signed with the F-Droid key rather than the Play developer key.' };
  },

  /** APKCombo: scrape + checkin token. */
  async apkcombo(pkg, app) {
    const hdr = { Referer: 'https://apkcombo.com/', 'User-Agent': CONFIG.DESKTOP_USER_AGENT };
    const r = await httpFetch(`https://apkcombo.com/genericApp/${encodeURIComponent(pkg)}/download/apk`, { headers: hdr });
    if ([403, 429, 503].includes(r.status)) throw new ApkToolError(ERR.PROVIDER_BLOCKED, `APKCombo blocked the request (HTTP ${r.status}).`);
    if (r.status === 404 || r.status === 410) throw new ApkToolError(ERR.PROVIDER_MISS, `APKCombo has no APK for ${pkg} (HTTP ${r.status}).`);
    if (r.status !== 200) throw new ApkToolError(ERR.PROVIDER_MISS, `APKCombo returned HTTP ${r.status}.`);
    const html = await r.text();
    if (/cf-challenge|captcha|Just a moment/i.test(html)) throw new ApkToolError(ERR.PROVIDER_BLOCKED, 'APKCombo served a bot challenge.');
    const link = html.match(/href="(https?:\/\/download\.apkcombo\.com\/[^"]+\.(?:apk|xapk)[^"]*)"/i);
    if (!link) throw new ApkToolError(ERR.PROVIDER_MISS, 'No download link found on APKCombo page.');
    let fileUrl = decodeEntities(link[1]);
    try {
      const c = await httpFetch('https://apkcombo.com/checkin', { headers: hdr });
      if (c.status === 200) { const token = (await c.text()).trim(); if (token && token.length < 512) fileUrl += (fileUrl.includes('?') ? '&' : '?') + token; }
    } catch { /* optional */ }
    const kind = /\.xapk/i.test(fileUrl) ? 'XAPK' : 'APK';
    const ver = html.match(/class="vername">\s*([^<]+)</i);
    const probe = await probeFile(fileUrl, hdr);
    return { provider: 'APKCombo', url: fileUrl, kind, fileName: (probe.ok && probe.fileName) || `${safeBase(app.title)}_${pkg}.${kind.toLowerCase()}`, sizeBytes: probe.ok ? probe.sizeBytes : null, contentType: probe.ok ? probe.contentType : '', version: ver ? ver[1].trim() : 'latest', headers: hdr,
      notes: 'Link contains a short-lived token; download promptly.' };
  }
};

function browserFallbackLinks(pkg, app) {
  const q = encodeURIComponent(pkg);
  const links = [
    { label: 'APKPure — direct APK download', url: `https://d.apkpure.com/b/APK/${q}?version=latest`, kind: 'download', note: 'Starts the download immediately if APKPure has the app; otherwise shows their page.' },
    { label: 'APKPure — XAPK bundle', url: `https://d.apkpure.com/b/XAPK/${q}?version=latest`, kind: 'download', note: 'For apps that ship as split APKs / with OBB data.' },
    { label: 'APKCombo downloader', url: `https://apkcombo.com/downloader/#package=${q}`, kind: 'page', note: 'Generates the APK from the Play Store in your browser.' },
    { label: 'APKMirror search', url: `https://www.apkmirror.com/?post_type=app_release&searchtype=apk&s=${q}`, kind: 'page', note: 'Developer-signed APKs; pick the matching variant/ABI.' },
    { label: 'Uptodown search', url: `https://en.uptodown.com/android/search/${q}`, kind: 'page', note: '' }
  ];
  if (app && app.playUrl) links.push({ label: `Open on Google Play (${app.region || 'any region'})`, url: app.playUrl, kind: 'page', note: 'Install via Play if your account is in that country.' });
  return links;
}

// ----------------------------------------------------------------------------
// Cache (in-memory; Render instances are ephemeral, that's fine)
// ----------------------------------------------------------------------------
const cache = new Map();
const cacheGet = k => { const v = cache.get(k); if (!v) return null; if (v.exp < Date.now()) { cache.delete(k); return null; } return v.val; };
const cachePut = (k, val, sec) => cache.set(k, { val, exp: Date.now() + sec * 1000 });

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function resolveApk(input, { log = () => {}, notifyFailure = async () => {} } = {}) {
  const started = Date.now();
  let pkg = null;
  try {
    pkg = extractPackageName(input);
    const hints = extractStoreHints(input);
    const app = await fetchPlayMetadataAnyRegion(pkg, hints);

    const cached = cacheGet('apk:' + pkg);
    if (cached) { return { ...cached, app, cached: true, elapsedMs: Date.now() - started }; }

    const attempts = [];
    let download = null;
    for (const name of CONFIG.PROVIDER_ORDER) {
      const fn = PROVIDERS[name];
      if (!fn) { attempts.push({ provider: name, ok: false, code: 'UNKNOWN_PROVIDER' }); continue; }
      try {
        download = await fn(pkg, app);
        attempts.push({ provider: name, ok: true });
        break;
      } catch (e) {
        attempts.push({ provider: name, ok: false, code: e.code || ERR.INTERNAL, message: e.message });
        log('warn', 'provider failed', { pkg, provider: name, code: e.code, message: e.message });
      }
    }

    if (!download) {
      const err = app.unlisted
        ? new ApkToolError(ERR.APP_NOT_FOUND, `"${pkg}" is not listed on Google Play in any of ${app.regionsTried.length} countries (${app.regionsTried.join(', ')}) and no mirror carries it.`, 'Double-check the package name (case-sensitive). If the app was recently removed from Play, the browser-side mirror links below may still work.', { attempts, app, fallbackLinks: browserFallbackLinks(pkg, app) })
        : new ApkToolError(ERR.NO_PROVIDER, `Google Play lists "${app.title}" in the ${app.region} store, but none of the server-side mirrors could supply its APK.`, (app.geoRestricted ? `This app is geo-restricted (not in the ${CONFIG.PLAY_DEFAULT_REGION} store). ` : '') + 'Use the "Try from your browser" links below.', { attempts, app, fallbackLinks: browserFallbackLinks(pkg, app) });
      await notifyFailure(pkg, app, err, attempts);
      return toErrorPayload(err);
    }

    download.sizeHuman = humanSize(download.sizeBytes);
    // Server-side streaming proxy URL (lets the browser download through this server; hides mirror headers/tokens).
    download.proxyUrl = `/api/download?u=${encodeURIComponent(download.url)}&name=${encodeURIComponent(download.fileName || 'app.apk')}${download.headers ? '&ref=' + encodeURIComponent(download.headers.Referer || '') : ''}`;
    const payload = { ok: true, package: pkg, download, attempts };
    cachePut('apk:' + pkg, payload, CONFIG.RESULT_CACHE_SEC);
    return { ...payload, app, cached: false, elapsedMs: Date.now() - started };
  } catch (e) {
    log('error', 'resolveApk failed', { input, pkg, code: e.code, message: e.message });
    const userFacing = [ERR.EMPTY_INPUT, ERR.INVALID_URL, ERR.NOT_PLAY_URL, ERR.INVALID_PACKAGE, ERR.APP_NOT_FOUND, ERR.PAID_APP, ERR.RATE_LIMITED];
    if (!userFacing.includes(e.code)) await notifyFailure(pkg || input, null, e, []);
    return toErrorPayload(e);
  }
}

/** Raw status of each endpoint for one package (for /api/diagnose). */
async function diagnoseProviders(pkg) {
  const probes = [
    ['Play IN', `https://play.google.com/store/apps/details?id=${pkg}&hl=en&gl=IN`, {}],
    ['Play MX', `https://play.google.com/store/apps/details?id=${pkg}&hl=es&gl=MX`, {}],
    ['Aptoide', `https://ws75.aptoide.com/api/7/listAppVersions?package_name=${pkg}&limit=3`, {}],
    ['APKPure d.', `https://d.apkpure.com/b/APK/${pkg}?version=latest`, { redirect: 'manual', headers: { Referer: 'https://apkpure.com/', 'User-Agent': CONFIG.DESKTOP_USER_AGENT } }],
    ['APKCombo', `https://apkcombo.com/genericApp/${pkg}/download/apk`, { headers: { Referer: 'https://apkcombo.com/', 'User-Agent': CONFIG.DESKTOP_USER_AGENT } }],
    ['F-Droid', `https://f-droid.org/api/v1/packages/${pkg}`, {}]
  ];
  const out = [];
  for (const [name, url, opts] of probes) {
    try {
      const r = await httpFetch(url, opts);
      const body = (await r.text()).slice(0, 160).replace(/\s+/g, ' ');
      out.push({ name, status: r.status, contentType: r.headers.get('content-type'), location: r.headers.get('location'), body });
    } catch (e) { out.push({ name, error: e.message }); }
  }
  return out;
}

// ----------------------------------------------------------------------------
// utils
// ----------------------------------------------------------------------------
function humanSize(bytes) {
  if (!bytes || isNaN(bytes)) return 'unknown size';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0, n = Number(bytes);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
}
function sanitizeFileName(name) {
  let s = String(name).replace(/[\\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150);
  if (!/\.(apk|xapk)$/i.test(s)) s += '.apk';
  return s || 'app.apk';
}
function safeBase(title) { return String(title || 'app').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'app'; }

module.exports = { CONFIG, ERR, ApkToolError, toErrorPayload, httpFetch, probeFile, extractPackageName, extractStoreHints, fetchPlayMetadataAnyRegion, PROVIDERS, browserFallbackLinks, resolveApk, diagnoseProviders, humanSize, sanitizeFileName };
