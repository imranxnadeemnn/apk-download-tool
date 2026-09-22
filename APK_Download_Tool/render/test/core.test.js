'use strict';
// Offline unit tests: URL parsing, region logic, provider selection, error paths (fetch is mocked).
const assert = require('assert');
const core = require('../lib/core');

let calls = [];
function mockFetch(handler) { global.fetch = async (url, opts) => { calls.push(String(url)); return handler(String(url), opts || {}); }; }
const res = (status, body = '', headers = {}) => ({
  status, url: '', headers: new Headers(headers), body: { cancel() {} },
  text: async () => body, json: async () => JSON.parse(body), arrayBuffer: async () => new TextEncoder().encode(body).buffer
});

(async () => {
  // --- parsing -------------------------------------------------------------
  const P = core.extractPackageName;
  assert.equal(P('https://play.google.com/store/apps/details?id=com.whatsapp&hl=en_IN'), 'com.whatsapp');
  assert.equal(P('https://play.google.com/store/apps/details/Brazino777_Casino?id=com.brazino.mexico&hl=en'), 'com.brazino.mexico');
  assert.equal(P('market://details?id=com.duolingo'), 'com.duolingo');
  assert.equal(P('com.spotify.music'), 'com.spotify.music');
  for (const [inp, code] of [['', 'EMPTY_INPUT'], ['https://apkpure.com/x/com.foo', 'NOT_PLAY_URL'], ['https://play.google.com.evil.com/store/apps/details?id=com.x.y', 'NOT_PLAY_URL'], ['https://play.google.com/store/apps/details?hl=en', 'INVALID_PACKAGE'], ['https://play.google.com/store/apps/details?id=1bad.pkg', 'INVALID_PACKAGE']]) {
    assert.throws(() => P(inp), e => e.code === code, inp);
  }
  assert.deepEqual(core.extractStoreHints('https://play.google.com/store/apps/details?id=com.brazino.mexico&hl=es&gl=MX'), { gl: 'MX', hl: 'es' });

  // --- geo-restricted app found only in MX; Aptoide has it ---------------------
  const playHtml = '<script type="application/ld+json">{"name":"Brazino777 Casino","author":{"name":"Fiesta Fortunes"},"image":"https://i/x.png","offers":[{"price":"0"}]}</script>';
  mockFetch((url) => {
    if (url.includes('play.google.com')) return res(/gl=MX/.test(url) ? 200 : 404, playHtml);
    if (url.includes('d.apkpure.com')) return res(403);
    if (url.includes('listAppVersions')) return res(200, JSON.stringify({ list: [{ id: 7, package: 'com.brazino.mexico', file: { vercode: 3, vername: '2.0', malware: { rank: 'TRUSTED' } } }] }));
    if (url.includes('getMeta')) return res(200, JSON.stringify({ data: { file: { vercode: 3, vername: '2.0', filesize: 12345, path: 'https://pool.apk.aptoide.com/s/x.apk', malware: { rank: 'TRUSTED' } }, store: { name: 's' } } }));
    return res(404);
  });
  calls = [];
  let r = await core.resolveApk('https://play.google.com/store/apps/details?id=com.brazino.mexico&hl=es&gl=MX');
  assert.equal(r.ok, true); assert.equal(r.app.region, 'MX'); assert.deepEqual(r.app.regionsTried, ['MX']); assert.equal(r.app.geoRestricted, true);
  assert.equal(r.download.provider, 'Aptoide'); assert.equal(r.download.version, '2.0'); assert.ok(r.download.proxyUrl.startsWith('/api/download?u='));
  assert.deepEqual(r.attempts.map(a => a.provider + ':' + a.ok), ['apkpure:false', 'aptoide:true']);

  // same package, no gl hint -> IN first, then batches; must still land on MX
  calls = [];
  r = await core.resolveApk('com.brazino.mexico');
  assert.equal(r.ok, true); assert.equal(r.app.region, 'MX'); assert.equal(r.app.regionsTried[0], 'IN');
  assert.equal(r.cached, true, 'second lookup should hit the cache');

  // --- all mirrors fail -> NO_PROVIDER with browser fallback links -------------
  core.CONFIG.RESULT_CACHE_SEC = 0;
  mockFetch((url) => url.includes('play.google.com') ? res(/gl=MX/.test(url) ? 200 : 404, playHtml) : url.includes('d.apkpure.com') ? res(403) : url.includes('apkcombo.com/genericApp') ? res(410) : res(404));
  r = await core.resolveApk('com.brazino.mx2');
  assert.equal(r.ok, false); assert.equal(r.error.code, 'NO_PROVIDER'); assert.ok(r.error.details.fallbackLinks.length >= 5); assert.equal(r.error.details.app.region, 'MX');

  // --- on no Play region at all + no mirror -> APP_NOT_FOUND -------------------
  mockFetch(() => res(404));
  r = await core.resolveApk('com.nowhere.zz');
  assert.equal(r.ok, false); assert.equal(r.error.code, 'APP_NOT_FOUND'); assert.equal(r.error.details.app.unlisted, true);
  assert.equal(r.error.details.app.regionsTried.length, core.CONFIG.PLAY_MAX_REGION_LOOKUPS);

  // --- paid app stops immediately ------------------------------------------------
  mockFetch(() => res(200, '<script type="application/ld+json">{"name":"Pro","offers":[{"price":"4.99"}]}</script>'));
  r = await core.resolveApk('com.paid.app');
  assert.equal(r.error.code, 'PAID_APP');

  // --- APKPure redirect path ----------------------------------------------------
  mockFetch((url, opts) => {
    if (url.includes('play.google.com')) return res(200, playHtml);
    if (url.includes('d.apkpure.com/b/APK/')) return res(302, '', { location: 'https://d.cdn.winudf.com/x/com.brazino.mexico_2.0.apk?k=1' });
    if (url.includes('winudf.com')) return res(206, 'PK\x03\x04', { 'content-range': 'bytes 0-3/55555555', 'content-type': 'application/vnd.android.package-archive' });
    return res(404);
  });
  r = await core.resolveApk('com.brazino.fresh');
  assert.equal(r.ok, true); assert.equal(r.download.provider, 'APKPure'); assert.equal(r.download.sizeBytes, 55555555); assert.equal(r.download.version, '2.0'); assert.equal(r.download.kind, 'APK');

  console.log('ALL TESTS PASSED');
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
