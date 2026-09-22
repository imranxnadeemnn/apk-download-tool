/**
 * APK Download Tool — Google Apps Script Web App
 * ------------------------------------------------
 * Paste a Google Play Store URL (or a bare package name), get a direct APK
 * download link resolved from free public mirrors, with an optional
 * "save to Google Drive" fallback for smaller files.
 *
 * Provider chain (in order, configurable in CONFIG.PROVIDER_ORDER):
 *   1. APKPure   — https://d.apkpure.com/b/APK/<pkg>?version=latest  (302 → CDN file)
 *   2. Aptoide   — https://ws75.aptoide.com/api/7/listAppVersions?package_name=<pkg>
 *                  (public JSON API, no auth; we only accept malware.rank == TRUSTED)
 *   3. APKCombo  — https://apkcombo.com/genericApp/<pkg>/download/apk  (+ /checkin token)
 *
 * Every public-facing function returns a plain object { ok: true, ... } or
 * { ok: false, error: { code, message, hint } } so the UI can always render
 * something sensible. Nothing throws across the google.script.run boundary.
 */

// ============================================================================
// CONFIG
// ============================================================================
var CONFIG = {
  APP_NAME: 'APK Download Tool',

  // Order in which providers are tried. Remove one to disable it.
  // Aptoide first: it is a real JSON API and works from Google's servers.
  // APKPure / APKCombo sit behind Cloudflare and usually 403 Apps Script's IPs,
  // so they act as opportunistic fallbacks (they cost ~1 fetch each when blocked).
  PROVIDER_ORDER: ['aptoide', 'apkpure', 'fdroid', 'apkcombo'],

  // Google Play is region-scoped: an app that is not published in India returns 404 on
  // play.google.com with gl=IN. We therefore look the package up in several country
  // stores, starting with the gl= the user's link carried, then this list.
  PLAY_REGIONS: ['IN', 'US', 'GB', 'MX', 'BR', 'DE', 'FR', 'ES', 'IT', 'JP', 'KR', 'ID', 'PH', 'VN', 'TR', 'RU', 'AE', 'SA', 'NG', 'ZA', 'CA', 'AU', 'AR', 'CO', 'CL'],
  PLAY_DEFAULT_REGION: 'IN',
  PLAY_MAX_REGION_LOOKUPS: 12,       // cap on Play fetches per request (each is ~0.5 s)

  // If the app is on no Play region at all (delisted, or only on other stores), still try
  // the mirrors — the UI shows a clear "not on Google Play" warning in that case.
  ALLOW_UNLISTED_APPS: true,

  // Apps Script's UrlFetchApp cannot return responses > 50 MB, so the
  // "save to Drive" fallback is only offered below this threshold.
  MAX_DRIVE_FETCH_BYTES: 45 * 1024 * 1024,

  // Drive folder where saved APKs land (created on first use).
  DRIVE_FOLDER_NAME: 'APK Download Tool',

  // Per-user rate limit: max requests per window.
  RATE_LIMIT_MAX: 30,
  RATE_LIMIT_WINDOW_SEC: 600,

  // Cache successful resolutions per package for this long (seconds).
  RESULT_CACHE_SEC: 1800,

  // Notifications ------------------------------------------------------------
  // Leave NOTIFY_EMAIL blank to send to the script owner (Session.getEffectiveUser()).
  NOTIFY_EMAIL: '',
  NOTIFY_ON_FAILURE: true,          // e-mail when *all* providers fail or an internal error occurs
  NOTIFY_ON_SUCCESS: false,         // e-mail on every successful resolution (noisy; off by default)
  NOTIFY_THROTTLE_SEC: 300,         // don't send more than one failure e-mail per package per window

  // Optional Google Sheet for an audit log. Leave blank to log only to Logger/Stackdriver.
  LOG_SHEET_ID: '',

  // Browser-like UA; some mirrors reject the default Apps Script UA.
  USER_AGENT: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
  DESKTOP_USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'
};

// ============================================================================
// ERRORS
// ============================================================================
/**
 * Structured error carried across layers. `code` is stable and machine-readable,
 * `message` is human-readable, `hint` tells the user what to try next.
 */
function ApkToolError(code, message, hint, details) {
  this.name = 'ApkToolError';
  this.code = code;
  this.message = message;
  this.hint = hint || '';
  this.details = details || null;
  this.stack = (new Error()).stack;
}
ApkToolError.prototype = Object.create(Error.prototype);
ApkToolError.prototype.constructor = ApkToolError;

var ERR = {
  EMPTY_INPUT:      'EMPTY_INPUT',
  INVALID_URL:      'INVALID_URL',
  NOT_PLAY_URL:     'NOT_PLAY_URL',
  INVALID_PACKAGE:  'INVALID_PACKAGE',
  APP_NOT_FOUND:    'APP_NOT_FOUND',
  PAID_APP:         'PAID_APP',
  PLAY_UNREACHABLE: 'PLAY_UNREACHABLE',
  PROVIDER_BLOCKED: 'PROVIDER_BLOCKED',
  PROVIDER_MISS:    'PROVIDER_MISS',
  NO_PROVIDER:      'NO_PROVIDER',
  TOO_LARGE:        'TOO_LARGE_FOR_DRIVE',
  DRIVE_ERROR:      'DRIVE_ERROR',
  RATE_LIMITED:     'RATE_LIMITED',
  INTERNAL:         'INTERNAL_ERROR'
};

function toErrorPayload_(e) {
  if (e && e.name === 'ApkToolError') {
    return { ok: false, error: { code: e.code, message: e.message, hint: e.hint, details: e.details } };
  }
  var msg = (e && e.message) ? e.message : String(e);
  return {
    ok: false,
    error: {
      code: ERR.INTERNAL,
      message: 'Something went wrong on the server: ' + msg,
      hint: 'Please try again in a minute. If it keeps happening, check the script\'s execution log.'
    }
  };
}

