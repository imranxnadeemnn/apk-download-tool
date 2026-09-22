'use strict';
/**
 * APK Download Tool — HTTP server (Express), deployable on Render.com.
 *
 * Routes
 *   GET  /                      UI
 *   GET  /api/resolve?input=    Play URL / market:// / package  ->  JSON result or structured error
 *   GET  /api/download?u=&name= Streams the APK from the mirror through this server (no size limit besides MAX_PROXY_BYTES)
 *   GET  /api/diagnose?pkg=     Raw HTTP status of each mirror endpoint from THIS server's IP (protect with DIAG_TOKEN)
 *   GET  /api/convert?u=        Start / reuse an XAPK -> single-APK conversion job; /api/convert/:id status; /:id/file result
 *   GET  /api/notifications     In-app notification feed: recent resolutions, failures and mirror-health alerts
 *   GET  /healthz               Liveness
 *
 * Notifications live in the tool's own UI (bell icon + Activity panel), fed by /api/notifications.
 * There is deliberately no Slack / Teams / e-mail integration.
 *
 * Env (all optional): PORT, PROVIDER_ORDER, PLAY_DEFAULT_REGION, PLAY_REGIONS, ALLOW_UNLISTED_APPS,
 *   RATE_LIMIT_MAX (30) / RATE_LIMIT_WINDOW_SEC (600), DIAG_TOKEN,
 *   NOTIFY_MAX_EVENTS (200), NOTIFY_ALERT_WINDOW_SEC (600), NOTIFY_ALERT_THRESHOLD (3)
 */
const express = require('express');
const path = require('path');
const { Readable } = require('stream');
const core = require('./lib/core');
const convert = require('./lib/convert');
const { CONFIG, ERR, ApkToolError, toErrorPayload, httpFetch, resolveApk, diagnoseProviders } = core;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);            // Render terminates TLS; real client IP is in X-Forwarded-For

// ----------------------------------------------------------------------------
// Logging (JSON lines -> Render log stream)
// ----------------------------------------------------------------------------
function log(level, msg, data) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(data || {}) });
  if (level === 'error') console.error(line); else if (level === 'warn') console.warn(line); else console.log(line);
}

// ----------------------------------------------------------------------------
// In-app notifications: an in-memory ring buffer of events the UI polls.
//   kinds: success | failure | error | alert
//   An `alert` is raised when a mirror is BLOCKED (403/429/bot challenge) NOTIFY_ALERT_THRESHOLD times within
//   NOTIFY_ALERT_WINDOW_SEC, or when every provider misses for an app Play does list (NO_PROVIDER).
//   Events are anonymous (no client IPs, no user ids) so the feed can be shown to everyone using the tool.
// ----------------------------------------------------------------------------
const NOTIFY = {
  maxEvents: Number(process.env.NOTIFY_MAX_EVENTS || 200),
  alertWindowSec: Number(process.env.NOTIFY_ALERT_WINDOW_SEC || 600),
  alertThreshold: Number(process.env.NOTIFY_ALERT_THRESHOLD || 3)
};
const events = [];                 // newest last
let eventSeq = 0;
const blockedHits = new Map();     // provider -> [timestamps]
const alertLast = new Map();       // alert key -> last raised ms

