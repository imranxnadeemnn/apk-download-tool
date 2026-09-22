#!/usr/bin/env node
'use strict';
/**
 * Build-time setup for XAPK -> APK conversion (runs from `npm install` via postinstall).
 * Fetches, if missing:
 *   tools/jars/APKEditor.jar        (REAndroid/APKEditor, merges split APKs)
 *   tools/jars/uber-apk-signer.jar  (patrickfav/uber-apk-signer, signs + zipaligns)
 *   .jre/                           (Temurin JRE 17, only when no `java` is on PATH — e.g. Render's Node image)
 * Never fails the install: without these the tool still works, only the "Get installable APK" button is disabled.
 * Set SKIP_JAVA_SETUP=1 to skip entirely.
 */
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

if (process.env.SKIP_JAVA_SETUP) { console.log('[setup-java] skipped (SKIP_JAVA_SETUP)'); process.exit(0); }

const ROOT = path.join(__dirname, '..');
const JARS = path.join(ROOT, 'tools', 'jars');
const JRE = path.join(ROOT, '.jre');
const FILES = [
  { name: 'APKEditor.jar', url: 'https://github.com/REAndroid/APKEditor/releases/download/V1.4.9/APKEditor-1.4.9.jar', minBytes: 5e6 },
  { name: 'uber-apk-signer.jar', url: 'https://github.com/patrickfav/uber-apk-signer/releases/download/v1.3.0/uber-apk-signer-1.3.0.jar', minBytes: 2e6 }
];
const JRE_URL = process.env.JRE_URL || 'https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jre/hotspot/normal/eclipse';

async function download(url, dest) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

(async () => {
  fs.mkdirSync(JARS, { recursive: true });
  for (const f of FILES) {
    const dest = path.join(JARS, f.name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > f.minBytes) { console.log(`[setup-java] ${f.name} present`); continue; }
    try { const n = await download(f.url, dest); console.log(`[setup-java] fetched ${f.name} (${(n / 1e6).toFixed(1)} MB)`); }
    catch (e) { console.warn(`[setup-java] could not fetch ${f.name}: ${e.message} — conversion will be unavailable`); }
  }
  const hasJava = spawnSync('java', ['-version'], { stdio: 'ignore' }).status === 0;
  const hasLocalJre = fs.existsSync(path.join(JRE, 'bin', 'java'));
  if (hasJava || hasLocalJre) { console.log(`[setup-java] java available (${hasJava ? 'system' : '.jre'})`); return; }
  if (process.platform !== 'linux' || process.arch !== 'x64') { console.warn('[setup-java] no java and not linux/x64 — skipping JRE download'); return; }
  try {
    const tgz = path.join(ROOT, 'jre.tar.gz');
    const n = await download(JRE_URL, tgz);
    fs.mkdirSync(JRE, { recursive: true });
    execSync(`tar -xzf "${tgz}" -C "${JRE}" --strip-components=1`);
    fs.unlinkSync(tgz);
    console.log(`[setup-java] JRE installed to .jre (${(n / 1e6).toFixed(0)} MB)`);
  } catch (e) { console.warn(`[setup-java] JRE download failed: ${e.message} — conversion will be unavailable`); }
})().catch(e => { console.warn('[setup-java] ' + e.message); });
