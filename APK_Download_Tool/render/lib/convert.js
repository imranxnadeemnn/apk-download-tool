'use strict';
/**
 * XAPK -> single installable APK conversion.
 *
 * An XAPK is a ZIP with manifest.json + base.apk + config.*.apk splits (+ optional OBB expansion files).
 * Android cannot install an XAPK directly; a plain .apk it can.  Two cases:
 *
 *  1. The bundle holds ONE apk (base only, maybe with OBB): we extract base.apk untouched — the developer's
 *     signature is preserved.
 *  2. The bundle holds base + splits: APKEditor (https://github.com/REAndroid/APKEditor) merges them into one
 *     universal APK, then uber-apk-signer signs it (v1+v2+v3, zipaligned).  The merged file is signed with the
 *     tool's own debug key, so it installs as a fresh app but will NOT update a Play-installed copy.
 *
 * Jobs run one at a time (Render free = 512 MB RAM), files live in os.tmpdir() and are removed after
 * CONVERT_TTL_SEC.  Java + jars are fetched at build time by tools/setup-java.js.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const yauzl = require('yauzl');
const core = require('./core');

const ROOT = path.join(__dirname, '..');
const JARS = path.join(ROOT, 'tools', 'jars');
const CFG = {
  javaBin: process.env.JAVA_BIN || (fs.existsSync(path.join(ROOT, '.jre', 'bin', 'java')) ? path.join(ROOT, '.jre', 'bin', 'java') : 'java'),
  apkEditor: process.env.APKEDITOR_JAR || path.join(JARS, 'APKEditor.jar'),
  signer: process.env.APKSIGNER_JAR || path.join(JARS, 'uber-apk-signer.jar'),
  xmx: process.env.CONVERT_JAVA_XMX || '400m',     // free Render instance = 512 MB; node itself needs ~70 MB
  maxBytes: Number(process.env.CONVERT_MAX_BYTES || 700 * 1024 * 1024),
  ttlSec: Number(process.env.CONVERT_TTL_SEC || 1800),
  workDir: process.env.CONVERT_DIR || path.join(os.tmpdir(), 'apk-convert'),
  stepTimeoutMs: Number(process.env.CONVERT_STEP_TIMEOUT_MS || 6 * 60 * 1000)
};

const jobs = new Map();          // id -> job
const queue = [];
let running = null;

function available() {
  return fs.existsSync(CFG.apkEditor) && fs.existsSync(CFG.signer);
}

function jobId(u) { return crypto.createHash('sha1').update(u).digest('hex').slice(0, 16); }

function publicView(j) {
  return {
    id: j.id, status: j.status, step: j.step, progress: j.progress, error: j.error || null,
    fileName: j.outName, sizeBytes: j.outSize || null, sizeHuman: j.outSize ? core.humanSize(j.outSize) : null,
    sourceBytes: j.srcSize || null, downloadedBytes: j.downloaded || 0,
    resigned: j.resigned, notes: j.notes, splits: j.splits || null, hasObb: !!j.hasObb,
    downloadUrl: j.status === 'done' ? `/api/convert/${j.id}/file` : null,
    createdAt: j.createdAt, finishedAt: j.finishedAt || null, expiresAt: j.expiresAt || null
  };
}

/** Create (or reuse) a job for an XAPK url. */
function start(u, opts) {
  const id = jobId(u);
  let j = jobs.get(id);
  if (j && (j.status !== 'error' || Date.now() - Date.parse(j.createdAt) < 60000)) return j;
  j = {
    id, url: u, ref: opts.ref || '', pkg: opts.pkg || '', outName: core.sanitizeFileName(opts.name || 'app.apk'),
    status: 'queued', step: 'Waiting for a free slot', progress: 0, downloaded: 0,
    dir: path.join(CFG.workDir, id), createdAt: new Date().toISOString(), resigned: null, notes: '', log: opts.log || (() => {}),
    onDone: opts.onDone || (() => {})
  };
  jobs.set(id, j);
  queue.push(j);
  pump();
  return j;
}

function get(id) { return jobs.get(id) || null; }
function find(u) { return jobs.get(jobId(u)) || null; }

function pump() {
  if (running || !queue.length) return;
  running = queue.shift();
  run(running).catch(e => { running.status = 'error'; running.error = running.error || e.message; })
    .finally(() => { running.finishedAt = new Date().toISOString(); running.expiresAt = new Date(Date.now() + CFG.ttlSec * 1000).toISOString(); running.onDone(running); running = null; pump(); });
}

