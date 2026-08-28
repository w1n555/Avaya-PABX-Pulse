# Post-optimization (source cleanup)

This note is for **maintainers**. Operators should use the root `README.md` (features, install, use).

Pulse grew by many small live changes on IIS (`C:\inetpub\wwwroot\CM`). After each feature landed, leftovers stayed: extra copies, old ports, empty UI helpers, test buttons. This document records a **cleanup pass** so the next person does not have to rediscover it.

**Status (2026-08-27)**

| Item | What | Status |
|------|------|--------|
| **1** | Disk junk (old DLL backups, publish tmp, disabled starters) | **Done** |
| **2** | Duplicate `web/` copy of the live UI | **Not done** — plan only |
| **3** | One OSSI bridge: port **18776** + folder **`data_live`** | **Done** |
| **4** | Dead / leftover JavaScript (empty painters, Flash test, double Login bind) | **Not done** — plan only |

Git: `c2438f8` (items 1 + 3 + operator README). Live session was **not** recycled for that commit.

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

**Item 2** is almost all of the “thousands of lines”: deleting `web/` removes **~9.3k UI lines** (about **33–37% of git-tracked app text**). It does **not** shrink the running dashboard — IIS already loads the root files.

**Item 4** is small: on the order of **100–250 lines** in the live UI (~**2–3%** of live JS/HTML). Same leftovers exist again under `web/` until item 2 is done.

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

## Item 2 — delete duplicate `web/` (plan only, do not do yet)

### Why

Git tracks a second full UI under `web/`. Hashes matched the root files. The browser loads **root** `index.html` (`<script src="app.js?v=…">`), not `web/app.js`. Every UI change had to be copied twice or the copies drifted.

### Need to do (when approved)

1. **Confirm nothing live reads `web/`.** IIS `web.config` + nested `/CM` use the site root. `install.ps1` does not copy `web/`.
2. **Retire or patch `scripts/one-click-deploy.ps1`.** It still does `Copy-Item web\* → site root` and **throws if `web` is missing**. That script is already documented as deprecated (`ONE-CLICK-DEPLOY.txt` → use `install.ps1`). Either delete it or point it at the root files.
3. **Delete `web/`** from git (UI js/html/css, duplicate `logo.png` / `favicon.png`, duplicate `vendor/leaflet`, `web/README.md`, `web/map/sites.json`).
4. **Do not** move the live UI *into* `web/` and leave the root empty — IIS would 404.

Keep **root** as the only source of truth (matches how the site already runs).

### Risk

- Someone still running `one-click-deploy.ps1` without the patch.
- Confusion with the old GitHub snapshot under `C:\Users\…\source\Avaya-PABX-Network-Monitoring-for-NOC` (already marked `MOVED.txt`).

### Test after (when we do it)

- Open `/CM/` — same tabs, same CSS cache token.
- Ctrl+F5; Login still works (module `app.js` from root).
- Map tiles still from `map/tiles/` (not under `web/`).
- `git grep web/` in `scripts/` and `src/` is only `web.config`.

**Estimated git deletion:** ~9.3k lines of UI + leaflet/README. **Live behaviour:** unchanged if step 1–2 are right.

---

## Item 4 — leftover JavaScript (plan only, do not do yet)

Do this **after** item 2 (or do live files only, then delete `web/` so you do not edit twice).

### 4a — safe no-ops (recommended first)

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

### 4c — Login bound twice (bug leftover)

`index.html` inline script binds `#btn-connect` → `__cmConnect`. `app.js` `init()` also `addEventListener("click", connect)`. One click can run **connect() twice**.

Keep **one** bind: either the inline delayed bind (module not ready yet) **or** `app.js` only, with the inline script only waiting for `__cmConnect` if you keep it. Do not keep both listeners.

### 4d — copy-paste helpers (optional, later)

`apiUrl*` / `fetchJson*` / `escapeHtml` are duplicated in `app.js`, `cdr-ui.js`, `alarm-ui.js`, `gateway-ui.js`, `extension-ui.js`, `map-ui.js`. A shared `api.js` would shrink a few hundred lines but is a **refactor**, not a delete. Separate PR from 4a–4c.

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

## Suggested order (when you say go)

1. Item **2** (`web/` + `one-click-deploy.ps1`), then item **4a** on the **single** remaining UI tree.  
2. Item **4c** (double Login) in the same UI pass if you want.  
3. Item **4b** only after you confirm the Flash test buttons can go.  
4. Leave **4d** and magic-TG cleanup for a later refactor.

After each step: the test list above, then push. Do not run `install.ps1` unless you intend to drop the OSSI session.
