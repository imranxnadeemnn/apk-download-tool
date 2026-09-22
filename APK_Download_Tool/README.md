# APK Download Tool (Google Apps Script Web App)

Paste a Google Play Store URL → get a direct APK download link from free public mirrors.
Runs entirely on Google Apps Script — no servers, no API keys, no cost.

## What's in this folder

| File | Purpose |
|---|---|
| `Code.gs` | Server: URL parsing, Play Store validation, provider chain, Drive fallback, notifications, logging |
| `Index.html` | Single-page UI (progress stepper, result card, toasts, error panel) |
| `appsscript.json` | Manifest: V8 runtime, OAuth scopes, web-app access level |

## How it works

```
Play URL ─► extractPackageName() ─► fetchPlayMetadata()  ─► provider chain ─► probe file ─► result
            (URL/market:/pkg)        (exists? free? title,   Aptoide ► APKPure    (size, type,
                                      developer, icon)       ► APKCombo           ZIP magic bytes)
```

**Why these providers** — there is no official free Google API for APK files (the Play Developer API only
serves *your own* apps). Of the free options:

* **Aptoide** (primary) – a real, documented, no-auth JSON API that works from Google's servers (verified live):
  `listAppVersions?package_name=<pkg>` lists every build across Aptoide stores → we keep only builds whose
  `malware.rank == "TRUSTED"` (signature matches the Play developer key), pick the highest `vercode`, then
  `app/getMeta?app_id=<id>` gives the direct `file.path` APK URL, size and MD5. Versions occasionally lag Play,
  and some apps exist only as variants (e.g. Telegram is only `org.telegram.messenger.web`).
* **APKPure** – `https://d.apkpure.com/b/APK/<pkg>?version=latest` redirects to the CDN file of the latest Play
  build (APK, then XAPK). Most current, but Cloudflare returns **403 to Apps Script's IP ranges** in testing, so
  it is a fallback only.
* **APKCombo** – HTML scrape + `/checkin` token. Served a bot challenge to Apps Script in testing; last resort.

* **F-Droid** – official JSON API for open-source apps (`api/v1/packages/<pkg>` → `repo/<pkg>_<vercode>.apk`).

Order is one line in `CONFIG.PROVIDER_ORDER`. Successful lookups are cached 30 min per package.

**Geo-restricted apps (not in the India store)** — Google Play is region-scoped, so an app published only in
Mexico returns 404 for `gl=IN`. The tool now checks several country stores in order: the `gl=` in the pasted link
first, then `CONFIG.PLAY_DEFAULT_REGION` (IN), then `CONFIG.PLAY_REGIONS` (US, GB, MX, BR, DE, FR, ES, IT, JP,
KR, ID, …; capped at `PLAY_MAX_REGION_LOOKUPS` = 12 fetches). The result card says which store listed the app
(e.g. *"Listed in the MX Play Store (not available in IN)"*). Mirrors themselves are region-independent.
If the app is on **no** Play region at all, `ALLOW_UNLISTED_APPS` (default true) still tries the mirrors and the
UI shows a "not on Google Play" warning; set it to false to reject such packages outright.

**Browser-side fallback** — when Play lists the app but every server-side mirror fails (typical for niche or
regional apps: Aptoide doesn't have them, APKPure/APKCombo block Google's IPs), the error panel shows
*"Try from your browser"* links: APKPure direct APK / XAPK download, APKCombo downloader, APKMirror and Uptodown
search, and the Play page in the region where it was found. These open in the user's own browser, which those
mirrors do serve. Verified for `com.brazino.mexico` (Brazino777 Casino, MX-only): found in the MX Play store,
absent from Aptoide/F-Droid/APKCombo, present on APKPure (v2.0) when opened from a normal browser.