async function run(j) {
  fs.mkdirSync(j.dir, { recursive: true });
  const src = path.join(j.dir, 'bundle.xapk');
  // 1) download
  j.status = 'running'; j.step = 'Downloading bundle from mirror'; j.progress = 0.02;
  const headers = { 'User-Agent': core.CONFIG.DESKTOP_USER_AGENT, Accept: '*/*' };
  if (j.ref) headers.Referer = j.ref;
  const r = await core.httpFetch(j.url, { headers, timeoutMs: CFG.stepTimeoutMs });
  if (r.status < 200 || r.status >= 300) throw fail(j, `Mirror returned HTTP ${r.status} for the bundle.`);
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (/text\/html/.test(ct)) throw fail(j, 'Mirror returned an HTML page instead of the bundle (bot challenge).');
  j.srcSize = Number(r.headers.get('content-length') || 0) || null;
  if (j.srcSize && j.srcSize > CFG.maxBytes) throw fail(j, `Bundle is ${core.humanSize(j.srcSize)}, above the conversion cap of ${core.humanSize(CFG.maxBytes)}.`);
  await new Promise((res, rej) => {
    const out = fs.createWriteStream(src);
    const body = Readable.fromWeb(r.body);
    body.on('data', c => { j.downloaded += c.length; if (j.downloaded > CFG.maxBytes) { body.destroy(new Error('cap')); } if (j.srcSize) j.progress = 0.02 + 0.48 * (j.downloaded / j.srcSize); });
    body.on('error', rej); out.on('error', rej); out.on('finish', res);
    body.pipe(out);
  }).catch(e => { throw fail(j, e.message === 'cap' ? 'Bundle exceeded the conversion size cap.' : 'Download failed: ' + e.message); });
  const head = Buffer.alloc(4); const fd = fs.openSync(src, 'r'); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd);
  if (!(head[0] === 0x50 && head[1] === 0x4b)) throw fail(j, 'Downloaded file is not a ZIP/XAPK.');

  // 2) inspect
  j.step = 'Reading bundle manifest'; j.progress = 0.52;
  const entries = await listZip(src);
  const apks = entries.filter(e => /\.apk$/i.test(e) && !e.includes('/'));
  j.hasObb = entries.some(e => /\.obb$/i.test(e));
  let manifest = null;
  if (entries.includes('manifest.json')) { try { manifest = JSON.parse((await readZipEntry(src, 'manifest.json')).toString('utf8')); } catch { /* ignore */ } }
  const splitList = manifest && Array.isArray(manifest.split_apks) ? manifest.split_apks.map(s => s.file || s.id).filter(Boolean) : apks;
  j.splits = splitList;
  if (!apks.length) throw fail(j, 'No .apk files inside the bundle.');
  const out = path.join(j.dir, 'out.apk');

  if (apks.length === 1) {
    // 3a) single APK inside -> extract as-is (keeps the developer's signature)
    j.step = 'Extracting the APK (no re-signing needed)'; j.progress = 0.7;
    await extractZipEntry(src, apks[0], out);
    j.resigned = false;
    j.notes = 'The bundle contained a single APK; it was extracted unchanged, developer signature intact.' + (j.hasObb ? ' The OBB data file was left out — the app will download its data on first launch or you can copy the .obb manually.' : '');
  } else {
    // 3b) merge splits -> universal APK, then sign
    if (!available()) throw fail(j, 'Conversion tools (Java / APKEditor) are not installed on this server.');
    j.step = `Merging ${apks.length} split APKs into one`; j.progress = 0.6;
    const merged = path.join(j.dir, 'merged.apk');
    await runJava(j, ['-jar', CFG.apkEditor, 'm', '-i', src, '-o', merged, '-f', '-clean-meta', '-extractNativeLibs', 'true'], 'APKEditor merge');
    if (!fs.existsSync(merged)) throw fail(j, 'APKEditor produced no output.');
    j.step = 'Signing (v1+v2+v3) and zipaligning'; j.progress = 0.85;
    await runJava(j, ['-jar', CFG.signer, '-a', merged, '--allowResign', '--overwrite'], 'uber-apk-signer');
    fs.renameSync(merged, out);
    j.resigned = true;
    j.notes = `Merged ${apks.length} split APKs (${splitList.filter(s => s !== 'base.apk').map(s => s.replace(/^config\.|\.apk$/g, '')).join(', ')}) into one universal APK and re-signed it with the tool's key. Installs as a fresh app; it will not update a copy installed from Google Play, and apps that verify their own signature may refuse to run.` + (j.hasObb ? ' OBB data file left out.' : '');
  }
  const st = fs.statSync(out);
  const oh = Buffer.alloc(2); const ofd = fs.openSync(out, 'r'); fs.readSync(ofd, oh, 0, 2, 0); fs.closeSync(ofd);
  if (!(oh[0] === 0x50 && oh[1] === 0x4b) || st.size < 1024) throw fail(j, 'Output APK looks corrupt.');
  j.outPath = out; j.outSize = st.size; j.status = 'done'; j.step = 'Ready'; j.progress = 1;
  try { fs.unlinkSync(src); } catch { /* ignore */ }
  j.log('info', 'convert done', { id: j.id, pkg: j.pkg, bytes: st.size, resigned: j.resigned });
}

