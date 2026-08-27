# Avaya PABX Pulse

**Feel the pulse of PABX.** Read-only **Avaya Communication Manager (CM 10.x)** dashboard for the Network Operations Centre.

The UI runs in a browser (IIS). It talks to CM with **OSSI over SSH :5022** (not SAT scraping). Call records are collected separately on **TCP :9000**.

**Purpose:** one screen for trunks, media gateways, alarms, extensions, a Hong Kong site map, and CDR search — without write access to the PABX.

Live install: IIS nested `/CM` (often port 8888). Source: `https://github.com/w1n555/Avaya-PABX-Network-Monitoring-for-NOC`

---

## What the NOC sees

| Tab | What it shows | How it is updated |
|-----|----------------|-------------------|
| **Map View** | Offline Hong Kong map. Site pin: **DOWN / Major = red**, **Minor = yellow**, otherwise **green**. KPI Major/Minor = **gateway boxes + CM-own** (e.g. one G450 + one CM T1 = 2). | Cache from Gateway + Alarm. Same 90s pack. |
| **Trunk** | Monitored trunk groups only. Util: green &lt;70% · yellow 70–90% · red &gt;90% or Idle=0. `0/0/0` this poll → **UPDATE FAILED**. | Backend Auto **90s** `status trunk N`. |
| **Gateway** | `list media-gateway`. **Reg=n** = DOWN. Missing this poll (incomplete SAT list) = **UPDATE FAILED** (sticky last hostname/IP). Click-in: `list configuration media-gateway`. | Same 90s pack. Open Details also refresh that MG. |
| **Extension** | Inventory: `list extension` + `list station` (port / name). | **Hourly**, queued so it never overlaps the 90s pack. |
| **CDR** | Search daily call files (cap **5000**, red if capped). Logger pill **UP/DOWN**. Default From/To = **today**. | TCP logger on **:9000**. Not OSSI. |
| **Alarm** | Active alarms only (`display alarms`). Date Alarmed newest first. Search + mtce type filters. | Same 90s pack. |

**Webpage flash (not CM):** Active **MAJOR** (CM or any G450 MJ) → red flash. Else **MINOR** → yellow. **WARNING does not flash**. **Ack** stops the webpage flash only — it does **not** clear alarms on CM.

**Before Login:** every tab is dimmed. Login / tab buttons stay usable. After Login, all tabs light up.

---

## Architecture

```text
Browser (HTML / CSS / JS)
    │  /CM/api/*
    ▼
CmApi (.NET, IIS)          thin proxy · can start the Python bridge
    │  http://127.0.0.1:18776
    ▼
python/ossi_service.py     one OssiSession, bind 0.0.0.0:18776
    │  SSH :5022  terminal ossit
    ▼
Avaya CM                   list / display / status only (read-only)

CDR TCP 0.0.0.0:9000  →  cdr-link/cdr/YYYYMMDD.TXT
```

**One OSSI connection.** Commands are serialised (`_ossi_lock`). Each major OSSI tab has its own parse module:

| Tab | Parse file | CM command |
|-----|------------|------------|
| Trunk | `python/trunk_parse.py` | `status trunk N`, `list trunk-group` |
| Alarm | `python/alarm_parse.py` | `display alarms` |
| Gateway | `python/gateway_parse.py` | `list media-gateway`, `list configuration media-gateway` |
| Extension | `python/extension_parse.py` | `list extension`, `list station` |
| Map | *(none)* | Uses Gateway + Alarm cache |
| CDR | `cdr-link/cdr_logger.py` | Not OSSI |

The SSH/OSSI wire (send `c` / `t`, answer SAT `more?[y]`) lives in bundled `vendor/avaya-ossi`.

---

## Auto refresh (90 seconds) — backend owned

The browser **does not** drive the 90s pack. Python does.

Every **90s** while a logged-in UI is present, the bridge runs **one pack**:

