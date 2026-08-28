# Post-optimization (source cleanup)

This note is for **maintainers**. Operators should use the root `README.md` (features, install, use).

Pulse grew by many small live changes on IIS (`C:\inetpub\wwwroot\CM`). After each feature landed, leftovers stayed: extra copies, old ports, empty UI helpers, test buttons. This document records a **cleanup pass** so the next person does not have to rediscover it.

**Status (2026-08-27)**

| Item | What | Status |
|------|------|--------|
| **1** | Disk junk (old DLL backups, publish tmp, disabled starters) | **Done** |
| **2** | Duplicate `web/` copy of the live UI | **Done** |
| **3** | One OSSI bridge: port **18776** + folder **`data_live`** | **Done** |
| **4** | Dead / leftover JavaScript | **4a + 4c + 4d done.** Flash Yellow/Red (4b) kept for demo. |

Git: `c2438f8` (items 1 + 3 + operator README). Item 2 is the `web/` removal in a later commit. Live session was **not** recycled for these cleanups.

---

## Why cleanup exists (and why it waited)

This is normal after a fast feature run, not a sign that “nobody reviews.”

Typical loop here was: **change live → user checks the screen → next request**. That is the right loop for a NOC tool sitting on a real CM. What it does **not** do is harvest leftovers after every slice.

How junk appeared:

- **Two UI trees.** Old `one-click-deploy.ps1` copied `web\*` onto the IIS site root. Later, `install.ps1` and day-to-day edits used the **root** files (`index.html`, `app.js`, …). Both trees were kept in git and stayed byte-identical.
- **Compatibility shims.** Magic trunk-group numbers (9994 / 9995 / 9996 / 990000 / 8000000) and empty “countdown” functions were left so an older `CmApi.dll` still worked. The current `Program.cs` already has `/alarms`, `/gateways`, `/extensions`.
- **Port wander.** Bridge listened on 18765, then 18766, then **18776**. Scripts and Python defaults did not all move together.
- **Test UI that never left.** Alarm **Flash Yellow / Flash Red** were for checking webpage flash. They are still on the Alarm tab.

**Practice going forward:** ship the feature, then a short leftover pass **on that slice** (delete the old path if the new one works). A full-repo dead-code review belongs at a milestone — like this one — not after every field change.

Do **not** mix leftover deletion with OSSI protocol / 90s pack / queue changes. Those are live paths.

---

## How big is “thousands of lines”?

Counts are **source text** (git), 2026-08-27. Map tiles (`map/tiles/`, ~965 JPEG) and `python/runtime/` are excluded.