**Delivery** — the browser downloads directly from the mirror (no size limit). For files ≤ 45 MB a
*Save to Google Drive* button fetches the file server-side into a `APK Download Tool` Drive folder and
returns a share link — useful when the mirror blocks your network or you want a persistent copy.
(Apps Script's `UrlFetchApp` hard-limits responses to 50 MB, which is why larger files are link-only.)

## Error & notification handling

| Layer | Behaviour |
|---|---|
| Input | Client pre-validates (non-Play host, missing `id=`, bad package) before any server call; server re-validates and returns stable codes: `EMPTY_INPUT`, `INVALID_URL`, `NOT_PLAY_URL`, `INVALID_PACKAGE` |
| Play Store | Multi-region lookup; `APP_NOT_FOUND` only after every region **and** every mirror misses, `PAID_APP` (price > 0 parsed from JSON-LD / itemprop), `PLAY_UNREACHABLE` |
| Providers | Each provider throws `PROVIDER_BLOCKED` (403/429/503/bot challenge/network) or `PROVIDER_MISS` (no file) and the chain moves on. Every attempt is returned to the UI under *Diagnostics*. All failing → `NO_PROVIDER` **with browser-side fallback links** (APKPure/APKCombo/APKMirror/Uptodown/Play) |
| File probe | `Range: bytes=0-3` request checks size, content-type, and `PK` ZIP magic — HTML challenge pages are never presented as APKs |
| Drive | `TOO_LARGE_FOR_DRIVE`, `DRIVE_ERROR` (quota/sharing policy), non-ZIP payloads rejected |
| Abuse | Per-user rate limit (30 req / 10 min, `RATE_LIMITED`) via `CacheService` |
| Bridge | `withFailureHandler` catches auth-expiry / execution-timeout errors thrown across `google.script.run` |
| UI | Toasts for every outcome, red error panel with code + message + actionable hint, stepper marks the failed stage, global `error`/`unhandledrejection` hooks |
| E-mail | `MailApp` notifies the owner (or `CONFIG.NOTIFY_EMAIL`) when **all** providers fail or on internal errors — throttled to one mail per package per 5 min. User typos never trigger mail. Optional success mails |
| Audit log | Set `CONFIG.LOG_SHEET_ID` to append every request (timestamp, user, status, package, provider, error code) to a Sheet; otherwise Stackdriver/`console` logging only |

Nothing throws across the client boundary — every server function returns `{ ok: true, … }` or
`{ ok: false, error: { code, message, hint } }`.

## Deploy (≈5 minutes)

1. Go to <https://script.google.com> → **New project**. Name it *APK Download Tool*.
2. **Project Settings (⚙) → tick "Show `appsscript.json` manifest file in editor".**
3. Replace the contents of `Code.gs`, create **File → HTML → `Index`** and paste `Index.html`,
   and replace `appsscript.json` with the one here.
4. (Optional) edit `CONFIG` at the top of `Code.gs`:
   * `NOTIFY_EMAIL` – who gets failure e-mails (blank = you)
   * `LOG_SHEET_ID` – a Google Sheet id for an audit log
   * `PROVIDER_ORDER` – reorder / remove mirrors
   * `webapp.access` in the manifest – `DOMAIN` (anyone at aarki.com), `ANYONE`, or `MYSELF`
5. In the editor run `selfTest` once → accept the OAuth prompt (UrlFetch, Drive, Mail, Sheets).
   Check **Executions** for the log: you should see `OK via Aptoide …` / `OK via F-Droid …` lines and
   the expected `NOT_PLAY_URL` / `APP_NOT_FOUND` rejections. `diagnoseProviders('<pkg>')` prints the raw
   HTTP status of every mirror endpoint for one package when something starts failing.
6. **Deploy → New deployment → Web app**
   * Execute as: **Me** (so Drive saves & e-mails come from the owner and users don't need Drive scopes)
   * Who has access: **Anyone within RZR/Aarki** (or *Anyone*)
7. Open the Web app URL. Deep links work too: `…/exec?url=<encoded Play URL>` or `…/exec?id=com.whatsapp`
   (handled server-side in `doGet`, because the UI runs inside a sandboxed iframe that cannot read the outer URL).

**Current deployment (Sep 22 2026, v3, access: anyone within the RZR/Skillz Google Workspace, executes as inadeem@aarki.com):**
<https://script.google.com/a/macros/aarki.com/s/AKfycbzSUVVBe1AXYv-7cr4zBVma8xOsXLURnZvVUHXcyFgE7BES2OgkEaBV0nwzNISQa6T_Ag/exec>
Editor: <https://script.google.com/home/projects/19i7OwmWVofr_p22zJmG8I6FrqsykwdH1ZmuT9vfMiUcZoK1eq31cVE68/edit>

To update later: edit → **Deploy → Manage deployments → ✎ → Version: New** (the URL stays the same).

## Limits & caveats

* **Free apps only.** Paid apps are detected and rejected with the price.
* **Mirror availability is outside your control.** APKPure/APKCombo can rate-limit Google IPs; that's why
  Aptoide (JSON API) is in the chain and why every attempt is reported.
* **Quotas (consumer / Workspace):** 20 000 UrlFetch calls/day, 100–1 500 e-mails/day, 6-minute execution
  cap per request. A resolution uses 2–5 fetches.
* **Split APKs:** some apps ship as bundles → you'll get an **XAPK** (zip with base + split APKs/OBB).
  Install with the APKPure app / SAI, or unzip and `adb install-multiple`.
* **Security:** files come from third parties. Aptoide results are TRUSTED-signature-checked; for APKPure /
  APKCombo verify with `apksigner verify --print-certs` before sideloading anything sensitive.
* `Range` probing needs the CDN to honour partial requests; if it doesn't, size shows as *unknown* and the
  Drive button is disabled (direct download still works).

## Quick test URLs

```
https://play.google.com/store/apps/details?id=com.whatsapp
https://play.google.com/store/apps/details?id=org.telegram.messenger&hl=en_IN
market://details?id=com.duolingo
com.spotify.music
https://play.google.com/store/apps/details?id=com.brazino.mexico&hl=es&gl=MX   → found in MX store; browser fallback links
org.fdroid.fdroid                                                        → not on Play; served from F-Droid
https://play.google.com/store/apps/details?id=com.does.not.exist.zz      → APP_NOT_FOUND (12 regions + mirrors checked)
https://apkpure.com/x/com.whatsapp                                       → NOT_PLAY_URL
```
