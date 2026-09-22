'use strict';
/**
 * APK Download Tool — HTTP server (Express), deployable on Render.com.
 *
 * Routes
 *   GET  /                      UI
 *   GET  /api/resolve?input=    Play URL / market:// / package  ->  JSON result or structured error
 *   GET  /api/download?u=&name= Streams the APK from the mirror through this server (no size limit besides MAX_PROXY_BYTES)
 *   GET  /api/diagnose?pkg=     Raw HTTP status of each mirror endpoint from THIS server's IP (protect with DIAG_TOKEN)
 *   GET  /healthz               Liveness
 *
 * Env (all optional): PORT, PROVIDER_ORDER, PLAY_DEFAULT_REGION, PLAY_REGIONS, ALLOW_UNLISTED_APPS,
 *   RATE_LIMIT_MAX (30) / RATE_LIMIT_WINDOW_SEC (600), DIAG_TOKEN,
 *   NOTIFY_WEBHOOK_URL (Slack / Teams / any JSON webhook), NOTIFY_ON_FAILURE (true), NOTIFY_THROTTLE_SEC (300),
 *   SMTP_URL (smtps://user:pass@smtp.gmail.com) + NOTIFY_EMAIL_TO / NOTIFY_EMAIL_FROM  (needs `nodemailer`)
 */
const express = require('express');
const path = require('path');
const { Readable } = require('stream');
const core = require('./lib/core');
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
// Notifications: webhook (Slack/Teams/generic) and/or SMTP. Throttled per package.
// ----------------------------------------------------------------------------
const NOTIFY = {
  onFailure: (process.env.NOTIFY_ON_FAILURE || 'true') === 'true',
  webhook: process.env.NOTIFY_WEBHOOK_URL || '',
  smtpUrl: process.env.SMTP_URL || '',
  to: process.env.NOTIFY_EMAIL_TO || '',
  from: process.env.NOTIFY_EMAIL_FROM || process.env.NOTIFY_EMAIL_TO || '',
  throttleSec: Number(process.env.NOTIFY_THROTTLE_SEC || 300)
};
const notifyLast = new Map();
let mailer = null;
if (NOTIFY.smtpUrl && NOTIFY.to) {
  try { mailer = require('nodemailer').createTransport(NOTIFY.smtpUrl); } catch (e) { log('warn', 'nodemailer not installed; e-mail notifications disabled', { message: e.message }); }
}
async function notifyFailure(pkg, appMeta, err, attempts) {
  if (!NOTIFY.onFailure) return;
  const key = String(pkg || 'unknown');
  const last = notifyLast.get(key) || 0;
  if (Date.now() - last < NOTIFY.throttleSec * 1000) return;
  notifyLast.set(key, Date.now());
  const lines = [
    `${CONFIG.APP_NAME} — resolution FAILED`,
    `Package : ${pkg || '(unparsed)'}`,
    `App     : ${appMeta ? `${appMeta.title} by ${appMeta.developer} [Play region: ${appMeta.region || 'none'}]` : '(unknown)'}`,
    `Code    : ${err.code || ERR.INTERNAL}`,
    `Message : ${err.message}`,
    `When    : ${new Date().toISOString()}`,
    'Provider attempts:',
    ...(attempts || []).map(a => `  - ${a.provider}: ${a.ok ? 'OK' : `${a.code} — ${a.message || ''}`}`)
  ];
  const text = lines.join('\n');
  const jobs = [];
  if (NOTIFY.webhook) jobs.push(fetch(NOTIFY.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }).catch(e => log('warn', 'webhook notify failed', { message: e.message })));
  if (mailer) jobs.push(mailer.sendMail({ from: NOTIFY.from, to: NOTIFY.to, subject: `[${CONFIG.APP_NAME}] FAILED: ${pkg || 'unknown package'}`, text }).catch(e => log('warn', 'mail notify failed', { message: e.message })));
  await Promise.all(jobs);
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

app.get('/healthz', (req, res) => res.json({ ok: true, app: CONFIG.APP_NAME, providers: CONFIG.PROVIDER_ORDER, uptimeSec: Math.round(process.uptime()) }));

app.get('/api/config', (req, res) => res.json({ ok: true, appName: CONFIG.APP_NAME, providers: CONFIG.PROVIDER_ORDER, defaultRegion: CONFIG.PLAY_DEFAULT_REGION, maxProxyBytes: CONFIG.MAX_PROXY_BYTES }));

app.get('/api/resolve', rateLimit, async (req, res) => {
  const input = String(req.query.input || req.query.url || req.query.id || '');
  const started = Date.now();
  const result = await resolveApk(input, { log, notifyFailure });
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
