# APK Download Tool (Node / Render.com)

Paste a Google Play Store URL → get the APK. Node 20+ / Express port of the Apps Script tool, built so the
server can (a) talk to mirrors that block Google's IP ranges and (b) **stream the APK to you** with no 50 MB limit.

```
GET /                          UI
GET /api/resolve?input=<url|market://|package>
GET /api/download?u=<mirror url>&name=<file>     streaming proxy (known mirror hosts only, ZIP-checked, size-capped)
GET /api/convert?u=<xapk url>&name=&pkg=          start / reuse an XAPK -> single-APK job; /api/convert/:id status; /:id/file result
GET /api/diagnose?pkg=<package>[&token=…]        raw HTTP status of each mirror from THIS server's IP
GET /healthz
```

## How it resolves

1. **Parse** the input (Play URL incl. `/details/<slug>?id=`, `market://`, or bare package). `gl=`/`hl=` are kept as hints.
2. **Google Play, multi-region.** Play is country-scoped, so the package is looked up in the `gl` from the link, then
   `PLAY_DEFAULT_REGION` (IN), then `PLAY_REGIONS` (US, GB, MX, BR, DE, …) — 4 regions in parallel, max 12.
   Title / developer / icon / price come from the page's JSON-LD; paid apps are rejected.
   Not on Play anywhere → still tries mirrors (`ALLOW_UNLISTED_APPS=true`) but the UI shows a warning.