1. `status trunk N` for each **monitored** trunk group (writes cache after each TG)  
2. `display alarms`  
3. `list media-gateway`  
4. If Gateway Details is open: `list configuration media-gateway <mg>`

The UI only **displays** countdown + cache (`Next: Ns` / `Updating trunks…` / `Auto update complete — next in Ns`). Status chip is on the **far right** of every OSSI tab header.

**Login** still runs a live pack (progress bar). **F5** keeps the OSSI session and shows cache + server countdown — it does **not** fire an extra pack. **Manual Refresh** on Trunk was removed.

**Why backend pack:** browser HTTP sometimes missed one of the three OSSI calls (Alarm fail skipped Gateway). Python writes each cache independently, so a miss on one command does not drop the others.

`list media-gateway` waits up to **3 seconds of silence after `more?[y]` pages** so SAT lists of ~58 GWs are not cut short. This idle is **not** a 3-second timeout on all OSSI commands (`status trunk` is unchanged; overall command cap remains 600s).

---

## Login and session

- Login is **manual** (CM host, RO user e.g. `monitor`, password).  
- Password is held in **bridge memory only** — **never written under wwwroot**.  
- **F5 / Ctrl+F5** keeps the OSSI session (no disconnect on refresh).  
- **Close the browser tab:** heartbeat stops → OSSI logoff after about **5 minutes** (frees the CM login slot).  
- CM SSH idle logoff: **30 minutes** with no command (heartbeat + 90s pack keep the session alive while the UI is open).  
- Heartbeat every **15s** from the browser (keepalive only — does not run `display time` on that path).

---

## Safety (for management)

- OSSI commands are **list / display / status** only. Use a **read-only** CM login.  
- Do **not** put the CM password in files under the web root.  
- Only **CDR** is logged to disk (`cdr-link/cdr/`). Do not log OSSI sessions.  
- Default pack is **90s** and **monitored TGs only** — not every trunk every second.  
- `list uniform-dialplan` was timed at ~**28s / ~3100 records** on this CM; it is **not** in the 90s pack (would steal the single OSSI slot).

---

## File structure

```text
<install folder>/
  index.html  style.css  app.js  *-ui.js  web.config
  map/                  # sites.json + offline tiles
  python/ossi_service.py
  python/*_parse.py
  vendor/avaya-ossi/    # bundled OSSI SSH client
  cdr-link/             # CDR logger
  api/                  # published CmApi
  src/CmApi/            # C# source
  data_live/            # runtime JSON (not in git)
  scripts/install.ps1
  README.md
```

---

## Deploy

**Goal:** extract → `install.ps1` → open browser → Login.

```powershell
cd <extract>\scripts
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Requires IIS (script detects, does not install IIS). Script can install .NET 8 Hosting Bundle and Python 3.12, create venv, bind OSSI **0.0.0.0:18776**, nest the site as **`/CM`** without changing the IIS site root.

Daily use: open `http://<host>:<port>/CM/` → Host / Password → **Login**.

Same command upgrades an existing install (`git pull` if `.git` is present) and **keeps** `monitored_trunks.json`.

Details: `INSTALL.txt`.

---

## This update (for review)

- **90s Auto pack moved to Python.** Frontend is display + heartbeat only.  
- Status chip: one box per tab, far right, countdown + phase text.  
- Logged-out: **all tabs dimmed**.  
- Gateway incomplete `list media-gateway`: **UPDATE FAILED** on missing MG# (not DOWN). Map pins still follow alarm/DOWN rules (FAILED is not treated as DOWN).  
- `list media-gateway` **more?[y] idle 3s** (that command only).  
- Trunk manual Refresh button removed.  
- Login hint: close-tab logoff **~5 minutes**.  
- Dead UI timers / leftover Refresh listeners removed.

---

## GitHub

https://github.com/w1n555/Avaya-PABX-Network-Monitoring-for-NOC