function fail(j, msg) { j.status = 'error'; j.error = msg; j.step = 'Failed'; j.log('warn', 'convert failed', { id: j.id, pkg: j.pkg, error: msg }); return new Error(msg); }

function runJava(j, args, label) {
  return new Promise((res, rej) => {
    const p = spawn(CFG.javaBin, [`-Xmx${CFG.xmx}`, '-Xss512k', '-XX:+UseSerialGC', '-XX:MaxMetaspaceSize=64m', '-XX:TieredStopAtLevel=1', '-Djava.awt.headless=true', ...args], { cwd: j.dir, env: { ...process.env, JAVA_TOOL_OPTIONS: '' } });
    let err = '', out = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); rej(fail(j, `${label} timed out.`)); }, CFG.stepTimeoutMs);
    p.stdout.on('data', d => { out += d; if (out.length > 20000) out = out.slice(-10000); });
    p.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-10000); });
    p.on('error', e => { clearTimeout(t); rej(fail(j, `${label} could not start (${e.message}). Is Java installed?`)); });
    p.on('close', code => {
      clearTimeout(t);
      if (code === 0) return res();
      const tail = (err || out).split('\n').filter(l => /error|exception|oom|memory/i.test(l)).slice(-3).join(' | ') || (err || out).trim().split('\n').slice(-2).join(' | ');
      rej(fail(j, `${label} failed (exit ${code}): ${tail.slice(0, 400)}`));
    });
  });
}

function listZip(file) {
  return new Promise((res, rej) => {
    yauzl.open(file, { lazyEntries: true }, (e, zip) => {
      if (e) return rej(e);
      const names = [];
      zip.on('entry', en => { names.push(en.fileName); zip.readEntry(); });
      zip.on('end', () => res(names)); zip.on('error', rej);
      zip.readEntry();
    });
  });
}
function readZipEntry(file, name) {
  return new Promise((res, rej) => {
    yauzl.open(file, { lazyEntries: true }, (e, zip) => {
      if (e) return rej(e);
      zip.on('entry', en => {
        if (en.fileName !== name) return zip.readEntry();
        zip.openReadStream(en, (e2, s) => { if (e2) return rej(e2); const bufs = []; s.on('data', d => bufs.push(d)); s.on('end', () => { zip.close(); res(Buffer.concat(bufs)); }); s.on('error', rej); });
      });
      zip.on('end', () => rej(new Error(name + ' not in zip'))); zip.on('error', rej);
      zip.readEntry();
    });
  });
}
function extractZipEntry(file, name, dest) {
  return new Promise((res, rej) => {
    yauzl.open(file, { lazyEntries: true }, (e, zip) => {
      if (e) return rej(e);
      zip.on('entry', en => {
        if (en.fileName !== name) return zip.readEntry();
        zip.openReadStream(en, (e2, s) => { if (e2) return rej(e2); const w = fs.createWriteStream(dest); s.pipe(w); w.on('finish', () => { zip.close(); res(); }); w.on('error', rej); s.on('error', rej); });
      });
      zip.on('end', () => rej(new Error(name + ' not in zip'))); zip.on('error', rej);
      zip.readEntry();
    });
  });
}

/** Remove expired jobs and their files. */
function sweep() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    const done = j.status === 'done' || j.status === 'error';
    if (done && j.expiresAt && Date.parse(j.expiresAt) < now) {
      try { fs.rmSync(j.dir, { recursive: true, force: true }); } catch { /* ignore */ }
      jobs.delete(id);
    }
  }
}
setInterval(sweep, 60000).unref();
try { fs.rmSync(CFG.workDir, { recursive: true, force: true }); } catch { /* fresh start */ }

module.exports = { start, get, find, publicView, available, CFG, jobsCount: () => jobs.size };