| Bucket | Approx. lines | Notes |
|--------|---------------|--------|
| Live UI (what the browser loads) | **9 348** | `app.js` + `*-ui.js` + `index.html` + `style.css` |
| `web/` copy of the same UI | **9 348** | Identical hashes at review time |
| `web/` git text (UI + README + leaflet CSS) | **~10 300** | Unused by IIS |
| Python bridge + parsers + small tests | **~4 600** | `ossi_service.py` ~2 575 |
| C# `src/CmApi` | **~1 800** | |
| Live app source (UI + Python + C# + scripts, **no** `web/`, no vendor) | **~17 800** | Running system |
| Git app source **including** `web/` | **~28 100** | Two UI trees |

**Item 2** (done) removed that extra **~9.3k UI lines** from git (about **33–37% of previously tracked app text**). It does **not** shrink the running dashboard — IIS already loaded the root files.

**Item 4** is small: on the order of **100–250 lines** in the live UI (~**2–3%** of live JS/HTML).

**Items 1 + 3** (already shipped) were not a line-count win. Git net on 1+3 was about **54 insertions / 42 deletions** of source, plus **~3.4 MB** of untracked `api/*.old_*` binaries.

So: **git looks a third lighter after item 2; the live product barely changes until item 4.** That is still worth doing — two copies are how edits get lost.

---

## Item 1 — disk junk (done)

### Why

Publish and debug left files IIS never serves: `api/CmApi.dll.old_*`, `api_publish_tmp/`, `__pycache__/`, `scripts/start-bridge-18766*.disabled`, a one-shot `kill-and-start-bridge.ps1` aimed at **18765**.

### What we did

- Deleted **46** `api/*.old_*` (~3.4 MB). Live `api/CmApi.dll` stayed.
- Deleted `api_publish_tmp/`, Python `__pycache__`, `.disabled` starters.
- Deleted `scripts/kill-and-start-bridge.ps1` (hard-coded PID + wrong port).

### Test (done)

- `api/CmApi.dll` still present.
- Bridge `http://127.0.0.1:18776/health` → `service=ossi-bridge`, `connected=true`.
- Only **18776** listening (no 18765).

No IIS recycle. Login session kept.

---

## Item 3 — one bridge: 18776 + `data_live` (done)

### Why

Production was already **18776** + `data_live` (`api/appsettings.json`). `install.ps1` and some starters still wrote **18765** and `data\`. Re-running install would have started a **second** bridge on the wrong port and the wrong folder.

### What we did

Single constants at the top of `scripts/install.ps1`:

```powershell
$script:OssiBridgePort = 18776
$script:OssiBridgeLegacyPort = 18765  # kill leftover only; never start
$script:OssiDataLeaf = "data_live"
```

Also aligned:

- `scripts/start-ossi-bridge.ps1` → `data_live`
- `python/ossi_service.py` defaults → port 18776, dir `data_live`
- C# fallbacks (`OssiBridgeClient`, `Program.cs`) → `data_live` when config is empty
- `INSTALL.txt` wording

**Fix found in review:** `Stop-BridgeOnPort` assigned `$pid`. In PowerShell `$PID` is read-only (the installer process). Stop either did nothing or could target the installer itself. Now uses `$procId`.

**18765 remains only as a kill target** in install / `restart-bridge-now.ps1` so leftover processes die. Nothing **starts** 18765.

### Test (done)

- `install.ps1` parses (PowerShell AST).
- Sample JSON from `Set-JsonAppSettings`: `BaseUrl=http://127.0.0.1:18776`, `DataDir=...\data_live`.
- Live health still 18776 / connected after the file edits.

**Not run:** `install.ps1` itself (it ForceRestarts the bridge and would drop the CM login). **Not republished:** `api/CmApi.dll` (live appsettings already points at 18776 + `data_live`).

**How to test later (when a session drop is OK):**

1. Logout (or accept a disconnect).
2. Admin: `.\scripts\install.ps1` (or `restart-bridge-now.ps1` if you only want the bridge).
3. Confirm **only** 18776 listens; `appsettings.json` still 18776 + `data_live`.
4. Login; Trunk / Alarm / Gateway / Extension still fill.

---

## Item 2 — delete duplicate `web/` (done)

### Why

Git tracked a second full UI under `web/`. Hashes matched the root files. The browser loads **root** `index.html` (`<script src="app.js?v=…">`), not `web/app.js`. Every UI change had to be copied twice or the copies drifted.

### What we did

1. Confirmed live does not read `web/`: IIS `web.config` default document is root `index.html`; `install.ps1` never copies `web/`.
2. Retired `scripts/one-click-deploy.ps1` to a stub that tells you to run `install.ps1` (exit 1). The old script copied `web\*` onto the site root and **threw if `web` was missing**.
3. `git rm -r web/` — UI js/html/css, duplicate `logo.png` / `favicon.png`, duplicate `vendor/leaflet`, `web/README.md`, `web/map/sites.json`.
4. Left the **root** UI in place (moving it into `web/` would 404 IIS).

Root is the only source of truth.

### Test (done)

- Root still has `index.html`, `app.js`, `*-ui.js`, `style.css`, `logo.png`, `favicon.png`, `vendor/leaflet`, `map/sites.json`.
- `web/` folder gone.
- Bridge `http://127.0.0.1:18776/health` still `ossi-bridge` / connected (no recycle).
- HTTP GET site `/CM/` and `/CM/app.js` / `/CM/style.css` still 200 from the root files.
- `scripts/one-click-deploy.ps1` no longer references a `web` folder.

**Git:** ~9.3k UI lines + leaflet/README removed from the repo. **Live dashboard:** same files as before.

---

## Item 4 — leftover JavaScript

### 4a — safe no-ops (done)

Removed empty / dead helpers and every call site:

- `setExtStatus`, `paintExtCountdown`, `paintExtUpdated`, `startExtCountdownPaint`
- `setAlarmStatus`, `paintAlarmCountdown`, `paintAlarmUpdated`, `startCountdownPaint`
- `setGwStatus`, `paintGwCountdown`, `startGwCountdownPaint`
- unused `sleep()` and deprecated `paintCmTime()` in `app.js` (logout now calls `clearCmTimeAnchor()`)

**Kept** `paintGwUpdated()` — it still writes the live KPI `gw-stat-updated`.

Cache token bumped to `?v=20260827a` so browsers pick up the modules.

### 4a leftovers (original plan)

Empty or dead because the Auto chip moved to `app.js`:

| Function | File | Why dead |
|----------|------|----------|
| `setExtStatus` / `paintExtCountdown` | `extension-ui.js` | Comment: chip owned by `app.js` |
| `paintGwCountdown` | `gateway-ui.js` | Same |
| `setAlarmStatus` / `paintAlarmCountdown` | `alarm-ui.js` | Same |
| `paintExtUpdated` / `paintAlarmUpdated` / `paintGwUpdated` | those files | HTML has no `ext-meta-updated` / `alarm-meta-updated` / `gw-meta-updated` (Last Update is a KPI) |
| `sleep()` | `app.js` | Unused; `sleepMs()` is used |
| `paintCmTime()` | `app.js` | `@deprecated` wrapper around `setCmTimeAnchor` / `clearCmTimeAnchor` |

Remove the functions **and** their call sites. Do not leave `foo();` calling nothing.

### 4b — Alarm Flash Yellow / Flash Red (ask before delete)

`index.html` buttons `btn-flash-yellow` / `btn-flash-red` plus `ALARM.manualYellow` / `manualRed` in `alarm-ui.js`. Production test only. **Ack** stays.

### 4c — Login bound twice (done)

Removed the extra `app.js` `init()` listener on `#btn-connect`. Login is bound **once** in `index.html` (waits for `window.__cmConnect` after the module loads). Logout stays on `app.js`.

### 4d — shared `http.js` (done)

One module: `apiUrl`, `siteUrl`, `fetchJson`, `escapeHtml`, `fmtUpdated`. Tabs import `./http.js?v=20260827b`. `http.js` imports nothing (no cycles).

`app.js` still has `api(path)` for Login / 90s pack / heartbeat — it calls `fetchJson(apiUrl(path))` and keeps the `"Network error"` wrap. CDR `apiGet` / `apiPost` call the same helpers.

Backup tag before this change: **`pre-4d`**. Cache token **`20260827b`**. Flash buttons and magic TGs unchanged.

### Out of scope for item 4

- Magic TGs and dual `/alarms/refresh` vs `refresh/one` — still live.
- `more_idle` 3s, 90s pack, queue.
- Merging Python route aliases.

### Test after 4a–4c

1. Ctrl+F5. Login **once** (watch network: one `session/connect`, not two).
2. Every tab: Map, Trunk, Gateway, Extension, CDR, Alarm — cache + Auto chip.
3. Alarm: real MAJOR/MINOR flash; Ack stops it; **WARNING does not flash**. If 4b kept, Flash Yellow/Red still toggles; if removed, only real alarms flash.
4. Extension Details + digital keys 1–24; analog has no keys; `udp-ext` not clickable.
5. Gateway Details; Remove TG queued (no raw “sending the request” error).
6. F5 keeps the session.

---

## Suggested order (remaining)

1. Item **4b** stays — Flash Yellow / Flash Red are for demo.  
2. Magic-TG cleanup later (do not mix with UI helper refactors).

Do not run `install.ps1` unless you intend to drop the OSSI session.