function pushEvent(kind, title, detail, extra) {
  const ev = Object.assign({ id: ++eventSeq, t: new Date().toISOString(), kind, title, detail: detail || '' }, extra || {});
  events.push(ev);
  if (events.length > NOTIFY.maxEvents) events.splice(0, events.length - NOTIFY.maxEvents);
  return ev;
}
function raiseAlert(key, title, detail, extra) {
  const last = alertLast.get(key) || 0;
  if (Date.now() - last < NOTIFY.alertWindowSec * 1000) return null;     // one alert per key per window
  alertLast.set(key, Date.now());
  log('warn', 'alert', { key, title, detail });
  return pushEvent('alert', title, detail, Object.assign({ key }, extra || {}));
}
function noteProviderBlocked(provider, message) {
  const now = Date.now();
  const arr = (blockedHits.get(provider) || []).filter(t => now - t < NOTIFY.alertWindowSec * 1000);
  arr.push(now); blockedHits.set(provider, arr);
  if (arr.length >= NOTIFY.alertThreshold) {
    raiseAlert('blocked:' + provider, `${provider} is blocking this server`, `${arr.length} blocked responses in the last ${Math.round(NOTIFY.alertWindowSec / 60)} min (${message}). Other mirrors are still tried; consider reordering PROVIDER_ORDER.`, { provider });
  }
}
/** Called by the resolver whenever every provider fails or an internal error occurs. */
async function notifyFailure(pkg, appMeta, err, attempts) {
  const title = appMeta && appMeta.title && appMeta.title !== pkg ? `${appMeta.title} (${pkg})` : String(pkg || 'unknown package');
  const kind = err.code === ERR.NO_PROVIDER || err.code === ERR.APP_NOT_FOUND ? 'failure' : 'error';
  pushEvent(kind, `${kind === 'error' ? 'Error' : 'No APK found'}: ${title}`, err.message, {
    code: err.code, package: pkg || null, region: appMeta ? appMeta.region : null,
    attempts: (attempts || []).map(a => ({ provider: a.provider, ok: !!a.ok, code: a.code || null }))
  });
  if (err.code === ERR.NO_PROVIDER && appMeta && appMeta.region) {
    raiseAlert('noprovider:' + pkg, `Geo-restricted or unmirrored app: ${appMeta.title}`, `Google Play lists it in the ${appMeta.region} store but no mirror carries the file. Users get browser-side links instead.`, { package: pkg, region: appMeta.region });
  }
  for (const a of attempts || []) if (a.code === ERR.PROVIDER_BLOCKED) noteProviderBlocked(a.provider, a.message || '');
}
function notifySuccess(result) {
  const d = result.download, a = result.app;
  pushEvent('success', `${a.title} → ${d.provider}${d.kind === 'XAPK' ? ' (XAPK)' : ''}`, `${d.version || 'latest'} · ${d.sizeHuman}${a.geoRestricted ? ` · Play ${a.region} store` : ''}${result.cached ? ' · cached' : ''}`, {
    package: result.package, provider: d.provider, region: a.region, version: d.version || null, sizeBytes: d.sizeBytes || null
  });
  for (const at of result.attempts || []) if (at.code === ERR.PROVIDER_BLOCKED) noteProviderBlocked(at.provider, at.message || '');
}

// ----------------------------------------------------------------------------
// Rate limiting (per client IP, in-memory sliding window)
// ----------------------------------------------------------------------------
const RL_MAX = Number(process.env.RATE_LIMIT_MAX || 30), RL_WIN = Number(process.env.RATE_LIMIT_WINDOW_SEC || 600) * 1000;
const rl = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const arr = (rl.get(ip) || []).filter(t => now - t < RL_WIN);
  if (arr.length >= RL_MAX) {
    return res.status(429).json(toErrorPayload(new ApkToolError(ERR.RATE_LIMITED, `Too many requests — limit is ${RL_MAX} per ${Math.round(RL_WIN / 60000)} minutes.`, 'Please wait a bit before trying again.')));
  }
  arr.push(now); rl.set(ip, arr);
  if (rl.size > 5000) for (const [k, v] of rl) if (!v.some(t => now - t < RL_WIN)) rl.delete(k);
  next();
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: '5m' }));

app.get('/healthz', (req, res) => res.json({ ok: true, app: CONFIG.APP_NAME, providers: CONFIG.PROVIDER_ORDER, convert: convert.available(), uptimeSec: Math.round(process.uptime()) }));

app.get('/api/config', (req, res) => res.json({ ok: true, appName: CONFIG.APP_NAME, providers: CONFIG.PROVIDER_ORDER, defaultRegion: CONFIG.PLAY_DEFAULT_REGION, maxProxyBytes: CONFIG.MAX_PROXY_BYTES, convertAvailable: convert.available() }));

app.get('/api/resolve', rateLimit, async (req, res) => {
  const input = String(req.query.input || req.query.url || req.query.id || '');
  const started = Date.now();
  const result = await resolveApk(input, { log, notifyFailure });
  if (result.ok && !result.cached) notifySuccess(result);
  log(result.ok ? 'info' : 'warn', 'resolve', { input: input.slice(0, 200), ok: result.ok, code: result.ok ? undefined : result.error.code, provider: result.ok ? result.download.provider : undefined, region: result.ok ? result.app.region : undefined, ms: Date.now() - started, ip: req.ip });
  res.status(result.ok ? 200 : httpStatusFor(result.error.code)).json(result);
});

function httpStatusFor(code) {
  if ([ERR.EMPTY_INPUT, ERR.INVALID_URL, ERR.NOT_PLAY_URL, ERR.INVALID_PACKAGE].includes(code)) return 400;
  if ([ERR.APP_NOT_FOUND, ERR.NO_PROVIDER].includes(code)) return 404;
  if (code === ERR.PAID_APP) return 402;
  if (code === ERR.RATE_LIMITED) return 429;
  if ([ERR.PLAY_UNREACHABLE, ERR.PROVIDER_BLOCKED].includes(code)) return 502;
  return 500;
}