// ============================================================================
// WEB APP ENTRY POINTS
// ============================================================================
function doGet(e) {
  var tpl = HtmlService.createTemplateFromFile('Index');
  tpl.appName = CONFIG.APP_NAME;
  // Deep links: .../exec?url=<Play URL>  or  .../exec?id=<package>
  var p = (e && e.parameter) || {};
  tpl.prefill = String(p.url || p.id || '').slice(0, 500);
  return tpl.evaluate()
    .setTitle(CONFIG.APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Lets Index.html include other HTML partials if you split it later. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** Config the client needs (never leak e-mail or sheet ids). */
function getClientConfig() {
  return {
    ok: true,
    appName: CONFIG.APP_NAME,
    maxDriveBytes: CONFIG.MAX_DRIVE_FETCH_BYTES,
    providers: CONFIG.PROVIDER_ORDER
  };
}

/**
 * MAIN ACTION — called from the UI via google.script.run.resolveApk(input).
 * @param {string} input Play Store URL, market:// URL, or bare package name.
 * @return {Object} { ok, package, app:{...}, download:{...}, attempts:[...] } or error payload.
 */
function resolveApk(input) {
  var started = Date.now();
  var pkg = null;
  try {
    enforceRateLimit_();
    pkg = extractPackageName(input);
    var hints = extractStoreHints_(input);          // { gl, hl } from the pasted link, if any

    // 1. Validate against Google Play (existence + free/paid + metadata), trying several regions
    var app = fetchPlayMetadataAnyRegion_(pkg, hints);

    // 2. Cached result?
    var cache = CacheService.getScriptCache();
    var cached = cache.get('apk:' + pkg);
    if (cached) {
      var hit = JSON.parse(cached);
      hit.app = app;
      hit.cached = true;
      hit.elapsedMs = Date.now() - started;
      log_('INFO', 'cache hit', { pkg: pkg });
      return hit;
    }

    // 3. Walk provider chain
    var attempts = [];
    var download = null;
    for (var i = 0; i < CONFIG.PROVIDER_ORDER.length; i++) {
      var name = CONFIG.PROVIDER_ORDER[i];
      var fn = PROVIDERS_[name];
      if (!fn) { attempts.push({ provider: name, ok: false, code: 'UNKNOWN_PROVIDER' }); continue; }
      try {
        download = fn(pkg, app);
        attempts.push({ provider: name, ok: true });
        break;
      } catch (pe) {
        var code = pe.code || ERR.INTERNAL;
        attempts.push({ provider: name, ok: false, code: code, message: pe.message });
        log_('WARN', 'provider failed', { pkg: pkg, provider: name, code: code, message: pe.message });
      }
    }

    if (!download) {
      var err;
      if (app.unlisted) {
        // Not on Play in any country we checked AND on no mirror: almost certainly a wrong package name.
        err = new ApkToolError(
          ERR.APP_NOT_FOUND,
          '"' + pkg + '" is not listed on Google Play in any of ' + app.regionsTried.length + ' countries (' + app.regionsTried.join(', ') + ') and no mirror carries it.',
          'Double-check the package name (they are case-sensitive). If the app was recently removed from Play, the browser-side mirror links below may still work.',
          { attempts: attempts, app: app, fallbackLinks: browserFallbackLinks_(pkg, app) }
        );
      } else {
        err = new ApkToolError(
          ERR.NO_PROVIDER,
          'Google Play lists "' + app.title + '" in the ' + app.region + ' store, but none of the server-side mirrors could supply its APK.',
          (app.geoRestricted ? 'This app is geo-restricted (not in the ' + CONFIG.PLAY_DEFAULT_REGION + ' store). ' : '') +
          'Mirrors such as APKPure block Google\'s servers but usually work from a normal browser — use the "Try from your browser" links below.',
          { attempts: attempts, app: app, fallbackLinks: browserFallbackLinks_(pkg, app) }
        );
      }
      notifyFailure_(pkg, app, err, attempts);
      logSheet_('FAIL', pkg, app.title, '', err.code, JSON.stringify(attempts));
      return toErrorPayload_(err);
    }

    download.canSaveToDrive = !!(download.sizeBytes && download.sizeBytes <= CONFIG.MAX_DRIVE_FETCH_BYTES);
    download.sizeHuman = humanSize_(download.sizeBytes);

    var result = {
      ok: true,
      package: pkg,
      app: app,
      download: download,
      attempts: attempts,
      cached: false,
      elapsedMs: Date.now() - started
    };

    try { cache.put('apk:' + pkg, JSON.stringify({ ok: true, package: pkg, download: download, attempts: attempts }), CONFIG.RESULT_CACHE_SEC); } catch (_) {}
    logSheet_('OK', pkg, app.title, download.provider, '', download.url);
    if (CONFIG.NOTIFY_ON_SUCCESS) notifySuccess_(pkg, app, download);
    return result;

  } catch (e) {
    log_('ERROR', 'resolveApk failed', { input: input, pkg: pkg, code: e.code, message: e.message, stack: e.stack });
    // Only e-mail on genuinely unexpected / systemic failures — not on user typos.
    var userFacing = [ERR.EMPTY_INPUT, ERR.INVALID_URL, ERR.NOT_PLAY_URL, ERR.INVALID_PACKAGE, ERR.APP_NOT_FOUND, ERR.PAID_APP, ERR.RATE_LIMITED];
    if (userFacing.indexOf(e.code) === -1) notifyFailure_(pkg || input, null, e, []);
    logSheet_('ERROR', pkg || '', '', '', e.code || ERR.INTERNAL, e.message);
    return toErrorPayload_(e);
  }
}

/**
 * OPTIONAL ACTION — fetch the APK server-side and store it in Drive, returning
 * a shareable link. Only works for files <= CONFIG.MAX_DRIVE_FETCH_BYTES.
 */
function saveApkToDrive(downloadUrl, fileName, expectedBytes) {
  try {
    enforceRateLimit_();
    if (!downloadUrl || !/^https?:\/\//i.test(downloadUrl)) {
      throw new ApkToolError(ERR.INVALID_URL, 'Invalid download URL.', 'Resolve the app again and retry.');
    }
    if (expectedBytes && expectedBytes > CONFIG.MAX_DRIVE_FETCH_BYTES) {
      throw new ApkToolError(ERR.TOO_LARGE, 'This APK is ' + humanSize_(expectedBytes) + ', above the ' + humanSize_(CONFIG.MAX_DRIVE_FETCH_BYTES) + ' Apps Script fetch limit.', 'Use the direct download link instead.');
    }

    var resp = UrlFetchApp.fetch(downloadUrl, {
      method: 'get', followRedirects: true, muteHttpExceptions: true,
      headers: { 'User-Agent': CONFIG.USER_AGENT }
    });
    var status = resp.getResponseCode();
    if (status < 200 || status >= 300) {
      throw new ApkToolError(ERR.PROVIDER_BLOCKED, 'The mirror returned HTTP ' + status + ' when fetching the file.', 'Try the direct link in your browser — mirrors sometimes block server-side downloads.');
    }
    var blob = resp.getBlob();
    var bytes = blob.getBytes();
    if (bytes.length < 1024 || !looksLikeZip_(bytes)) {
      throw new ApkToolError(ERR.PROVIDER_BLOCKED, 'The mirror returned something that is not an APK (probably an HTML challenge page).', 'Use the direct download link in your browser instead.');
    }

    var safeName = sanitizeFileName_(fileName || 'app.apk');
    blob.setName(safeName);
    blob.setContentType('application/vnd.android.package-archive');

    var folder = getOrCreateFolder_(CONFIG.DRIVE_FOLDER_NAME);
    var file = folder.createFile(blob);
    try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (shareErr) {
      // Domain policy may forbid link-sharing; the owner can still download it.
      log_('WARN', 'could not set sharing', { message: shareErr.message });
    }

    logSheet_('DRIVE', '', safeName, '', '', file.getUrl());
    return {
      ok: true,
      fileId: file.getId(),
      fileName: safeName,
      sizeBytes: bytes.length,
      sizeHuman: humanSize_(bytes.length),
      viewUrl: file.getUrl(),
      downloadUrl: 'https://drive.google.com/uc?export=download&id=' + file.getId()
    };
  } catch (e) {
    if (e.name !== 'ApkToolError') {
      // Typical: "Exceeded maximum file size" / "Address unavailable" / quota errors
      var m = String(e.message || e);
      var wrapped = /size|too large|exceed/i.test(m)
        ? new ApkToolError(ERR.TOO_LARGE, 'The file is too large for Apps Script to fetch (50 MB limit).', 'Use the direct download link instead.', m)
        : new ApkToolError(ERR.DRIVE_ERROR, 'Could not save the file to Drive: ' + m, 'Check Drive storage quota and that the script is authorised for Drive access.', m);
      log_('ERROR', 'saveApkToDrive failed', { url: downloadUrl, message: m });
      return toErrorPayload_(wrapped);
    }
    log_('WARN', 'saveApkToDrive rejected', { url: downloadUrl, code: e.code, message: e.message });
    return toErrorPayload_(e);
  }
}

// ============================================================================
// INPUT PARSING & PLAY STORE VALIDATION
// ============================================================================
var PACKAGE_RE_ = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/**
 * Accepts:
 *   https://play.google.com/store/apps/details?id=com.foo.bar&hl=en
 *   play.google.com/store/apps/details?id=com.foo.bar
 *   market://details?id=com.foo.bar
 *   com.foo.bar
 * Throws ApkToolError on anything else.
 */
function extractPackageName(input) {
  var raw = (input == null ? '' : String(input)).trim();
  if (!raw) {
    throw new ApkToolError(ERR.EMPTY_INPUT, 'Please paste a Google Play Store URL.', 'Example: https://play.google.com/store/apps/details?id=com.whatsapp');
  }

  // Bare package name
  if (PACKAGE_RE_.test(raw)) return raw;

  // market:// deep link
  var m = raw.match(/^market:\/\/details\?(.*)$/i);
  if (m) {
    var id = queryParam_(m[1], 'id');
    if (id && PACKAGE_RE_.test(id)) return id;
    throw new ApkToolError(ERR.INVALID_PACKAGE, 'The market:// link does not contain a valid package id.', 'It should look like market://details?id=com.example.app');
  }

  // Normalise URL
  var url = raw;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  var parts = url.match(/^https?:\/\/([^\/?#]+)([^?#]*)(\?[^#]*)?/i);
  if (!parts) {
    throw new ApkToolError(ERR.INVALID_URL, 'That does not look like a valid URL.', 'Copy the link from the address bar of the Play Store page.');
  }
  var host = parts[1].toLowerCase();
  var path = parts[2] || '';
  var query = (parts[3] || '').replace(/^\?/, '');

  if (!/(^|\.)play\.google\.com$/.test(host)) {
    throw new ApkToolError(ERR.NOT_PLAY_URL, 'Only Google Play Store links are supported (play.google.com).', 'You entered a link on "' + host + '". Open the app in Google Play and copy that URL instead.');
  }
  if (!/^\/store\/apps\/details\/?$/.test(path)) {
    throw new ApkToolError(ERR.NOT_PLAY_URL, 'This is a Play Store link, but not an app page.', 'App pages look like https://play.google.com/store/apps/details?id=<package>');
  }
  var pkg = queryParam_(query, 'id');
  if (!pkg) {
    throw new ApkToolError(ERR.INVALID_PACKAGE, 'The link is missing the "id=" parameter with the package name.', 'Example: https://play.google.com/store/apps/details?id=com.whatsapp');
  }
  if (!PACKAGE_RE_.test(pkg)) {
    throw new ApkToolError(ERR.INVALID_PACKAGE, '"' + pkg + '" is not a valid Android package name.', 'Package names look like com.company.app');
  }
  return pkg;
}

function queryParam_(query, key) {
  var pairs = String(query || '').split('&');
  for (var i = 0; i < pairs.length; i++) {
    var kv = pairs[i].split('=');
    if (decodeURIComponent(kv[0] || '') === key) {
      try { return decodeURIComponent((kv[1] || '').replace(/\+/g, ' ')).trim(); } catch (_) { return (kv[1] || '').trim(); }
    }
  }
  return null;
}

/** Pulls gl= (country) and hl= (language) out of a pasted Play link, if present. */
function extractStoreHints_(input) {
  var s = String(input || '');
  var q = s.indexOf('?') >= 0 ? s.slice(s.indexOf('?') + 1).split('#')[0] : '';
  var gl = queryParam_(q, 'gl'), hl = queryParam_(q, 'hl');
  return {
    gl: gl && /^[A-Za-z]{2}$/.test(gl) ? gl.toUpperCase() : null,
    hl: hl && /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/.test(hl) ? hl : null
  };
}

/**
 * Looks the package up across Play country stores. Order: gl= from the link, the default
 * region, then CONFIG.PLAY_REGIONS. Stops at the first store that lists the app.
 * Returns app metadata with .region (where found) and .regionsTried; if the app is on no
 * region at all, returns a stub with .unlisted=true when CONFIG.ALLOW_UNLISTED_APPS, else throws.
 */
function fetchPlayMetadataAnyRegion_(pkg, hints) {
  var order = [];
  function add(r) { r = (r || '').toUpperCase(); if (r && order.indexOf(r) === -1) order.push(r); }
  add(hints && hints.gl); add(CONFIG.PLAY_DEFAULT_REGION); CONFIG.PLAY_REGIONS.forEach(add);
  order = order.slice(0, CONFIG.PLAY_MAX_REGION_LOOKUPS);

  var tried = [], lastErr = null;
  for (var i = 0; i < order.length; i++) {
    var gl = order[i];
    tried.push(gl);
    try {
      var app = fetchPlayMetadata_(pkg, gl, (hints && hints.hl) || 'en');
      app.region = gl;
      app.regionsTried = tried.slice();
      app.geoRestricted = gl !== CONFIG.PLAY_DEFAULT_REGION;   // not listed in the default store
      app.unlisted = false;
      return app;
    } catch (e) {
      if (e && e.code === ERR.APP_NOT_FOUND) { lastErr = e; continue; }   // try the next country
      throw e;                                                              // PAID_APP / PLAY_UNREACHABLE: stop
    }
  }

  if (!CONFIG.ALLOW_UNLISTED_APPS) {
    throw new ApkToolError(ERR.APP_NOT_FOUND,
      'No Play Store listing for "' + pkg + '" in any of ' + tried.length + ' countries (' + tried.join(', ') + ').',
      'The app may have been removed from Google Play, or is only distributed outside Play. Check the package name.');
  }
  log_('WARN', 'not on Play in any region; continuing to mirrors', { pkg: pkg, tried: tried });
  return {
    package: pkg, title: pkg, developer: '', icon: '', price: '0', free: true,
    playUrl: 'https://play.google.com/store/apps/details?id=' + encodeURIComponent(pkg),
    region: null, regionsTried: tried, geoRestricted: true, unlisted: true
  };
}

/**
 * Fetches the Play Store listing for ONE country store and extracts title / developer / icon / price.
 * Throws APP_NOT_FOUND, PAID_APP or PLAY_UNREACHABLE.
 */
function fetchPlayMetadata_(pkg, gl, hl) {
  gl = gl || CONFIG.PLAY_DEFAULT_REGION; hl = hl || 'en';
  var url = 'https://play.google.com/store/apps/details?id=' + encodeURIComponent(pkg) + '&hl=' + encodeURIComponent(hl) + '&gl=' + encodeURIComponent(gl);
  var resp;
  try {
    resp = UrlFetchApp.fetch(url, {
      method: 'get', muteHttpExceptions: true, followRedirects: true,
      headers: { 'User-Agent': CONFIG.USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' }
    });
  } catch (e) {
    throw new ApkToolError(ERR.PLAY_UNREACHABLE, 'Could not reach Google Play to verify the app.', 'Check your network / UrlFetch quota and try again.', e.message);
  }
  var status = resp.getResponseCode();
  if (status === 404) {
    throw new ApkToolError(ERR.APP_NOT_FOUND, 'No app with package "' + pkg + '" in the ' + gl + ' Play Store.', 'Double-check the URL — package names are case-sensitive.', { region: gl });
  }
  if (status !== 200) {
    throw new ApkToolError(ERR.PLAY_UNREACHABLE, 'Google Play (' + gl + ') responded with HTTP ' + status + '.', 'Google may be rate-limiting; wait a minute and retry.');
  }

  var html = resp.getContentText();
  var app = { package: pkg, title: pkg, developer: '', icon: '', price: '0', playUrl: url, free: true };

  // Preferred: JSON-LD block
  var ld = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  if (ld) {
    try {
      var j = JSON.parse(ld[1]);
      if (j.name) app.title = decodeEntities_(String(j.name));
      if (j.author && j.author.name) app.developer = decodeEntities_(String(j.author.name));
      if (j.image) app.icon = String(j.image);
      var offer = Array.isArray(j.offers) ? j.offers[0] : j.offers;
      if (offer && offer.price != null) app.price = String(offer.price);
      if (j.aggregateRating && j.aggregateRating.ratingValue) app.rating = Number(j.aggregateRating.ratingValue).toFixed(1);
    } catch (_) { /* fall through to regex */ }
  }
  if (app.title === pkg) {
    var t = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (t) app.title = decodeEntities_(t[1].replace(/\s*-\s*Apps on Google Play\s*$/i, '').trim()) || pkg;
  }
  if (!app.price || app.price === '0') {
    var p = html.match(/itemprop="price"\s+content="([^"]*)"/i);
    if (p) app.price = p[1];
  }

  var priceNum = parseFloat(String(app.price).replace(/[^0-9.]/g, ''));
  app.free = !(priceNum > 0);
  if (!app.free) {
    throw new ApkToolError(ERR.PAID_APP, '"' + app.title + '" is a paid app (' + app.price + ').', 'Free mirrors only carry free apps. Paid apps must be bought and installed from Google Play.', { price: app.price });
  }
  return app;
}

// ============================================================================
// PROVIDERS — each returns { provider, url, fileName, sizeBytes, contentType, kind, version, versionCode, notes }
// ============================================================================
var PROVIDERS_ = {

  /** APKPure: hidden redirect endpoint. Tries APK, then XAPK (split/OBB bundles). */
  apkpure: function (pkg, app) {
    var kinds = ['APK', 'XAPK'];
    var lastCode = null;
    for (var k = 0; k < kinds.length; k++) {
      var kind = kinds[k];
      var url = 'https://d.apkpure.com/b/' + kind + '/' + encodeURIComponent(pkg) + '?version=latest';
      var resp = safeFetch_(url, { followRedirects: false, headers: { 'Referer': 'https://apkpure.com/', 'User-Agent': CONFIG.DESKTOP_USER_AGENT } });
      var status = resp.getResponseCode();
      var headers = lowerHeaders_(resp);

      if (status >= 300 && status < 400 && headers.location) {
        var loc = headers.location;
        // A redirect back to an HTML page on apkpure.com means "not available in this form".
        if (/^https?:\/\/(www\.)?apkpure\.com\//i.test(loc) && !/\.(apk|xapk)(\?|$)/i.test(loc)) { lastCode = 'REDIRECT_TO_PAGE'; continue; }
        var probe = probeFile_(loc);
        if (!probe.ok) { lastCode = probe.code; continue; }
        return {
          provider: 'APKPure',
          url: loc,
          kind: kind,
          fileName: probe.fileName || (safeBase_(app.title) + '_' + pkg + '.' + kind.toLowerCase()),
          sizeBytes: probe.sizeBytes,
          contentType: probe.contentType,
          version: probe.version || 'latest',
          notes: kind === 'XAPK' ? 'XAPK bundle — install with APKPure/SAI installer or unzip to get base APK + splits/OBB.' : ''
        };
      }
      if (status === 403 || status === 503 || status === 429) {
        throw new ApkToolError(ERR.PROVIDER_BLOCKED, 'APKPure blocked the request (HTTP ' + status + ').', '', { status: status });
      }
      lastCode = 'HTTP_' + status;
    }
    throw new ApkToolError(ERR.PROVIDER_MISS, 'APKPure has no APK for this package (' + lastCode + ').');
  },

  /**
   * Aptoide: documented public JSON API (no auth).
   *  1. listAppVersions  -> every build of the package across Aptoide stores (no download path)
   *  2. pick newest build whose malware.rank == TRUSTED (signature matches the Play developer key)
   *  3. getMeta?app_id=  -> that build's metadata incl. file.path (the direct APK URL)
   */
  aptoide: function (pkg, app) {
    var listUrl = 'https://ws75.aptoide.com/api/7/listAppVersions?package_name=' + encodeURIComponent(pkg) + '&limit=25';
    var resp = safeFetch_(listUrl, {});
    var status = resp.getResponseCode();
    if (status === 429 || status === 403) throw new ApkToolError(ERR.PROVIDER_BLOCKED, 'Aptoide blocked the request (HTTP ' + status + ').');
    if (status !== 200) throw new ApkToolError(ERR.PROVIDER_MISS, 'Aptoide returned HTTP ' + status + '.');

    var json;
    try { json = JSON.parse(resp.getContentText()); } catch (_) { throw new ApkToolError(ERR.PROVIDER_MISS, 'Aptoide returned non-JSON.'); }
    var list = (json && (json.list || (json.datalist && json.datalist.list))) || [];
    var best = null;
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it || it['package'] !== pkg || !it.file) continue;
      var rank = it.file.malware && it.file.malware.rank;
      if (rank !== 'TRUSTED') continue;
      if (!best || (Number(it.file.vercode) || 0) > (Number(best.file.vercode) || 0)) best = it;
    }
    if (!best) throw new ApkToolError(ERR.PROVIDER_MISS, 'Aptoide has no trusted-signed build of ' + pkg + '.');

    // Resolve the chosen build to a download path.
    var metaUrl = best.id
      ? 'https://ws75.aptoide.com/api/7/app/getMeta?app_id=' + encodeURIComponent(best.id)
      : 'https://ws75.aptoide.com/api/7/app/getMeta?package_name=' + encodeURIComponent(pkg);
    var mresp = safeFetch_(metaUrl, {});
    if (mresp.getResponseCode() !== 200) throw new ApkToolError(ERR.PROVIDER_MISS, 'Aptoide getMeta returned HTTP ' + mresp.getResponseCode() + '.');
    var meta;
    try { meta = JSON.parse(mresp.getContentText()); } catch (_) { throw new ApkToolError(ERR.PROVIDER_MISS, 'Aptoide getMeta returned non-JSON.'); }
    var d = meta && meta.data;
    if (!d || !d.file || !d.file.path) throw new ApkToolError(ERR.PROVIDER_MISS, 'Aptoide getMeta has no file path for ' + pkg + '.');
    if (d.file.malware && d.file.malware.rank && d.file.malware.rank !== 'TRUSTED') throw new ApkToolError(ERR.PROVIDER_MISS, 'Aptoide build is not TRUSTED-signed.');
    best = d;

    return {
      provider: 'Aptoide',
      url: best.file.path,
      kind: 'APK',
      fileName: safeBase_(app.title) + '_' + (best.file.vername || best.file.vercode) + '.apk',
      sizeBytes: Number(best.file.filesize) || null,
      contentType: 'application/vnd.android.package-archive',
      version: best.file.vername || '',
      versionCode: best.file.vercode || null,
      md5: best.file.md5sum || '',
      store: best.store && best.store.name,
      notes: 'Signature verified TRUSTED by Aptoide (matches the Play developer key). Version may lag the Play Store listing.'
    };
  },

  /** F-Droid: open-source apps only. Official JSON API, developer- or F-Droid-signed builds. */
  fdroid: function (pkg, app) {
    var resp = safeFetch_('https://f-droid.org/api/v1/packages/' + encodeURIComponent(pkg), {});
    var status = resp.getResponseCode();
    if (status === 404) throw new ApkToolError(ERR.PROVIDER_MISS, 'Not on F-Droid (closed-source or not packaged).');
    if (status !== 200) throw new ApkToolError(ERR.PROVIDER_MISS, 'F-Droid returned HTTP ' + status + '.');
    var j; try { j = JSON.parse(resp.getContentText()); } catch (_) { throw new ApkToolError(ERR.PROVIDER_MISS, 'F-Droid returned non-JSON.'); }
    var vc = j.suggestedVersionCode || (j.packages && j.packages[0] && j.packages[0].versionCode);
    if (!vc) throw new ApkToolError(ERR.PROVIDER_MISS, 'F-Droid has no build for ' + pkg + '.');
    var vn = (j.packages || []).filter(function (p) { return p.versionCode === vc; }).map(function (p) { return p.versionName; })[0] || String(vc);
    var url = 'https://f-droid.org/repo/' + encodeURIComponent(pkg) + '_' + vc + '.apk';
    var probe = probeFile_(url);
    if (!probe.ok) throw new ApkToolError(ERR.PROVIDER_MISS, 'F-Droid APK not reachable (' + probe.code + ').');
    return {
      provider: 'F-Droid', url: url, kind: 'APK',
      fileName: safeBase_(app.title) + '_' + vn + '.apk',
      sizeBytes: probe.sizeBytes, contentType: probe.contentType, version: vn, versionCode: vc,
      notes: 'Open-source build from F-Droid; may be signed with the F-Droid key rather than the Play developer key.'
    };
  },

  /** APKCombo: scrapes the download page and appends the required checkin token. */
  apkcombo: function (pkg, app) {
    var pageUrl = 'https://apkcombo.com/genericApp/' + encodeURIComponent(pkg) + '/download/apk';
    var resp = safeFetch_(pageUrl, { headers: { 'Referer': 'https://apkcombo.com/', 'User-Agent': CONFIG.DESKTOP_USER_AGENT } });
    var status = resp.getResponseCode();
    if (status === 403 || status === 503 || status === 429) throw new ApkToolError(ERR.PROVIDER_BLOCKED, 'APKCombo blocked the request (HTTP ' + status + ').');
    if (status === 404) throw new ApkToolError(ERR.PROVIDER_MISS, 'APKCombo has no page for ' + pkg + '.');
    if (status !== 200) throw new ApkToolError(ERR.PROVIDER_MISS, 'APKCombo returned HTTP ' + status + '.');

    var html = resp.getContentText();
    if (/cf-challenge|captcha|Just a moment/i.test(html)) throw new ApkToolError(ERR.PROVIDER_BLOCKED, 'APKCombo served a bot challenge.');

    var link = html.match(/href="(https?:\/\/download\.apkcombo\.com\/[^"]+\.(?:apk|xapk)[^"]*)"/i);
    if (!link) throw new ApkToolError(ERR.PROVIDER_MISS, 'No download link found on APKCombo page.');
    var fileUrl = decodeEntities_(link[1]);

    var checkin = safeFetch_('https://apkcombo.com/checkin', {});
    if (checkin.getResponseCode() === 200) {
      var token = checkin.getContentText().trim();
      if (token && token.length < 512) fileUrl += (fileUrl.indexOf('?') === -1 ? '?' : '&') + token;
    }
    var kind = /\.xapk/i.test(fileUrl) ? 'XAPK' : 'APK';
    var ver = html.match(/class="vername">\s*([^<]+)</i);
    var probe = probeFile_(fileUrl);
    return {
      provider: 'APKCombo',
      url: fileUrl,
      kind: kind,
      fileName: (probe.ok && probe.fileName) || (safeBase_(app.title) + '_' + pkg + '.' + kind.toLowerCase()),
      sizeBytes: probe.ok ? probe.sizeBytes : null,
      contentType: probe.ok ? probe.contentType : '',
      version: ver ? ver[1].trim() : 'latest',
      notes: 'Link contains a short-lived token; download promptly.'
    };
  }
};

/**
 * Links the USER's browser can open directly. Cloudflare-fronted mirrors (APKPure, APKCombo,
 * APKMirror, Uptodown) reject Google's server IPs but serve normal browsers, so when every
 * server-side provider fails we hand these to the UI as a last resort.
 */
function browserFallbackLinks_(pkg, app) {
  var q = encodeURIComponent(pkg);
  var links = [
    { label: 'APKPure — direct APK download', url: 'https://d.apkpure.com/b/APK/' + q + '?version=latest', kind: 'download', note: 'Starts the download immediately if APKPure has the app; otherwise shows their page.' },
    { label: 'APKPure — XAPK bundle', url: 'https://d.apkpure.com/b/XAPK/' + q + '?version=latest', kind: 'download', note: 'For apps that ship as split APKs / with OBB data.' },
    { label: 'APKCombo downloader', url: 'https://apkcombo.com/downloader/#package=' + q, kind: 'page', note: 'Generates the APK from the Play Store in your browser.' },
    { label: 'APKMirror search', url: 'https://www.apkmirror.com/?post_type=app_release&searchtype=apk&s=' + q, kind: 'page', note: 'Developer-signed APKs; pick the matching variant/ABI.' },
    { label: 'Uptodown search', url: 'https://en.uptodown.com/android/search/' + q, kind: 'page', note: '' }
  ];
  if (app && app.playUrl) links.push({ label: 'Open on Google Play (' + (app.region || 'any region') + ')', url: app.playUrl, kind: 'page', note: 'Install via Play if your account is in that country.' });
  return links;
}

// ============================================================================
// HTTP HELPERS
// ============================================================================
function safeFetch_(url, opts) {
  var o = {
    method: (opts && opts.method) || 'get',
    muteHttpExceptions: true,
    followRedirects: !(opts && opts.followRedirects === false),
    headers: { 'User-Agent': CONFIG.USER_AGENT, 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9' }
  };
  if (opts && opts.headers) for (var k in opts.headers) o.headers[k] = opts.headers[k];
  try {
    return UrlFetchApp.fetch(url, o);
  } catch (e) {
    // DNS failure, timeout, blocked host, etc.
    throw new ApkToolError(ERR.PROVIDER_BLOCKED, 'Network error talking to ' + hostOf_(url) + ': ' + e.message, '', e.message);
  }
}

/**
 * UrlFetchApp has no HEAD; instead we request a single byte with a Range header.
 * A 206 with Content-Range gives us total size + content type + filename
 * without downloading the file. Falls back gracefully if Range is ignored.
 */
function probeFile_(url) {
  var resp;
  try {
    resp = UrlFetchApp.fetch(url, {
      method: 'get', muteHttpExceptions: true, followRedirects: true,
      headers: { 'User-Agent': CONFIG.USER_AGENT, 'Range': 'bytes=0-3' }
    });
  } catch (e) {
    return { ok: false, code: 'PROBE_NETWORK', message: e.message };
  }
  var status = resp.getResponseCode();
  var h = lowerHeaders_(resp);
  if (status === 403 || status === 404 || status === 410) return { ok: false, code: 'PROBE_HTTP_' + status };

  var size = null;
  var cr = h['content-range'] && h['content-range'].match(/\/(\d+)\s*$/);
  if (cr) size = Number(cr[1]);
  else if (h['content-length'] && status === 200) size = Number(h['content-length']);

  var ct = (h['content-type'] || '').toLowerCase();
  if (/text\/html/.test(ct)) return { ok: false, code: 'PROBE_HTML', message: 'Mirror returned an HTML page instead of a file.' };

  // Confirm it's a ZIP container (APK/XAPK are ZIPs): first bytes "PK"
  try {
    var bytes = resp.getContent();
    if (bytes.length >= 2 && !(bytes[0] === 0x50 && bytes[1] === 0x4B)) return { ok: false, code: 'PROBE_NOT_ZIP' };
  } catch (_) {}

  var fileName = null;
  var cd = h['content-disposition'];
  if (cd) {
    var fm = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    if (fm) { try { fileName = decodeURIComponent(fm[1]); } catch (_) { fileName = fm[1]; } }
  }
  if (!fileName) {
    var pm = url.match(/\/([^\/?#]+\.(?:apk|xapk))(?:[?#]|$)/i);
    if (pm) fileName = pm[1];
  }
  var version = null;
  if (fileName) { var vm = fileName.match(/_v?([\d][\d.]*)/); if (vm) version = vm[1]; }

  return { ok: true, sizeBytes: size, contentType: ct, fileName: fileName ? sanitizeFileName_(fileName) : null, version: version };
}

function lowerHeaders_(resp) {
  var out = {}, hs = resp.getAllHeaders();
  for (var k in hs) out[k.toLowerCase()] = Array.isArray(hs[k]) ? hs[k][0] : hs[k];
  return out;
}
function hostOf_(url) { var m = String(url).match(/^https?:\/\/([^\/]+)/i); return m ? m[1] : url; }
function looksLikeZip_(bytes) { return bytes[0] === 0x50 && bytes[1] === 0x4B; }

// ============================================================================
// RATE LIMITING
// ============================================================================
function enforceRateLimit_() {
  var who = '';
  try { who = Session.getActiveUser().getEmail() || ''; } catch (_) {}
  var key = 'rl:' + (who || 'anon:' + Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(Session.getTemporaryActiveUserKey() || 'x'))));
  var cache = CacheService.getScriptCache();
  var n = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(n), CONFIG.RATE_LIMIT_WINDOW_SEC);
  if (n > CONFIG.RATE_LIMIT_MAX) {
    throw new ApkToolError(ERR.RATE_LIMITED, 'Too many requests — limit is ' + CONFIG.RATE_LIMIT_MAX + ' per ' + Math.round(CONFIG.RATE_LIMIT_WINDOW_SEC / 60) + ' minutes.', 'Please wait a bit before trying again.');
  }
}

// ============================================================================
// NOTIFICATIONS & LOGGING
// ============================================================================
function notifyTarget_() {
  if (CONFIG.NOTIFY_EMAIL) return CONFIG.NOTIFY_EMAIL;
  try { return Session.getEffectiveUser().getEmail(); } catch (_) { return ''; }
}

function notifyFailure_(pkg, app, err, attempts) {
  if (!CONFIG.NOTIFY_ON_FAILURE) return;
  var to = notifyTarget_();
  if (!to) return;
  var cache = CacheService.getScriptCache();
  var throttleKey = 'notify:' + (pkg || 'unknown');
  if (cache.get(throttleKey)) return;                     // already e-mailed recently
  try {
    var lines = [
      CONFIG.APP_NAME + ' — resolution FAILED',
      '',
      'Package : ' + (pkg || '(unparsed)'),
      'App     : ' + (app ? app.title + ' by ' + app.developer : '(unknown)'),
      'Code    : ' + (err.code || ERR.INTERNAL),
      'Message : ' + err.message,
      'When    : ' + new Date().toISOString(),
      'User    : ' + (safeUser_() || 'anonymous'),
      '',
      'Provider attempts:'
    ];
    (attempts || []).forEach(function (a) { lines.push('  - ' + a.provider + ': ' + (a.ok ? 'OK' : (a.code + ' — ' + (a.message || ''))) ); });
    if (err.stack) lines.push('', 'Stack:', String(err.stack).slice(0, 1500));
    MailApp.sendEmail({ to: to, subject: '[' + CONFIG.APP_NAME + '] FAILED: ' + (pkg || 'unknown package'), body: lines.join('\n') });
    cache.put(throttleKey, '1', CONFIG.NOTIFY_THROTTLE_SEC);
  } catch (e) {
    log_('WARN', 'notifyFailure_ could not send mail', { message: e.message });   // MailApp quota exhausted, etc.
  }
}

function notifySuccess_(pkg, app, download) {
  var to = notifyTarget_();
  if (!to) return;
  try {
    MailApp.sendEmail({
      to: to,
      subject: '[' + CONFIG.APP_NAME + '] Resolved: ' + app.title,
      body: [app.title + ' (' + pkg + ')', 'Provider: ' + download.provider, 'Size: ' + humanSize_(download.sizeBytes), 'Link: ' + download.url, 'User: ' + (safeUser_() || 'anonymous')].join('\n')
    });
  } catch (e) { log_('WARN', 'notifySuccess_ could not send mail', { message: e.message }); }
}

function log_(level, msg, data) {
  var line = '[' + level + '] ' + msg + (data ? ' ' + JSON.stringify(data) : '');
  if (level === 'ERROR') console.error(line); else if (level === 'WARN') console.warn(line); else console.log(line);
}

/** Append a row to the optional audit sheet. Never throws. */
function logSheet_(status, pkg, title, provider, code, detail) {
  if (!CONFIG.LOG_SHEET_ID) return;
  try {
    var ss = SpreadsheetApp.openById(CONFIG.LOG_SHEET_ID);
    var sh = ss.getSheetByName('log') || ss.insertSheet('log');
    if (sh.getLastRow() === 0) sh.appendRow(['timestamp', 'user', 'status', 'package', 'title', 'provider', 'error_code', 'detail']);
    sh.appendRow([new Date(), safeUser_(), status, pkg, title, provider, code, String(detail || '').slice(0, 2000)]);
  } catch (e) {
    log_('WARN', 'logSheet_ failed', { message: e.message });
  }
}

function safeUser_() { try { return Session.getActiveUser().getEmail(); } catch (_) { return ''; } }

// ============================================================================
// MISC UTILITIES
// ============================================================================
function humanSize_(bytes) {
  if (!bytes || isNaN(bytes)) return 'unknown size';
  var u = ['B', 'KB', 'MB', 'GB'], i = 0, n = Number(bytes);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
}
function sanitizeFileName_(name) {
  var s = String(name).replace(/[\\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150);
  if (!/\.(apk|xapk)$/i.test(s)) s += '.apk';
  return s || 'app.apk';
}
function safeBase_(title) { return String(title || 'app').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'app'; }
function decodeEntities_(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); });
}
function getOrCreateFolder_(name) {
  var it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

// ============================================================================
// DEV / SELF-TEST — run from the Apps Script editor
// ============================================================================
function selfTest() {
  var samples = [
    'https://play.google.com/store/apps/details?id=com.whatsapp&hl=en_IN',
    'market://details?id=org.telegram.messenger',
    'com.duolingo',
    'https://play.google.com/store/apps/details?id=com.brazino.mexico&hl=es&gl=MX',   // not in IN store
    'org.fdroid.fdroid',                         // open-source: exercises the F-Droid provider
    'https://apkpure.com/x/com.foo',            // should fail: NOT_PLAY_URL
    'https://play.google.com/store/apps/details?id=com.this.does.not.exist.zzz'
  ];
  samples.forEach(function (s) {
    var r = resolveApk(s);
    var geo = r.ok && r.app ? ' [Play region: ' + (r.app.region || 'none') + (r.app.unlisted ? ', UNLISTED' : '') + ']' : '';
    console.log(s + '  =>  ' + (r.ok ? ('OK via ' + r.download.provider + ' ' + r.download.sizeHuman + geo + ' ' + r.download.url) : (r.error.code + ': ' + r.error.message)));
  });
}

/** Logs the raw HTTP status each provider endpoint returns for a package — handy when a mirror starts failing. */
function diagnoseProviders(pkg) {
  pkg = pkg || 'com.brazino.mexico';
  var probes = [
    ['Play IN', 'https://play.google.com/store/apps/details?id=' + pkg + '&hl=en&gl=IN', {}],
    ['Play MX', 'https://play.google.com/store/apps/details?id=' + pkg + '&hl=es&gl=MX', {}],
    ['Aptoide', 'https://ws75.aptoide.com/api/7/listAppVersions?package_name=' + pkg + '&limit=3', {}],
    ['APKPure d.', 'https://d.apkpure.com/b/APK/' + pkg + '?version=latest', { followRedirects: false, headers: { 'Referer': 'https://apkpure.com/', 'User-Agent': CONFIG.DESKTOP_USER_AGENT } }],
    ['APKCombo', 'https://apkcombo.com/genericApp/' + pkg + '/download/apk', { headers: { 'Referer': 'https://apkcombo.com/', 'User-Agent': CONFIG.DESKTOP_USER_AGENT } }],
    ['F-Droid', 'https://f-droid.org/api/v1/packages/' + pkg, {}]
  ];
  probes.forEach(function (p) {
    try {
      var r = safeFetch_(p[1], p[2]);
      var h = lowerHeaders_(r);
      console.log(p[0] + ' -> HTTP ' + r.getResponseCode() + ' ' + (h['content-type'] || '') + (h.location ? ' location=' + h.location : '') + ' body[0..120]=' + r.getContentText().slice(0, 120).replace(/\s+/g, ' '));
    } catch (e) { console.log(p[0] + ' -> ' + (e.code || 'ERR') + ' ' + e.message); }
  });
}
