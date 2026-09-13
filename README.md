# Avaya PABX Pulse

**Feel the pulse of PABX.**

A **read-only** Network Operations Centre dashboard for **Avaya Aura Communication Manager (CM 10.x)**. One browser screen for trunks, media gateways, alarms, extensions, a site map, and CDR search — without write access to the PABX.

Live URL (typical nested IIS): `http://<host>:8888/CM/`  
Source: https://github.com/w1n555/Avaya-PABX-Pulse

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

Production servers often have **no CDN**. Operators install prerequisites **manually**, then run the offline installer.

### 1. Manual prerequisites (you install these)

| Prereq | Notes |
|--------|--------|
| **Windows IIS** | Windows Features → Internet Information Services (Management Console + WWW Services) |
| **.NET 8 Hosting Bundle** | **Not** the SDK. [Download Hosting Bundle](https://dotnet.microsoft.com/download/dotnet/8.0) |
| **Python 3.11 or 3.12** | Prefer **3.12**. Tick **Add python.exe to PATH**. **3.13+ is rejected** (offline wheels are cp311/cp312 ABI only) |

`install.bat` **checks** Admin, IIS/`appcmd`, ANCM/Hosting Bundle, and Python 3.11\|3.12 **before** calling `install.ps1`. It does **not** winget/auto-download Hosting Bundle or Python.

### 2. Get the files

- `git clone https://github.com/w1n555/Avaya-PABX-Pulse.git` then copy/move into e.g. `C:\inetpub\wwwroot\CM`  
- Or GitHub → **Releases** → download Source zip → extract to e.g. `C:\inetpub\wwwroot\CM`

### 3. Offline Python packages

`python\wheels\` ships with the repo. Installer runs pip **offline**:

```text
pip install --no-index --find-links=python\wheels setuptools wheel paramiko python-dotenv
pip install --no-index --no-build-isolation --find-links=python\wheels -e vendor\avaya-ossi
```

**No PyPI / no CDN** when `python\wheels` is present. No bundled `python.exe`.

### 4. Run installer

```bat
cd C:\inetpub\wwwroot\CM\scripts
install.bat
```

(`install.bat` bypasses Windows script policy, then runs `install.ps1`.)

**IIS modes**

| Mode | Flag | Behaviour |
|------|------|-----------|
| **Nested** (default) | `-IisMode Nested` | Adds `/CM` + `/CM/api` under an **existing** IIS site/port. Does **not** replace the parent homepage. |
| **Dedicated** | `-IisMode Dedicated -SitePort 8890` | New site on a **free** port that owns the whole site. |

Typical Nested flow:

1. IIS + Hosting Bundle + Python 3.12 already installed.  
2. App in a subfolder (example: `C:\inetpub\wwwroot\CM`).  
3. Run `install.bat` as Admin. Confirm package root; IIS port default **8888**.  
4. Open `http://127.0.0.1:8888/CM/`.  
5. Enter **your** CM Host + RO user + password → **Login**.

Same command **upgrades** an existing install (`git pull` if `.git` is present) and **keeps** `data_live\monitored_trunks.json`.

Optional flags: `-SkipUpdate`, `-NonInteractive -RootPath "C:\path" -SitePort 8888`.  
Full notes: `INSTALL.txt`.

Do **not** copy `data_live` from another PC unless you want the same monitored trunks. Copy `map\sites.json` only if you already have site pins.

You do **not** need a separate OSSI repo or to start the bridge by hand every day. The bridge binds **127.0.0.1:18776** and auto-starts at **Windows startup** (scheduled task `CM-NOC-OSSI-Bridge` as **SYSTEM**). CmApi can also start it on Login via `EnsureBridgeRunningAsync`.

---

## Security (defaults)

| Item | Default |
|------|---------|
| OSSI bridge bind | **127.0.0.1:18776** (loopback only; not `0.0.0.0`) |
| CmApi → bridge | `http://127.0.0.1:18776` |
| Bridge HTTP | Loopback only — no shared API key; rely on bind + host firewall |
| IIS exposure | Restrict / firewall the IIS site; do not expose Pulse broadly without network controls |
| IIS hidden segments | `src`, `scripts`, `python`, `data_live`, `cdr-link`, `vendor`, `docs`, `.git` |
| CORS | Loopback origins only — **not** reflect-any-origin + `AllowCredentials` |

There is **no** `X-Api-Key` / `Security:ApiKey`. Security model is loopback OSSI bridge + IIS lockdown (hidden segments, restrict who can reach the site).

---

## Configuration

| Item | Default / rule |
|------|----------------|
| IIS path | Nested `/CM` on your existing site port (often **8888**) |
| OSSI | SSH **:5022**, terminal **ossit**, one session, bind **127.0.0.1:18776** |
| CM login | Read-only account (e.g. `monitor`). Password stays in **bridge memory only** — never a file under wwwroot |
| Auto pack | **90 seconds**, monitored trunks only |
| Close tab | OSSI logoff after about **5 minutes** (frees the CM login slot) |
| CM idle | **30 minutes** with no command (heartbeat + 90s pack keep it alive while the UI is open) |
| Heartbeat | Browser every **15s** (keepalive only) |
| CDR | TCP **:9000** → `cdr-link/cdr/YYYYMMDD.TXT`. Not OSSI. Logger may bind `0.0.0.0` to receive from CM |
| Map sites | `map/sites.json` (edit coordinates / names; do not invent sites) |
| Monitored trunks | Saved on the server (`data_live` / install data). Notes can also be local |

**Safety**

- Commands are **list / display / status** only.  
- Do not store the CM password under the web root.  
- Do not commit `data_live\`.  
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
index.html  style.css  app.js  http.js  *-ui.js   UI
map/                                    sites + offline tiles
python/ossi_service.py  *_parse.py      one OSSI process
python/wheels/                          offline pip (3.11/3.12)
vendor/avaya-ossi/                      SSH / OSSI client
cdr-link/                               CDR logger
api/                                    published CmApi
data_live/                              runtime JSON (not in git)
scripts/install.bat   scripts/install.ps1
```

---

https://github.com/w1n555/Avaya-PABX-Pulse

Maintainers: leftover cleanup (old ports, dead UI helpers) is in [docs/post-optimization.md](docs/post-optimization.md). Not needed to install or operate.