/** Streaming proxy — only to known mirror hosts, only for ZIP payloads, capped in size. */
const PROXY_HOSTS = /(^|\.)(apkpure\.com|winudf\.com|pureapk\.com|aptoide\.com|f-droid\.org|apkcombo\.com|apkcombo\.app)$/i;
app.get('/api/download', rateLimit, async (req, res) => {
  const u = String(req.query.u || ''), name = core.sanitizeFileName(String(req.query.name || 'app.apk')), ref = String(req.query.ref || '');
  let target;
  try { target = new URL(u); } catch { return res.status(400).json(toErrorPayload(new ApkToolError(ERR.INVALID_URL, 'Invalid download URL.'))); }
  if (target.protocol !== 'https:' || !PROXY_HOSTS.test(target.hostname)) {
    return res.status(400).json(toErrorPayload(new ApkToolError(ERR.INVALID_URL, `Refusing to proxy ${target.hostname}.`, 'Only known APK mirrors can be relayed.')));
  }
  let upstream;
  try {
    const headers = { 'User-Agent': CONFIG.DESKTOP_USER_AGENT, Accept: '*/*' };
    if (ref) headers.Referer = ref;
    if (req.headers.range) headers.Range = req.headers.range;          // resumable downloads pass through
    upstream = await httpFetch(target.href, { headers, timeoutMs: 60000 });
  } catch (e) {
    return res.status(502).json(toErrorPayload(new ApkToolError(ERR.PROXY_ERROR, e.message, 'Try the direct link in your browser instead.')));
  }
  if (upstream.status < 200 || upstream.status >= 300 || upstream.status === 204) {
    upstream.body?.cancel?.();
    return res.status(502).json(toErrorPayload(new ApkToolError(ERR.PROXY_ERROR, `Mirror returned HTTP ${upstream.status}.`, 'The link may have expired — resolve the app again.')));
  }
  const ct = (upstream.headers.get('content-type') || '').toLowerCase();
  if (/text\/html/.test(ct)) {
    upstream.body?.cancel?.();
    return res.status(502).json(toErrorPayload(new ApkToolError(ERR.PROXY_ERROR, 'Mirror returned an HTML page instead of a file (bot challenge).', 'Use the direct link in your browser instead.')));
  }
  const len = Number(upstream.headers.get('content-length') || 0);
  if (len && len > CONFIG.MAX_PROXY_BYTES) {
    upstream.body?.cancel?.();
    return res.status(413).json(toErrorPayload(new ApkToolError(ERR.PROXY_ERROR, `File is ${core.humanSize(len)}, above the proxy cap of ${core.humanSize(CONFIG.MAX_PROXY_BYTES)}.`, 'Use the direct link instead.')));
  }

  res.status(upstream.status);
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  for (const h of ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) { const v = upstream.headers.get(h); if (v) res.setHeader(h, v); }
  res.setHeader('Cache-Control', 'no-store');

  let sent = 0, first = true;
  const body = Readable.fromWeb(upstream.body);
  body.on('data', chunk => {
    if (first) { first = false; if (!(chunk[0] === 0x50 && chunk[1] === 0x4b) && !req.headers.range) { log('warn', 'proxy: payload is not a ZIP', { u }); } }
    sent += chunk.length;
    if (sent > CONFIG.MAX_PROXY_BYTES) { log('warn', 'proxy: cap exceeded, aborting', { u, sent }); body.destroy(); res.destroy(); }
  });
  body.on('error', e => { log('error', 'proxy stream error', { u, message: e.message }); if (!res.headersSent) res.status(502).end(); else res.destroy(); });
  req.on('close', () => body.destroy());
  body.on('end', () => log('info', 'proxy done', { u: target.hostname, bytes: sent, ip: req.ip }));
  body.pipe(res);
});

/**
 * XAPK -> single APK conversion (see lib/convert.js).
 *   GET /api/convert?u=<xapk url>&name=<file.apk>&pkg=<package>[&ref=]  -> creates/reuses a job, returns its status
 *   GET /api/convert/:id                                                  -> job status (poll every ~2 s)
 *   GET /api/convert/:id/file                                             -> the finished .apk
 */
