# Avaya PABX Pulse

**Feel the pulse of PABX.**

A **read-only** Network Operations Centre dashboard for **Avaya Aura Communication Manager (CM 10.x)**. One browser screen for trunks, media gateways, alarms, extensions, a site map, and CDR search — without write access to the PABX.

Live URL (typical nested IIS): `http://<host>:8888/CM/`  
Source: https://github.com/w1n555/Avaya-PABX-Network-Monitoring-for-NOC

---

## Why this exists

NOC staff should not live in SAT. SAT is one login, one screen, one command at a time. When a site is down, a trunk is congested, or a station is forwarded off-net, the operator needs **the whole picture in seconds**, not a walk through `status trunk`, `display alarms`, and `list media-gateway`.

Pulse is built for that gap:

- **See the network, not a terminal.** Map pins, utilisation bars, and alarm flash on one page.
- **Read-only on purpose.** Only `list` / `display` / `status` over OSSI. A RO CM login (e.g. `monitor`) cannot change the switch.
- **One CM session, used fairly.** One SSH OSSI connection is shared and queued, so Login, 90s refresh, and click-in details do not trample each other.
- **Stay on the board.** F5 keeps the session. Closing the tab frees the CM login after about five minutes.

It does **not** replace Avaya System Manager or SAT for administration. It is the NOC wall and the first look when something is wrong.

---

## What you get

| Tab | Function |
|-----|----------|
| **Map View** | Offline Hong Kong map. Pin: Major / DOWN = red, Minor = yellow, otherwise green. |
| **Trunk** | Monitored trunk groups only. Util: green &lt;70%, yellow 70–90%, red &gt;90% or Idle=0. This poll `0/0/0` = **UPDATE FAILED**. |
| **Gateway** | Media-gateway list (Reg=n = DOWN). Click-in: modules, ports, assigned extensions. |
| **Extension** | Full number list (station + UDP fill). Click a list-extension number for identity, CM form (COR/COS, DND, CF, ECF), and digital **button assignment**. UDP-only / analog have no keys. |
| **CDR** | Search daily call files. Cap **5000** (red if capped). Default From/To = **today**. Logger pill UP/DOWN. |
| **Alarm** | Active alarms, newest first. Search and mtce-type filters. |

**Webpage flash (not CM):** active **MAJOR** → red flash; else **MINOR** → yellow. **WARNING does not flash.** **Ack** stops the webpage flash only — it does **not** clear alarms on CM.

**Before Login** every tab is dimmed. After Login all tabs light up.

**Auto 90s (while logged in):** `status trunk` (monitored TGs) → `display alarms` → `list media-gateway` → open MG configuration if Gateway Details is open. The header chip shows countdown / phase only.

**Login also loads** extension inventory (`list extension` + `list station` + `list uniform-dialplan`) and the trunk-group name catalogue. Extension inventory then refreshes **hourly** (queued).

**OSSI jobs are queued** (add/remove trunk, extension details, gateway details). The UI shows *Queued — waiting for OSSI…* instead of a raw HTTP error.

---

## Install

**Need:** Windows IIS (you install IIS), Administrator PowerShell, internet the first time (Hosting Bundle / Python if missing).

```powershell
cd <extract>\scripts
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

1. Install **IIS** (Windows Features) yourself.  
2. Extract this package to any folder (example: `C:\inetpub\wwwroot\CM`).  
3. Run `install.ps1` as Admin. Confirm the package root when asked.  
4. Open the URL it prints, typically `http://127.0.0.1:8888/CM/`.  
5. Enter **your** CM Host + RO user + password → **Login**.

The script does **not** install IIS and does **not** replace the parent site homepage. Nested mode only adds `/CM` and `/CM/api` on the existing IIS site/port.

Same command **upgrades** an existing install (`git pull` if `.git` is present) and **keeps** the monitored trunk list.

Optional flags: `-SkipDotNetInstall`, `-SkipPythonInstall`, `-SkipUpdate`, `-NonInteractive -RootPath "C:\path" -SitePort 8888`.  
Dedicated site on a free port: `-IisMode Dedicated -SitePort 8890`.  
Full installer notes: `INSTALL.txt`.

You do **not** need a separate OSSI repo or to start the bridge by hand every day.

---

## Configuration

| Item | Default / rule |
|------|----------------|
| IIS path | Nested `/CM` on your existing site port (often **8888**) |
| OSSI | SSH **:5022**, terminal **ossit**, one session, bind **0.0.0.0:18776** |
| CM login | Read-only account (e.g. `monitor`). Password stays in **bridge memory only** — never a file under wwwroot |
| Auto pack | **90 seconds**, monitored trunks only |
| Close tab | OSSI logoff after about **5 minutes** (frees the CM login slot) |
| CM idle | **30 minutes** with no command (heartbeat + 90s pack keep it alive while the UI is open) |
| Heartbeat | Browser every **15s** (keepalive only) |
| CDR | TCP **:9000** → `cdr-link/cdr/YYYYMMDD.TXT`. Not OSSI |
| Map sites | `map/sites.json` (edit coordinates / names; do not invent sites) |
| Monitored trunks | Saved on the server (`data_live` / install data). Notes can also be local |

**Safety**

- Commands are **list / display / status** only.  
- Do not store the CM password under the web root.  
- Only CDR is written as call logs. Do not log OSSI sessions.

---

## Use

1. Open `http://<host>:<port>/CM/`.  
2. Host / Port **5022** / User / Password → **Login**. Wait for the progress bar (trunks, alarms, gateways, then extension list — the last step can take a few minutes).  
3. Work the tabs. **F5** refreshes the page and **keeps** the OSSI session.  
4. **Logout** when finished, or close the tab (session ends after ~5 minutes).

**Trunk:** add a TG number (queued). Click the TG for channels. Remove is queued.  
**Gateway:** click hostname for modules and ports.  
**Extension:** search / type filters. Click a list-extension number (not `udp-ext`). Identity is from cache; CM form is live OSSI (`display station` + `status station` for DND / CF / ECF). Digital sets show **Button Assignment** keys **1–24**. Analog / CallrID have no keys.  
**Alarm:** Ack = stop flash on this webpage only.  
**CDR:** From/To default today; results cap 5000.

---

## Layout (on disk)

```text
index.html  style.css  app.js  *-ui.js   UI
map/                                    sites + offline tiles
python/ossi_service.py  *_parse.py      one OSSI process
vendor/avaya-ossi/                      SSH / OSSI client
cdr-link/                               CDR logger
api/                                    published CmApi
data_live/                              runtime JSON (not in git)
scripts/install.ps1
```

---

https://github.com/w1n555/Avaya-PABX-Network-Monitoring-for-NOC

Maintainers: leftover cleanup (old ports, dead UI helpers) is in [docs/post-optimization.md](docs/post-optimization.md). Not needed to install or operate.
