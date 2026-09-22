'use strict';
/**
 * Low-memory fallback for XAPK -> APK when APKEditor cannot run (e.g. Java heap exhausted on a 512 MB instance).
 *
 * What it does, entirely in Node with streaming zips:
 *   base.apk  +  every lib/<abi>/*.so from the config.<abi>.apk splits  ->  one APK
 *   AndroidManifest.xml (binary AXML) patched in place, byte-for-byte same size:
 *     android:isSplitRequired  -> false      (else the installer says INSTALL_FAILED_MISSING_SPLIT)
 *     android:extractNativeLibs -> true      (libs are stored compressed; no page-alignment needed)
 *     android:requiredSplitTypes / splitTypes -> un-namespaced (ignored by the installer on API 34+)
 *   META-INF/* signature files dropped; caller re-signs.
 *
 * Trade-off vs. a real merge: density / language split resources are NOT merged. bundletool keeps a default
 * variant of every resource in the base module, so the app runs, but with default-density artwork and
 * English-only strings. The UI tells the user this.
 */
const fs = require('fs');
const { PassThrough } = require('stream');
const yauzl = require('yauzl');
const yazl = require('yazl');

// android attribute resource ids
const ATTR = { isSplitRequired: 0x01010591, extractNativeLibs: 0x010104ea, requiredSplitTypes: 0x0101064e, splitTypes: 0x0101064f };

/** Patch a binary AndroidManifest.xml buffer in place. Returns { patched: [names] }. */
function patchManifest(buf) {
  const patched = [];
  if (buf.readUInt16LE(0) !== 0x0003) throw new Error('not a binary XML');
  let off = 8;
  let resMap = null;                                     // string index -> attribute resource id
  while (off + 8 <= buf.length) {
    const type = buf.readUInt16LE(off), hdr = buf.readUInt16LE(off + 2), size = buf.readUInt32LE(off + 4);
    if (size < 8) break;
    if (type === 0x0180) {                               // RES_XML_RESOURCE_MAP_TYPE
      resMap = [];
      for (let p = off + hdr; p + 4 <= off + size; p += 4) resMap.push(buf.readUInt32LE(p));
    } else if (type === 0x0102) {                        // RES_XML_START_ELEMENT_TYPE
      const ext = off + hdr;                             // ResXMLTree_attrExt
      const attrStart = buf.readUInt16LE(ext + 8), attrSize = buf.readUInt16LE(ext + 10), attrCount = buf.readUInt16LE(ext + 12);
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize;
        const nameIdx = buf.readUInt32LE(a + 4);
        const resId = resMap && nameIdx < resMap.length ? resMap[nameIdx] : 0;
        if (resId === ATTR.isSplitRequired) { buf.writeUInt32LE(0, a + 16); patched.push('isSplitRequired=false'); }
        else if (resId === ATTR.extractNativeLibs) { buf.writeUInt32LE(0xffffffff, a + 16); patched.push('extractNativeLibs=true'); }
        else if (resId === ATTR.requiredSplitTypes || resId === ATTR.splitTypes) { buf.writeUInt32LE(0xffffffff, a); patched.push((resId === ATTR.splitTypes ? 'splitTypes' : 'requiredSplitTypes') + ' neutralised'); }
      }
    }
    off += size;
  }
  return { patched };
}

function openZip(file) { return new Promise((res, rej) => yauzl.open(file, { lazyEntries: true, autoClose: false }, (e, z) => e ? rej(e) : res(z))); }
function entriesOf(zip) {
  return new Promise((res, rej) => { const out = []; zip.on('entry', en => { out.push(en); zip.readEntry(); }); zip.on('end', () => res(out)); zip.on('error', rej); zip.readEntry(); });
}
function streamOf(zip, entry) { return new Promise((res, rej) => zip.openReadStream(entry, (e, s) => e ? rej(e) : res(s))); }
/**
 * A stream that opens the zip entry only when yazl actually starts consuming it. Opening every entry's stream up
 * front makes each one pre-buffer 64 KB (and inflate), which for a few thousand entries pins hundreds of MB —
 * enough to get the 512 MB Render instance OOM-killed. Lazy = one entry in flight at a time.
 */
function lazyStreamOf(zip, entry) {
  const pt = new PassThrough({ highWaterMark: 64 * 1024 });
  let opened = false;
  const open = () => { if (opened) return; opened = true; zip.openReadStream(entry, (e, s) => { if (e) return pt.destroy(e); s.on('error', err => pt.destroy(err)); s.pipe(pt); }); };
  pt.once('resume', open);
  pt.once('pipe', open);          // in case a consumer pipes without resuming first
  return pt;
}
function bufferOf(zip, entry) { return streamOf(zip, entry).then(s => new Promise((res, rej) => { const b = []; s.on('data', d => b.push(d)); s.on('end', () => res(Buffer.concat(b))); s.on('error', rej); })); }

/**
 * @param {string} baseApk   path to extracted base.apk
 * @param {string[]} splitApks paths to config split apks (any; only lib/ entries are taken)
 * @param {string} out       output apk path (unsigned)
 * @returns {Promise<{libs:number, patched:string[], skippedSplits:string[]}>}
 */
async function lightMerge(baseApk, splitApks, out) {
  const zf = new yazl.ZipFile();
  const done = new Promise((res, rej) => { const w = fs.createWriteStream(out); zf.outputStream.pipe(w); w.on('close', res); w.on('error', rej); });
  const seen = new Set();
  let patched = [], libs = 0; const skipped = [];

  const base = await openZip(baseApk);
  for (const en of await entriesOf(base)) {
    const n = en.fileName;
    if (/\/$/.test(n) || /^META-INF\/.*\.(RSA|DSA|EC|SF|MF)$/i.test(n)) continue;
    seen.add(n);
    // resources.arsc must stay STORED (Android 11+ rejects a compressed one); keep original method for the rest
    const stored = en.compressionMethod === 0 || /^resources\.arsc$/.test(n);
    if (n === 'AndroidManifest.xml') {
      const buf = await bufferOf(base, en);
      patched = patchManifest(buf).patched;
      zf.addBuffer(buf, n, { compress: !stored });
    } else {
      zf.addReadStream(lazyStreamOf(base, en), n, { compress: !stored });
    }
  }
  for (const sp of splitApks) {
    const z = await openZip(sp);
    let took = 0;
    for (const en of await entriesOf(z)) {
      const n = en.fileName;
      if (!/^lib\/[^/]+\/[^/]+\.so$/.test(n) || seen.has(n)) continue;
      seen.add(n); libs++; took++;
      zf.addReadStream(lazyStreamOf(z, en), n, { compress: true });
    }
    if (!took) skipped.push(sp.split('/').pop());
  }
  zf.end();
  await done;
  try { base.close(); } catch { /* ignore */ }
  return { libs, patched, skippedSplits: skipped };
}

module.exports = { lightMerge, patchManifest };