app.get('/api/convert', rateLimit, (req, res) => {
  const u = String(req.query.u || ''), name = String(req.query.name || 'app.apk'), ref = String(req.query.ref || ''), pkg = String(req.query.pkg || '');
  let target;
  try { target = new URL(u); } catch { return res.status(400).json(toErrorPayload(new ApkToolError(ERR.INVALID_URL, 'Invalid bundle URL.'))); }
  if (target.protocol !== 'https:' || !PROXY_HOSTS.test(target.hostname)) {
    return res.status(400).json(toErrorPayload(new ApkToolError(ERR.INVALID_URL, `Refusing to fetch from ${target.hostname}.`, 'Only known APK mirrors can be converted.')));
  }
  if (!convert.available()) {
    return res.status(503).json(toErrorPayload(new ApkToolError('CONVERT_UNAVAILABLE', 'XAPK conversion is not available on this server (Java tools missing).', 'Download the XAPK and install it with the APKPure app or SAI instead.')));
  }
  if (req.query.check) {                       // status-only: never starts a job
    const existing = convert.find(u);
    return res.json({ ok: true, job: existing ? convert.publicView(existing) : null });
  }
  const job = convert.start(u, { name, ref, pkg, log, onDone: j => {
    if (j.status === 'done') pushEvent('success', `${j.pkg || j.outName} → single APK (${j.resigned ? 'merged + re-signed' : 'extracted'})`, `${core.humanSize(j.outSize)} from a ${j.splits ? j.splits.length : '?'}-part bundle`, { package: j.pkg || null, provider: 'convert', sizeBytes: j.outSize });
    else pushEvent('error', `XAPK conversion failed: ${j.pkg || j.outName}`, j.error || 'unknown error', { package: j.pkg || null, code: 'CONVERT_FAILED' });
  } });
  res.status(job.status === 'done' ? 200 : 202).json({ ok: true, job: convert.publicView(job) });
});
app.get('/api/convert/:id', (req, res) => {
  const job = convert.get(String(req.params.id));
  res.setHeader('Cache-Control', 'no-store');
  if (!job) return res.status(404).json({ ok: false, error: { code: 'JOB_NOT_FOUND', message: 'No such conversion job (it may have expired — run the lookup again).' } });
  res.json({ ok: true, job: convert.publicView(job) });
});
app.get('/api/convert/:id/file', (req, res) => {
  const job = convert.get(String(req.params.id));
  if (!job || job.status !== 'done' || !job.outPath) return res.status(404).json({ ok: false, error: { code: 'JOB_NOT_READY', message: 'The converted APK is not ready or has expired.' } });
  const name = job.outName.replace(/\.xapk$/i, '.apk').replace(/(\.apk)?$/i, '.apk');
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(job.outPath, err => { if (err && !res.headersSent) res.status(500).end(); });
});

/** Notification feed for the UI. ?since=<id> returns only newer events; ?limit=N caps the list (default 50). */
app.get('/api/notifications', (req, res) => {
  const since = Number(req.query.since || 0), limit = Math.min(Number(req.query.limit || 50), NOTIFY.maxEvents);
  const list = events.filter(e => e.id > since).slice(-limit).reverse();       // newest first
  const windowMs = NOTIFY.alertWindowSec * 1000, now = Date.now();
  const recent = events.filter(e => now - Date.parse(e.t) < windowMs);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true, latestId: eventSeq, serverTime: new Date().toISOString(),
    summary: {
      windowMin: Math.round(windowMs / 60000),
      success: recent.filter(e => e.kind === 'success').length,
      failure: recent.filter(e => e.kind === 'failure').length,
      error: recent.filter(e => e.kind === 'error').length,
      alerts: recent.filter(e => e.kind === 'alert').length,
      blockedProviders: [...blockedHits.entries()].filter(([, ts]) => ts.some(t => now - t < windowMs)).map(([p]) => p)
    },
    events: list
  });
});

app.get('/api/diagnose', rateLimit, async (req, res) => {
  const token = process.env.DIAG_TOKEN;
  if (token && req.query.token !== token) return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Missing or wrong ?token=' } });
  const pkg = String(req.query.pkg || 'com.brazino.mexico');
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(pkg)) return res.status(400).json({ ok: false, error: { code: ERR.INVALID_PACKAGE, message: 'Bad package name.' } });
  res.json({ ok: true, pkg, serverTime: new Date().toISOString(), results: await diagnoseProviders(pkg) });
});

app.use((req, res) => res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'No such route.' } }));
app.use((err, req, res, next) => { log('error', 'unhandled', { message: err.message, stack: err.stack }); res.status(500).json(toErrorPayload(err)); });

process.on('unhandledRejection', e => log('error', 'unhandledRejection', { message: e && e.message }));

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => log('info', `${CONFIG.APP_NAME} listening`, { port: PORT, providers: CONFIG.PROVIDER_ORDER, defaultRegion: CONFIG.PLAY_DEFAULT_REGION }));
