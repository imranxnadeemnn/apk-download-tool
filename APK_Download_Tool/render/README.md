# APK Download Tool (Node / Render.com)

Paste a Google Play Store URL → get the APK. Node 20+ / Express port of the Apps Script tool, built so the
server can (a) talk to mirrors that block Google's IP ranges and (b) **stream the APK to you** with no 50 MB limit.

```
GET /                          UI
GET /api/resolve?input=<url|market://|package>
GET /api/download?u=<mirror url>&name=<file>     streaming proxy (known mirror hosts only, ZIP-checked, size-capped)
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
   * **APKPure** — `d.apkpure.com/b/APK|XAPK/<pkg>?version=latest` → 302 to the CDN file. Latest Play build. Cloudflare-fronted.
   * **Aptoide** — public JSON API; newest build with `malware.rank == TRUSTED` (signature matches the Play developer key).
   * **F-Droid** — open-source apps.
   * **APKCombo** — page scrape + `/checkin` token.
4. **Probe** the file with a 4-byte `Range` GET: size, content-type, filename, and the `PK` ZIP magic — an HTML
   challenge page is never presented as an APK.
5. Result → direct mirror link **and** a `/api/download` proxy link (server streams it; hides mirror tokens/Referer).
   If every mirror fails, the error carries **browser-side fallback links** (APKPure/APKCombo/APKMirror/Uptodown/Play).

## Error & notification handling

* Every response is `{ ok:true, … }` or `{ ok:false, error:{ code, message, hint, details } }` with proper HTTP status
  (400 input · 402 paid · 404 not found/no mirror · 429 rate-limited · 502 upstream · 500 internal).
* Codes: `EMPTY_INPUT INVALID_URL NOT_PLAY_URL INVALID_PACKAGE APP_NOT_FOUND PAID_APP PLAY_UNREACHABLE
  PROVIDER_BLOCKED PROVIDER_MISS NO_PROVIDER RATE_LIMITED PROXY_ERROR INTERNAL_ERROR`.
* Per-IP rate limit (`RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_SEC`), 15 s upstream timeouts, 90 s client timeout.
* Proxy: host allow-list, HTML/bot pages rejected, `MAX_PROXY_BYTES` cap, `Range` pass-through for resumable downloads.
* JSON-line logs to stdout (Render → Logs). Failure notifications (all mirrors failed / internal error), throttled per
  package, via **`NOTIFY_WEBHOOK_URL`** (Slack/Teams incoming webhook) and/or **SMTP** (`SMTP_URL`, `NOTIFY_EMAIL_TO`,
  optional `NOTIFY_EMAIL_FROM`; `npm i nodemailer`). User typos never trigger a notification.
* UI: client pre-validation, progress stepper, toasts, error panel with code+hint, geo banner, fallback links,
  shareable `/?url=…` deep links that auto-run.

## Deploy on Render

1. Push this folder to a Git repo (GitHub/GitLab/Bitbucket).
2. Render dashboard → **New → Blueprint** (uses `render.yaml`), or **New → Web Service** with
   Runtime *Node*, Build `npm install --omit=dev`, Start `npm start`, Health check `/healthz`.
3. Optional env vars: `NOTIFY_WEBHOOK_URL`, `SMTP_URL` + `NOTIFY_EMAIL_TO`, `DIAG_TOKEN`, `PROVIDER_ORDER`, `PLAY_DEFAULT_REGION`.
4. Open `https://<service>.onrender.com/api/diagnose?pkg=com.brazino.mexico&token=<DIAG_TOKEN>` to see which mirrors
   serve Render's IPs — then order `PROVIDER_ORDER` accordingly.

Free tier note: the instance sleeps after 15 min idle; the first request then takes ~30 s (the UI says so).

## Local

```
npm install
npm test          # offline unit tests (fetch mocked)
PORT=3000 npm start
```