3. **Provider chain** (`PROVIDER_ORDER`, default `apkpure,aptoide,fdroid,apkcombo`):
   * **APKPure** — two routes. (a) The APKPure *Android app's* API (`api.pureapk.com/m/v3/cms/app_version`,
     then `app/detail`) with the app's `x-cv/x-sv/x-abis/x-gp` headers — the same trick EFF's `apkeep` uses. It is
     **not** behind the Cloudflare JS challenge (a native app can't solve one), so it works from Render's IPs and
     returns the current Play build (verified live: WhatsApp 2.26.36.74, Duolingo 177 MB XAPK). The protobuf reply
     is scanned for `APKJ`/`XAPKJ` CDN links; each link's base64 path is decoded and matched to the package so a
     "related app" is never returned by mistake. (b) The web redirect `d.apkpure.com/b/APK/<pkg>?version=latest`
     — Cloudflare 403s datacenter IPs (Render and Google alike); kept as a fallback and as a browser-side link.
   * **Aptoide** — public JSON API; newest build with `malware.rank == TRUSTED` (signature matches the Play developer key).
   * **F-Droid** — open-source apps.
   * **APKCombo** — page scrape + `/checkin` token.
4. **Probe** the file with a 4-byte `Range` GET: size, content-type, filename, and the `PK` ZIP magic — an HTML
   challenge page is never presented as an APK.
5. Result → direct mirror link **and** a `/api/download` proxy link (server streams it; hides mirror tokens/Referer).
   If every mirror fails, the error carries **browser-side fallback links** (APKPure/APKCombo/APKMirror/Uptodown/Play).

## APK, not XAPK — installable directly on a device

Modern apps are published as app bundles, so mirrors usually hold an **XAPK** (base.apk + `config.*.apk` splits
+ optional OBB) which Android cannot install by tapping it. The tool does three things about that:

1. **Prefers a plain APK.** Within APKPure, an APK candidate beats an XAPK of the same build. Across mirrors, an
   XAPK is remembered and the chain keeps going; another mirror's APK wins only if its `versionCode` is at least
   as new (Aptoide's Duolingo, for example, is a 2020 build — the bundle wins there).
2. **Converts the bundle on the server** — *Get installable APK* in the UI → `GET /api/convert?u=…` starts a job,
   the UI polls `/api/convert/:id` (download → merge → sign progress) and then offers `/api/convert/:id/file`,
   served as `application/vnd.android.package-archive` so an Android browser installs it on tap.
   * Bundle with **one** apk inside → `base.apk` is extracted **unchanged** (developer signature intact).
   * Bundle with **splits** → [APKEditor](https://github.com/REAndroid/APKEditor) merges them into a universal
     APK (`isSplitRequired` removed), then [uber-apk-signer](https://github.com/patrickfav/uber-apk-signer) signs
     it v1+v2+v3 and zipaligns. **This re-signs the app with the tool's key**: it installs as a fresh app, will not
     update a Play-installed copy, and apps that verify their own signature may refuse to run. The UI says so.
   * OBB expansion files are not merged (the APK is still installable; the app fetches its data on first run).
3. **Still offers the XAPK** as a secondary link for people who use the APKPure app / SAI.

Jobs run one at a time (`CONVERT_JAVA_XMX`, default 320m, fits the 512 MB free instance), files live in the OS
temp dir and expire after `CONVERT_TTL_SEC` (1800). Bundles above `CONVERT_MAX_BYTES` (700 MB) are refused.
`tools/setup-java.js` (npm `postinstall`) downloads the two jars and, when the image has no `java`, a Temurin 17
JRE into `.jre/`. Without them the tool still works — only the convert button reports unavailable.

## Error & notification handling

* Every response is `{ ok:true, … }` or `{ ok:false, error:{ code, message, hint, details } }` with proper HTTP status
  (400 input · 402 paid · 404 not found/no mirror · 429 rate-limited · 502 upstream · 500 internal).
* Codes: `EMPTY_INPUT INVALID_URL NOT_PLAY_URL INVALID_PACKAGE APP_NOT_FOUND PAID_APP PLAY_UNREACHABLE
  PROVIDER_BLOCKED PROVIDER_MISS NO_PROVIDER RATE_LIMITED PROXY_ERROR INTERNAL_ERROR`.
* Per-IP rate limit (`RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_SEC`), 15 s upstream timeouts, 90 s client timeout.
* Proxy: host allow-list, HTML/bot pages rejected, `MAX_PROXY_BYTES` cap, `Range` pass-through for resumable downloads.
* JSON-line logs to stdout (Render → Logs).
* **In-app notifications — no Slack / Teams / e-mail.** The server keeps an in-memory event feed
  (`NOTIFY_MAX_EVENTS`, default 200) of every resolve: `success` (app → mirror, version, size), `failure`
  (all mirrors missed / blocked, with the per-provider attempt list), `error` (upstream or internal) and `alert`.
  Alerts are raised once per key per window (`NOTIFY_ALERT_WINDOW_SEC`, default 600 s) when a provider is blocked
  `NOTIFY_ALERT_THRESHOLD` (default 3) times, or when a Play-listed app has **no** mirror at all. User typos
  (`INVALID_URL`, `NOT_PLAY_URL`, …) never create events.
  `GET /api/notifications?since=<id>&limit=<n>` returns `{ latestId, summary:{success,failure,error,alerts,
  blockedProviders}, events[] }` (newest first). The UI polls it every 15 s and shows a **bell with an unread badge**;
  clicking it opens the *Activity & alerts* panel (filter to alerts, mark read, one-click "Look up" rerun).
  The feed is per-instance and resets on redeploy / sleep by design.
* UI: client pre-validation, progress stepper, toasts, error panel with code+hint, geo banner, fallback links,
  shareable `/?url=…` deep links that auto-run.

## Deploy on Render

1. Push this folder to a Git repo (GitHub/GitLab/Bitbucket).
2. Render dashboard → **New → Blueprint** (uses `render.yaml`), or **New → Web Service** with
   Runtime *Node*, Build `npm install --omit=dev`, Start `npm start`, Health check `/healthz`.
3. Optional env vars: `DIAG_TOKEN`, `PROVIDER_ORDER`, `PLAY_DEFAULT_REGION`, `NOTIFY_ALERT_THRESHOLD`,
   `NOTIFY_ALERT_WINDOW_SEC`, `NOTIFY_MAX_EVENTS`, `CONVERT_JAVA_XMX`, `CONVERT_MAX_BYTES`, `CONVERT_TTL_SEC`, `JAVA_BIN`.
4. Open `https://<service>.onrender.com/api/diagnose?pkg=com.brazino.mexico&token=<DIAG_TOKEN>` to see which mirrors
   serve Render's IPs — then order `PROVIDER_ORDER` accordingly.

**Live:** <https://apk-download-tool.onrender.com> (repo `imranxnadeemnn/apk-download-tool`, root dir
`APK_Download_Tool/render`, Free plan, Singapore). Public-repo services do **not** auto-deploy: after a commit use
*Manual Deploy → Deploy latest commit* in the Render dashboard.

## What was learned about "blocked" mirrors (Sep 2026)

| Endpoint | From Google Apps Script | From Render (AWS Singapore) |
|---|---|---|
| Google Play pages (any `gl`) | OK | OK |
| Aptoide JSON API | OK | OK |
| F-Droid API | OK | OK |
| APKCombo (with `Referer`) | bot challenge → OK | OK (410 = app not carried) |
| APKPure web `d.apkpure.com` | 403 Cloudflare | 403 Cloudflare |
| **APKPure app API `api.pureapk.com`** | not tried (needs binary parsing) | **OK — current Play builds** |

So the block was never Apps-Script-specific: Cloudflare challenges *all* datacenter IPs on APKPure's web endpoints.
The app API sidesteps it, and Node can parse the protobuf blob and stream the 100 MB+ files that Apps Script's
50 MB `UrlFetchApp` cap could not.

**Region-limited apps such as `com.brazino.mexico` (Brazino777, MX-only)** are a different problem: no mirror
*hosts* the file at all — Aptoide/F-Droid/APKCombo don't have it, and APKPure's own site redirects to its "Online
APK Downloader for region-limited apps", which fetches from Google Play on demand with APKPure's device accounts.
The tool detects the app correctly (Play MX store, title, developer) and returns `NO_PROVIDER` with browser-side
links (APKPure's online downloader works from a normal browser). Serving these server-side requires talking to
Google Play's device API with an account/anonymous token (Aurora-style) — a possible next step, not a mirror fix.

Free tier note: the instance sleeps after 15 min idle; the first request then takes ~30 s (the UI says so).

## Local

```
npm install       # also fetches APKEditor / uber-apk-signer jars (SKIP_JAVA_SETUP=1 to skip)
npm test          # offline unit tests (fetch mocked)
PORT=3000 npm start
```
