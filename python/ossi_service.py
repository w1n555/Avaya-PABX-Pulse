#!/usr/bin/env python3
"""
Local OSSI bridge for Avaya NOC dashboard (read-only).

Uses installable package: avaya-ossi (AVAYA-OSSI-2026).
Listens on 127.0.0.1 only. Does not expose CM to the LAN.

Endpoints (JSON):
  GET  /health
  GET  /session
  POST /session/connect   {host,port,username,password,pin?}
  POST /session/disconnect
  POST /refresh           optional {force:true}
  GET  /monitored
  PUT  /monitored         {trunks:[1,2,3]}
  POST /monitored/add     {tg:1}
  POST /monitored/remove  {tg:1}

Writes:
  <data-dir>/trunk_data.json
  <data-dir>/monitored_trunks.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

# Portable site root = parent of this python/ folder (any install path)
_SITE_ROOT = Path(__file__).resolve().parent.parent


def _bootstrap_path() -> None:
    """Prefer site venv imports; fall back to bundled vendor package only."""
    vendored = _SITE_ROOT / "vendor" / "avaya-ossi" / "src"
    if vendored.is_dir() and str(vendored) not in sys.path:
        sys.path.insert(0, str(vendored))


_bootstrap_path()

from avaya_ossi import OssiSession, SessionConfig  # noqa: E402
from trunk_parse import (  # noqa: E402
    parse_channel_counts,
    parse_channels,
    parse_trunk_groups,
    status_color,
    utilization_pct,
)
from alarm_parse import parse_alarms  # noqa: E402
from gateway_parse import (  # noqa: E402
    attach_board_alarms,
    gateway_summary,
    join_config_extensions,
    join_gateways,
    parse_list_configuration_media_gateway,
    parse_list_media_gateway,
    scan_gw_hw_faults,
)
from extension_parse import (  # noqa: E402
    _EXT_RE,
    extension_summary,
    merge_extension_ports,
    merge_udp_into_extensions,
    parse_display_hunt,
    parse_display_station,
    parse_display_vdn,
    parse_status_station,
    parse_list_extension,
    parse_list_station,
    parse_list_uniform_dialplan,
    udp_list_ok,
)

# ---------------------------------------------------------------------------
# Paths / state (defaults under install root; --data-dir can override)
# ---------------------------------------------------------------------------


class _Paths:
    data_dir: Path = _SITE_ROOT / "data_live"

    @property
    def monitored(self) -> Path:
        return self.data_dir / "monitored_trunks.json"

    @property
    def trunk_data(self) -> Path:
        return self.data_dir / "trunk_data.json"

    @property
    def alarms(self) -> Path:
        return self.data_dir / "alarms.json"

    @property
    def gateways(self) -> Path:
        return self.data_dir / "gateways.json"

    @property
    def extensions(self) -> Path:
        return self.data_dir / "extensions.json"


PATHS = _Paths()
# Public static cache (IIS can serve) for Alarm tab without API rebuild
ALARMS_PUBLIC = _SITE_ROOT / "alarms_cache.json"
GATEWAYS_PUBLIC = _SITE_ROOT / "gateways_cache.json"
EXTENSIONS_PUBLIC = _SITE_ROOT / "extensions_cache.json"
AUTO_REFRESH_SEC = 90
# Close-tab logoff. 90s was too tight: Chrome background tabs throttle
# setInterval to ~60s, one missed beat then logged the user off mid-use.
UI_GONE_SEC = 300
# Watchdog tick (check UI gone more often than full trunk refresh)
UI_WATCH_SEC = 15

_lock = threading.RLock()
# Serialize OSSI SSH commands only — do NOT hold _lock during long status trunk runs
# so heartbeat / trunk-data reads stay responsive.
_ossi_lock = threading.Lock()
_session: OssiSession | None = None
_cfg: SessionConfig | None = None
_connected = False
_host = ""
_username = ""
_last_error: str | None = None
_tg_catalog: dict[int, dict[str, Any]] = {}
_stop = threading.Event()
_last_ui_seen = 0.0  # time.monotonic(); 0 = no UI since process start
_last_refresh_at = 0.0
_refreshing = False
_last_cm_time: dict[str, Any] | None = None
_last_cm_time_mono = 0.0
_alarm_active: list[dict[str, Any]] = []
_alarm_resolved: list[dict[str, Any]] = []
_last_alarm_at = 0.0
_gateway_items: list[dict[str, Any]] = []
_last_gateway_at = 0.0
_extension_items: list[dict[str, Any]] = []
_last_extension_at = 0.0
_gw_config_by_mg: dict[int, dict[str, Any]] = {}
# Which UI tab is open (from heartbeat) — only that tab's OSSI auto work runs
_ui_active_tab: str = "trunk"
_next_refresh_mono = 0.0  # time.monotonic deadline; 0 = not armed
_ui_open_mg = 0  # 0 = none; set from heartbeat openMg
_ui_packing = False  # frontend Login/manual pack in flight; do not start auto pack
_auto_packing = False  # True for the whole backend 90s pack (trunks+alarms+gw)
_pack_phase = ""  # trunks | alarms | gateways | config


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _read_json(path: Path, default: Any) -> Any:
    if not path.is_file():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)


def load_monitored_items() -> list[dict[str, Any]]:
    """
    Preferred shape:
      { "items": [ {"tg":1,"order":0,"note":"..."}, ... ], "updatedAt": "..." }
    Legacy:
      { "trunks": [1,2,3] }
    """
    raw = _read_json(PATHS.monitored, {"items": [], "updatedAt": None})
    items: list[dict[str, Any]] = []
    seen: set[int] = set()

    if isinstance(raw, dict) and isinstance(raw.get("items"), list) and raw["items"]:
        for i, it in enumerate(raw["items"]):
            if not isinstance(it, dict):
                continue
            try:
                tg = int(it.get("tg") or 0)
            except (TypeError, ValueError):
                continue
            if tg < 1 or tg in seen:
                continue
            seen.add(tg)
            try:
                order = int(it.get("order", i))
            except (TypeError, ValueError):
                order = i
            note = str(it.get("note") or "")
            items.append({"tg": tg, "order": order, "note": note})
    else:
        trunks = raw.get("trunks") if isinstance(raw, dict) else raw
        for i, x in enumerate(trunks or []):
            try:
                tg = int(x)
            except (TypeError, ValueError):
                continue
            if tg < 1 or tg in seen:
                continue
            seen.add(tg)
            items.append({"tg": tg, "order": i, "note": ""})

    items.sort(key=lambda x: (x["order"], x["tg"]))
    for i, it in enumerate(items):
        it["order"] = i
    return items


def load_monitored() -> list[int]:
    """TG numbers in display order (for OSSI poll)."""
    return [it["tg"] for it in load_monitored_items()]


def save_monitored_items(items: list[dict[str, Any]]) -> dict[str, Any]:
    clean: list[dict[str, Any]] = []
    seen: set[int] = set()
    # sort by order then reindex
    tmp = []
    for it in items:
        try:
            tg = int(it.get("tg") or 0)
        except (TypeError, ValueError):
            continue
        if tg < 1 or tg in seen:
            continue
        seen.add(tg)
        try:
            order = int(it.get("order", len(tmp)))
        except (TypeError, ValueError):
            order = len(tmp)
        note = str(it.get("note") or "")[:200]
        tmp.append({"tg": tg, "order": order, "note": note})
    tmp.sort(key=lambda x: (x["order"], x["tg"]))
    for i, it in enumerate(tmp):
        clean.append({"tg": it["tg"], "order": i, "note": it["note"]})
    obj = {
        "items": clean,
        "trunks": [c["tg"] for c in clean],  # legacy compat
        "updatedAt": _now_iso(),
    }
    _write_json(PATHS.monitored, obj)
    return obj


def save_monitored(trunks: list[int]) -> dict[str, Any]:
    """Legacy helper: replace list, keep notes where possible."""
    prev = {it["tg"]: it for it in load_monitored_items()}
    items = []
    for i, t in enumerate(trunks):
        try:
            tg = int(t)
        except (TypeError, ValueError):
            continue
        if tg < 1:
            continue
        items.append(
            {
                "tg": tg,
                "order": i,
                "note": prev.get(tg, {}).get("note", ""),
            }
        )
    return save_monitored_items(items)


def write_trunk_data(
    items: list[dict[str, Any]],
    *,
    error: str | None = None,
    refreshing: bool | None = None,
) -> dict[str, Any]:
    # Attach notes/order from monitored config (local cache metadata)
    meta = {it["tg"]: it for it in load_monitored_items()}
    for it in items:
        m = meta.get(it.get("tg"))
        if m:
            it["note"] = m.get("note", "")
            it["order"] = m.get("order", 0)
    items = sorted(items, key=lambda x: (x.get("order", 0), x.get("tg", 0)))
    obj = {
        "lastUpdate": _now_iso(),
        "host": _host,
        "username": _username,
        "connected": _connected,
        "error": error,
        "source": "avaya-ossi",
        "refreshing": bool(_refreshing if refreshing is None else refreshing),
        "items": items,
    }
    obj.update(_schedule_public())
    if refreshing is not None:
        obj["refreshing"] = bool(refreshing)
    _write_json(PATHS.trunk_data, obj)
    return obj


def _load_trunk_items_map() -> dict[int, dict[str, Any]]:
    raw = _read_json(PATHS.trunk_data, {"items": []})
    items = raw.get("items") if isinstance(raw, dict) else []
    out: dict[int, dict[str, Any]] = {}
    for it in items or []:
        if not isinstance(it, dict):
            continue
        try:
            tg = int(it.get("tg") or 0)
        except (TypeError, ValueError):
            continue
        if tg >= 1:
            out[tg] = dict(it)
    return out


def ensure_seed_files() -> None:
    global _alarm_active, _gateway_items, _extension_items
    PATHS.data_dir.mkdir(parents=True, exist_ok=True)
    if not PATHS.monitored.is_file():
        save_monitored_items([{"tg": 1, "order": 0, "note": ""}])
    else:
        # normalize legacy file on boot
        save_monitored_items(load_monitored_items())
    if not PATHS.trunk_data.is_file():
        write_trunk_data([], error=None)
    # Warm in-memory caches from disk so truncated OSSI cannot wipe a good snapshot
    try:
        disk_a = _read_json(PATHS.alarms, None)
        if isinstance(disk_a, dict) and isinstance(disk_a.get("active"), list):
            _alarm_active = list(disk_a["active"])
    except Exception:
        pass
    try:
        disk_g = _read_json(PATHS.gateways, None)
        if isinstance(disk_g, dict) and isinstance(disk_g.get("items"), list):
            _gateway_items = list(disk_g["items"])
    except Exception:
        pass
    try:
        disk_e = _read_json(PATHS.extensions, None)
        if isinstance(disk_e, dict) and isinstance(disk_e.get("items"), list):
            _extension_items = list(disk_e["items"])
    except Exception:
        pass


# ---------------------------------------------------------------------------
# OSSI session
# ---------------------------------------------------------------------------


def touch_ui() -> None:
    """Browser is open / polled — keep OSSI session alive for refresh."""
    global _last_ui_seen
    _last_ui_seen = time.monotonic()


def ui_is_present() -> bool:
    # In-flight OSSI (pack / list extension) is driven by this dashboard —
    # do not log off mid-command if a heartbeat was delayed.
    if _refreshing or _ossi_lock.locked():
        return True
    if _last_ui_seen <= 0:
        return False
    return (time.monotonic() - _last_ui_seen) <= UI_GONE_SEC


def _arm_next_refresh(from_now=AUTO_REFRESH_SEC):
    global _next_refresh_mono
    _next_refresh_mono = time.monotonic() + max(1.0, float(from_now))


def _seconds_until_refresh() -> int:
    if _next_refresh_mono <= 0:
        return 0
    return max(0, int(round(_next_refresh_mono - time.monotonic())))


def _schedule_public() -> dict:
    return {
        "autoIntervalSec": AUTO_REFRESH_SEC,
        "refreshing": bool(_refreshing or _auto_packing or _ossi_lock.locked()),
        "secondsUntilRefresh": _seconds_until_refresh(),
        "nextRefreshAt": None,  # frontend derives from secondsUntilRefresh
        "openMg": _ui_open_mg or None,
        "packPhase": _pack_phase or None,
    }


def _as_bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if v is None:
        return False
    if isinstance(v, (int, float)):
        return v != 0
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def disconnect_unlocked() -> None:
    global _session, _cfg, _connected, _last_error
    global _next_refresh_mono, _ui_open_mg, _ui_packing, _auto_packing, _pack_phase
    if _session is not None:
        try:
            _session.close()
        except Exception:
            pass
    _session = None
    _cfg = None
    _connected = False
    _next_refresh_mono = 0.0
    _ui_open_mg = 0
    _ui_packing = False
    _auto_packing = False
    _pack_phase = ""


def connect_unlocked(body: dict[str, Any]) -> dict[str, Any]:
    global _session, _cfg, _connected, _host, _username, _last_error, _tg_catalog
    global _last_cm_time, _last_cm_time_mono

    # Accept camelCase or PascalCase (C# / browsers)
    def _g(*keys: str) -> str:
        for k in keys:
            if k in body and body[k] is not None:
                return str(body[k])
        return ""

    host = _g("host", "Host").strip()
    port_s = _g("port", "Port") or "5022"
    port = int(port_s) if str(port_s).isdigit() else 5022
    username = _g("username", "Username").strip()
    password = _g("password", "Password")
    pin = _g("pin", "Pin")

    if not host or not username or not password:
        raise ValueError("host, username, and password required")

    disconnect_unlocked()

    cfg = SessionConfig(
        host=host,
        port=port,
        username=username,
        password=password,
        pin=pin,
        ossi_term="ossit",
        idle_logoff_seconds=30 * 60,
        max_more_pages=40,
        # Large list extension can exceed 2 min (thousands of more?[y] pages)
        read_timeout=600.0,
    )
    sess = OssiSession(cfg)
    # prove session with light RO command (+ seed System Time cache)
    r = sess.run("display time", max_more_pages=1)
    if not r.ok:
        sess.close()
        raise RuntimeError(r.error or "display time failed")

    _session = sess
    _cfg = cfg
    _connected = True
    _host = host
    _username = username
    _last_error = None
    try:
        _last_cm_time = parse_display_time(r.text or "")
        _last_cm_time_mono = time.monotonic()
    except Exception:
        pass

    # catalog names — wait more?[y] (same 3s tail as other long lists)
    cat = sess.run("list trunk-group", max_more_pages=200, more_idle=3.0)
    try:
        PATHS.data_dir.mkdir(parents=True, exist_ok=True)
        (PATHS.data_dir / "list_trunk-group_last.txt").write_text(
            (cat.text or "")[:400000], encoding="utf-8", errors="replace"
        )
    except Exception:
        pass
    if cat.ok:
        _tg_catalog = parse_trunk_groups(cat.text)
    else:
        _tg_catalog = {}

    touch_ui()  # Login counts as UI present
    _arm_next_refresh(AUTO_REFRESH_SEC)  # first auto pack 90s after login (login pack is UI)

    # First trunk poll is done by caller OUTSIDE _lock so heartbeat stays free
    return {
        "ok": True,
        "host": host,
        "username": username,
        "connected": True,
        "catalogSize": len(_tg_catalog),
        "trunkData": None,
        "uiTimeoutSec": UI_GONE_SEC,
        "sessionIdleLogoffMin": 30,
        "systemTime": (_last_cm_time or {}).get("systemTime"),
        "cmTime": _last_cm_time,
    }


def _status_one_tg(sess: OssiSession, tg: int, catalog: dict[int, dict[str, Any]]) -> dict[str, Any]:
    """
    One OSSI `status trunk N` → summary counts + channel rows (shared by list + detail).
    No OSSI command logging — only structured result in trunk_data.json.
    """
    meta = catalog.get(tg, {})
    st = sess.run(f"status trunk {tg}", max_more_pages=40)
    if not st.ok:
        time.sleep(0.4)
        st = sess.run(f"status trunk {tg}", max_more_pages=40, retry_on_error=True)
    if not st.ok:
        # Quiet fail — no OSSI body log. UI shows Status "UPDATE FAILED".
        return {
            "tg": tg,
            "name": meta.get("name") or f"TG {tg}",
            "type": meta.get("type") or "",
            "tac": meta.get("tac") or "",
            "total": int(meta.get("total") or 0),
            "idle": 0,
            "busy": 0,
            "oos": 0,
            "utilizationPct": 0.0,
            "statusColor": "red",
            "lastUpdate": _now_iso(),
            "error": "UPDATE FAILED",
            "channels": [],
        }
    counts = parse_channel_counts(st.text)
    channels = parse_channels(st.text)
    total = counts["total"] or int(meta.get("total") or 0)
    idle = counts["idle"]
    busy = counts["busy"]
    oos = counts["oos"]
    if counts["total"] == 0 and total > 0:
        idle = total
        busy = 0
        oos = 0
    util = utilization_pct(busy, total if total > 0 else (idle + busy + oos))
    tot = total if total > 0 else (idle + busy + oos)
    if tot <= 0:
        return {
            "tg": tg,
            "name": meta.get("name") or f"TG {tg}",
            "type": meta.get("type") or "",
            "tac": meta.get("tac") or "",
            "total": None,
            "idle": None,
            "busy": None,
            "oos": None,
            "utilizationPct": None,
            "statusColor": "red",
            "lastUpdate": _now_iso(),
            "error": "UPDATE FAILED",
            "channels": [],
        }
    color = status_color(idle, util)
    return {
        "tg": tg,
        "name": meta.get("name") or f"TG {tg}",
        "type": meta.get("type") or "",
        "tac": meta.get("tac") or "",
        "total": tot,
        "idle": idle,
        "busy": busy,
        "oos": oos,
        "utilizationPct": util,
        "statusColor": color,
        "lastUpdate": _now_iso(),
        "error": None,
        "channels": channels,
    }


def refresh_unlocked() -> dict[str, Any]:
    """
    Poll each monitored TG with `status trunk N`.
    Writes trunk_data.json after EACH TG so the UI can update progressively.
    Does not hold _lock during OSSI I/O (caller should release before long work,
    or use refresh_progressive which manages locks).
    """
    global _last_error, _tg_catalog, _last_refresh_at, _refreshing

    with _lock:
        if not _connected or _session is None:
            # Keep last rows; only flip connected flag
            by = _load_trunk_items_map()
            return write_trunk_data(list(by.values()), error="Not connected", refreshing=False)
        sess = _session
        monitored = load_monitored()
        catalog = dict(_tg_catalog)
        _refreshing = True

    # Seed map with previous values so partial pass still shows old numbers for pending TGs
    by_tg = _load_trunk_items_map()
    # Drop TGs no longer monitored
    mon_set = set(monitored)
    by_tg = {k: v for k, v in by_tg.items() if k in mon_set}

    def _catalog_missing() -> bool:
        for t in monitored:
            meta = catalog.get(t) or {}
            nm = str(meta.get("name") or "").strip()
            if not nm or nm == f"TG {t}":
                return True
        return False

    # catalog if empty or monitored TGs still have fallback names
    if not catalog or _catalog_missing():
        with _ossi_lock:
            with _lock:
                if not _connected or _session is None:
                    _refreshing = False
                    return write_trunk_data(list(by_tg.values()), error="Not connected", refreshing=False)
                sess = _session
            cat = sess.run("list trunk-group", max_more_pages=200, more_idle=3.0)
        try:
            PATHS.data_dir.mkdir(parents=True, exist_ok=True)
            (PATHS.data_dir / "list_trunk-group_last.txt").write_text(
                (cat.text or "")[:400000], encoding="utf-8", errors="replace"
            )
        except Exception:
            pass
        if cat.ok:
            with _lock:
                _tg_catalog = parse_trunk_groups(cat.text)
                catalog = dict(_tg_catalog)

    for tg in monitored:
        with _lock:
            if not _connected or _session is None:
                break
            sess = _session
            catalog = dict(_tg_catalog)
        try:
            with _ossi_lock:
                row = _status_one_tg(sess, tg, catalog)
            # Per-TG fail stays on row.error only → UI Status "UPDATE FAILED".
            # Do NOT put TG e-line into global trunk_data.error / _last_error (login banner).
            by_tg[tg] = row
            # Progressive disk write — UI polls trunk-data and paints immediately
            with _lock:
                write_trunk_data(list(by_tg.values()), error=None, refreshing=True)
            time.sleep(0.25)
        except Exception as exc:
            meta = catalog.get(tg, {})
            by_tg[tg] = {
                "tg": tg,
                "name": meta.get("name") or f"TG {tg}",
                "type": meta.get("type") or "",
                "tac": meta.get("tac") or "",
                "total": int(meta.get("total") or 0),
                "idle": 0,
                "busy": 0,
                "oos": 0,
                "utilizationPct": 0.0,
                "statusColor": "red",
                "lastUpdate": _now_iso(),
                "error": str(exc) or "UPDATE FAILED",
                "channels": [],
            }
            with _lock:
                write_trunk_data(list(by_tg.values()), error=None, refreshing=True)

    with _lock:
        # Session-level lastError is not used for single-TG OSSI misses
        _last_error = None
        _last_refresh_at = time.monotonic()
        _refreshing = False
        return write_trunk_data(list(by_tg.values()), error=None, refreshing=False)


def refresh_one_tg(tg: int) -> dict[str, Any]:
    """Single TG status + immediate write (for on-demand progressive UI).

    Special: tg == ALARM_REFRESH_TG / 9996 → display alarms
    (kept so old UI /refresh/one still works; new UI POSTs /alarms/refresh).
    Special: tg == GATEWAY_REFRESH_TG (9995) → list media-gateway + alarm join.
    Special: tg == EXTENSION_REFRESH_TG (9994) → list extension inventory.
    Special: tg = EXTENSION_DETAIL_TG_BASE + ext → display station/vdn/hunt-group.

    Per-TG OSSI e-line / miss → row.error only (UI Status "UPDATE FAILED").
    Never promote to global lastError / trunk_data.error (login card stays clean).
    Next successful poll clears row.error.
    """
    global _last_refresh_at
    tg_i = int(tg)
    if tg_i in (ALARM_REFRESH_TG, ALARM_REFRESH_ACTIVE_TG):
        payload = refresh_alarms()
        return {
            "ok": True,
            "alarms": payload,
            "item": None,
            "alarmRefresh": True,
            "which": "active",
        }
    if tg_i == GATEWAY_REFRESH_TG:
        payload = refresh_gateways()
        return {
            "ok": True,
            "gateways": payload,
            "item": None,
            "gatewayRefresh": True,
        }
    if tg_i == EXTENSION_REFRESH_TG:
        payload = refresh_extensions()
        return {
            "ok": True,
            "extensions": payload,
            "item": None,
            "extensionRefresh": True,
        }
    if GATEWAY_CONFIG_TG_BASE <= tg_i <= GATEWAY_CONFIG_TG_BASE + 999:
        payload = refresh_gateway_config(tg_i - GATEWAY_CONFIG_TG_BASE)
        return {
            "ok": payload.get("ok", True),
            "gatewayConfig": payload,
            "item": None,
            "gatewayConfigRefresh": True,
        }
    if EXTENSION_DETAIL_TG_BASE <= tg_i < EXTENSION_DETAIL_TG_BASE + 10_000_000:
        ext = str(tg_i - EXTENSION_DETAIL_TG_BASE)
        payload = refresh_extension_detail(ext)
        return {
            "ok": payload.get("ok", True),
            "extensionDetail": payload,
            "item": None,
            "extensionDetailRefresh": True,
        }
    with _lock:
        if not _connected or _session is None:
            raise RuntimeError("Not connected")
        sess = _session
        catalog = dict(_tg_catalog)
    try:
        with _ossi_lock:
            row = _status_one_tg(sess, int(tg), catalog)
        # Gap after releasing lock so heartbeat / display time can slip in
        time.sleep(0.2)
    except Exception as exc:
        meta = catalog.get(int(tg), {})
        row = {
            "tg": int(tg),
            "name": meta.get("name") or f"TG {tg}",
            "type": meta.get("type") or "",
            "tac": meta.get("tac") or "",
            "total": int(meta.get("total") or 0),
            "idle": 0,
            "busy": 0,
            "oos": 0,
            "utilizationPct": 0.0,
            "statusColor": "red",
            "lastUpdate": _now_iso(),
            "error": "UPDATE FAILED",
            "channels": [],
        }
        by_tg = _load_trunk_items_map()
        by_tg[int(tg)] = row
        with _lock:
            _last_refresh_at = time.monotonic()
            data = write_trunk_data(list(by_tg.values()), error=None, refreshing=False)
        return {"ok": False, "item": row, "data": data, "error": str(exc) or "UPDATE FAILED"}
    by_tg = _load_trunk_items_map()
    by_tg[int(tg)] = row
    with _lock:
        # Stamp so progressive UI does not thrash mid cycle
        _last_refresh_at = time.monotonic()
        data = write_trunk_data(list(by_tg.values()), error=None, refreshing=False)
    return {"ok": not bool(row.get("error")), "item": row, "data": data}


def session_public() -> dict[str, Any]:
    ui_age = None
    if _last_ui_seen > 0:
        ui_age = round(time.monotonic() - _last_ui_seen, 1)
    cm = _last_cm_time
    return {
        "connected": _connected,
        "host": _host or None,
        "username": _username or None,
        "lastError": _last_error,
        "monitored": load_monitored(),
        "catalogSize": len(_tg_catalog),
        "uiPresent": ui_is_present(),
        "uiAgeSec": ui_age,
        "uiGoneTimeoutSec": UI_GONE_SEC,
        "sessionIdleLogoffMin": 30,
        # Topbar System Time only (UI polls every 60s)
        "systemTime": (cm or {}).get("systemTime"),
        "cmTime": cm,
        **_schedule_public(),
    }


def _field_from_text(text: str, *labels: str) -> str:
    """Pull a label: value from free-form SAT/OSSI text."""
    if not text:
        return ""
    for lab in labels:
        pat = re.compile(
            rf"(?:^|\n|\r)\s*{re.escape(lab)}\s*[:：]?\s*([^\r\n]+)",
            re.IGNORECASE,
        )
        m = pat.search(text)
        if m:
            return m.group(1).strip().strip("'\"")
    return ""


_MONTH_NAMES = {
    "january": 1,
    "february": 2,
    "march": 3,
    "april": 4,
    "may": 5,
    "june": 6,
    "july": 7,
    "august": 8,
    "september": 9,
    "october": 10,
    "november": 11,
    "december": 12,
}
_WEEKDAY_RE = r"Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday"
_WEEKDAY_SET = {w.lower() for w in _WEEKDAY_RE.split("|")}
_MONTH_RE = (
    r"January|February|March|April|May|June|July|August|September|October|November|December"
)


def _parse_cm_display_time_dlines(raw: str) -> tuple[str | None, str | None, str | None]:
    """
    CM OSSI `display time` real layout (observed on 10.x):

      dWednesday\\tAugust\\t12\\t2026\\t11
      d55\\t50\\tStandard\\t0

    or compacted (tabs stripped by some dumps):

      dWednesdayAugust12202611
      d5550Standard0

    → date 08/12/2026, time 11:55:50, day Wednesday
    """
    day_name = None
    month = day_n = year = hour = minute = second = None
    lines = [ln.strip() for ln in (raw or "").replace("\r", "").split("\n") if ln.strip()]
    dlines: list[str] = []
    for ln in lines:
        if ln.startswith("d") and len(ln) > 1 and not ln.lower().startswith("display"):
            dlines.append(ln[1:].strip())
        elif re.match(rf"^({_WEEKDAY_RE})", ln, re.I):
            dlines.append(ln)

    for s in dlines:
        parts = [p for p in re.split(r"[\t]+", s) if p != ""]
        # Tab form: Wednesday, August, 12, 2026, 11
        if len(parts) >= 5 and parts[0].lower() in _WEEKDAY_SET:
            try:
                day_name = parts[0]
                month = _MONTH_NAMES.get(parts[1].lower())
                day_n = int(parts[2])
                year = int(parts[3])
                hour = int(parts[4])
                continue
            except (ValueError, IndexError):
                pass
        # Tab form line2: 55, 50, Standard, 0
        if (
            len(parts) >= 2
            and parts[0].isdigit()
            and parts[1].isdigit()
            and (len(parts) < 3 or not parts[2][0:1].isdigit())
        ):
            if minute is None:
                minute = int(parts[0])
                second = int(parts[1])
            continue
        # Compact line1: WednesdayAugust12202611
        m = re.match(
            rf"^({_WEEKDAY_RE})({_MONTH_RE})(\d{{1,2}})(\d{{4}})(\d{{1,2}})$",
            s,
            re.I,
        )
        if m:
            day_name = m.group(1)
            month = _MONTH_NAMES.get(m.group(2).lower())
            day_n = int(m.group(3))
            year = int(m.group(4))
            hour = int(m.group(5))
            continue
        # Compact line2: 5550Standard0
        m2 = re.match(r"^(\d{2})(\d{2})Standard", s, re.I)
        if m2:
            minute = int(m2.group(1))
            second = int(m2.group(2))
            continue
        # Mixed with spaces/tabs: August 12 2026 11
        m3 = re.search(
            rf"({_MONTH_RE})[\s\t]+(\d{{1,2}})[\s\t]+(\d{{4}})[\s\t]+(\d{{1,2}})\b",
            s,
            re.I,
        )
        if m3 and month is None:
            month = _MONTH_NAMES.get(m3.group(1).lower())
            day_n = int(m3.group(2))
            year = int(m3.group(3))
            hour = int(m3.group(4))

    if month and day_n and year is not None and hour is not None:
        if minute is None:
            minute = 0
        if second is None:
            second = 0
        date = f"{month:02d}/{day_n:02d}/{year}"
        t = f"{hour:02d}:{minute:02d}:{second:02d}"
        return date, t, day_name
    return None, None, day_name


def parse_display_time(text: str) -> dict[str, Any]:
    """
    Parse `display time` → System Time only.
    Handles CM OSSI d-line layout, label:value, and bare date/time.
    """
    raw = text or ""
    date = _field_from_text(raw, "Date", "System Date")
    day = _field_from_text(raw, "Day of the Week", "Day of Week", "Day")
    t = _field_from_text(raw, "Time", "System Time", "Local Time")

    # Primary path for this CM: dWednesday\\tAugust\\t12\\t2026\\t11 + d55\\t50\\tStandard
    if not date or not t:
        d2, t2, day2 = _parse_cm_display_time_dlines(raw)
        if d2:
            date = date or d2
        if t2:
            t = t or t2
        if day2:
            day = day or day2

    # OSSI t-field / f-field style
    if not date:
        m = re.search(r"(?:^|[\n\r])\s*t?Date\s*[\t:=\x00]+\s*([0-9/.\-]+)", raw, re.I)
        if m:
            date = m.group(1).strip()
    if not t:
        m = re.search(
            r"(?:^|[\n\r])\s*t?Time\s*[\t:=\x00]+\s*([0-9:\s]+(?:[AP]M)?)",
            raw,
            re.I,
        )
        if m:
            t = m.group(1).strip()

    # Bare patterns
    if not date:
        m = re.search(r"\b(\d{1,2}/\d{1,2}/\d{2,4})\b", raw)
        if m:
            date = m.group(1)
    if not date:
        m = re.search(r"\b(\d{4}-\d{2}-\d{2})\b", raw)
        if m:
            date = m.group(1)
    if not t:
        m = re.search(r"\b([01]?\d|2[0-3]):[0-5]\d:[0-5]\d\b", raw)
        if m:
            t = m.group(0)
    if not t:
        m = re.search(r"\b([01]?\d|2[0-3]):[0-5]\d\s*(?:[AaPp][Mm])?\b", raw)
        if m:
            t = m.group(0).strip()

    system_time = " ".join(x for x in (date, t) if x).strip()
    if not system_time or system_time in ("-", "—"):
        system_time = ""

    return {
        "ok": bool(system_time),
        "systemTime": system_time or None,
        "date": date or None,
        "day": day or None,
        "time": t or None,
        "checkedAt": _now_iso(),
    }


def fetch_cm_time(*, force: bool = False) -> dict[str, Any]:
    """
    RO `display time` for topbar System Time.
    UI calls every 60s with force; tiny 5s cache only avoids double-hit.
    No OSSI command-body logging (optional short raw dump only when parse fails).
    """
    global _last_cm_time, _last_cm_time_mono
    now = time.monotonic()
    if (
        not force
        and _last_cm_time
        and _last_cm_time.get("systemTime")
        and _last_cm_time_mono > 0
        and (now - _last_cm_time_mono) < 5
    ):
        return {**_last_cm_time, "cached": True}

    with _lock:
        if not _connected or _session is None:
            raise RuntimeError("Not connected")
        sess = _session
    with _ossi_lock:
        st = sess.run("display time", max_more_pages=2)
    body = (st.text or "") or (getattr(st, "raw", None) or "")
    if not st.ok and not body.strip():
        raise RuntimeError(st.error or "display time failed")

    parsed = parse_display_time(body)
    if not parsed.get("systemTime"):
        # Keep previous good sample if parse fails once
        if _last_cm_time and _last_cm_time.get("systemTime"):
            prev = dict(_last_cm_time)
            prev["cached"] = True
            prev["stale"] = True
            return prev
        parsed["ok"] = False
        parsed["error"] = st.error or "could not parse display time"
    else:
        parsed["ok"] = True
    _last_cm_time = parsed
    _last_cm_time_mono = now
    parsed["cached"] = False
    return parsed


# ---------------------------------------------------------------------------
# Auto refresh thread — UI-gone logoff + backend-owned 90s pack
# ---------------------------------------------------------------------------


def run_auto_pack() -> None:
    """
    Backend Auto pack: status trunk (each monitored TG), display alarms,
    list media-gateway, then open-MG list configuration. No list extension.
    Does not hold _lock during OSSI I/O. Never raises to the watchdog thread.
    """
    global _refreshing, _auto_packing, _pack_phase
    started = False
    try:
        with _lock:
            if not _connected or _session is None:
                return
            if _ui_packing or _refreshing or _auto_packing or _ossi_lock.locked():
                return
            _refreshing = True
            _auto_packing = True
            _pack_phase = "trunks"
            started = True
            by = _load_trunk_items_map()
            write_trunk_data(list(by.values()), error=None, refreshing=True)
        try:
            refresh_unlocked()
        except Exception:
            pass
        with _lock:
            # refresh_unlocked() clears _refreshing at end — keep pack flag until done
            if _connected and _session is not None:
                _refreshing = True
                _auto_packing = True
                _pack_phase = "alarms"
                by = _load_trunk_items_map()
                write_trunk_data(list(by.values()), error=None, refreshing=True)
        try:
            refresh_alarms()
        except Exception:
            pass
        with _lock:
            if _connected and _session is not None:
                _pack_phase = "gateways"
                by = _load_trunk_items_map()
                write_trunk_data(list(by.values()), error=None, refreshing=True)
        try:
            refresh_gateways()
        except Exception:
            pass
        mg = 0
        with _lock:
            mg = int(_ui_open_mg or 0)
            if mg >= 1:
                _pack_phase = "config"
                by = _load_trunk_items_map()
                write_trunk_data(list(by.values()), error=None, refreshing=True)
        if mg >= 1:
            try:
                refresh_gateway_config(mg)
            except Exception:
                pass
    except Exception:
        pass
    finally:
        if not started:
            return
        try:
            with _lock:
                _refreshing = False
                _auto_packing = False
                _pack_phase = ""
                _arm_next_refresh(AUTO_REFRESH_SEC)
                by = _load_trunk_items_map()
                write_trunk_data(list(by.values()), error=None, refreshing=False)
        except Exception:
            _refreshing = False
            _auto_packing = False
            _pack_phase = ""
            try:
                _arm_next_refresh(AUTO_REFRESH_SEC)
            except Exception:
                pass


def _auto_loop() -> None:
    """
    Watchdog + backend Auto 90s pack.

    Heartbeat still comes from the browser — do not log off just because
    a pack is running. UI-gone disconnect is unchanged (UI_GONE_SEC).
    Pack order: status trunk N × monitored TGs, display alarms,
    list media-gateway, open MG list configuration. No list extension.
    """
    global _last_error
    while not _stop.is_set():
        if _stop.wait(UI_WATCH_SEC):
            break
        do_pack = False
        with _lock:
            if not _connected or _session is None:
                continue
            if not ui_is_present():
                try:
                    print(
                        f"ossi-bridge: UI silent >{UI_GONE_SEC}s — OSSI logged off",
                        flush=True,
                    )
                    disconnect_unlocked()
                    # Keep last TG rows; only mark offline (UI should not flash empty)
                    by = _load_trunk_items_map()
                    write_trunk_data(list(by.values()), error=None, refreshing=False)
                    _last_error = "UI closed or silent — OSSI logged off"
                except Exception as exc:
                    _last_error = str(exc)
                continue
            # UI present — backend-owned 90s Auto pack (frontend displays countdown + cache)
            if _ui_packing:
                continue
            if _refreshing or _ossi_lock.locked():
                continue
            if _next_refresh_mono <= 0:
                _arm_next_refresh(AUTO_REFRESH_SEC)
            if time.monotonic() >= _next_refresh_mono:
                do_pack = True
        if do_pack:
            try:
                run_auto_pack()
            except Exception:
                pass


def _alarm_summary(active: list[dict[str, Any]]) -> dict[str, int]:
    maj = min_ = warn = 0
    for a in active:
        s = (a.get("severity") or "").upper()
        if s == "MAJOR":
            maj += 1
        elif s == "MINOR":
            min_ += 1
        else:
            warn += 1
    return {
        "activeMajor": maj,
        "activeMinor": min_,
        "activeWarning": warn,
        "activeTotal": len(active),
    }


def _write_alarms_payload() -> dict[str, Any]:
    global _alarm_active, _alarm_resolved
    with _lock:
        active = list(_alarm_active)
        resolved = list(_alarm_resolved)
        connected = _connected
    types = sorted(
        {
            str(a.get("mtceType") or a.get("mtceName") or "").strip()
            for a in active + resolved
            if (a.get("mtceType") or a.get("mtceName"))
        }
    )
    payload = {
        "ok": True,
        "connected": connected,
        "lastUpdate": _now_iso(),
        "active": active,
        "resolved": resolved,
        "mtceTypes": types,
        "summary": _alarm_summary(active),
        "source": "avaya-ossi",
    }
    try:
        PATHS.data_dir.mkdir(parents=True, exist_ok=True)
        PATHS.alarms.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except Exception:
        pass
    try:
        ALARMS_PUBLIC.write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8"
        )
    except Exception:
        pass
    return payload


# Magic TGs for POST /refresh/one — works with old CmApi.dll (no /alarms route).
ALARM_REFRESH_TG = 9999
ALARM_REFRESH_ACTIVE_TG = 9996
GATEWAY_REFRESH_TG = 9995
EXTENSION_REFRESH_TG = 9994
# refresh/one tg = 990000 + MG  →  list configuration media-gateway N (old CmApi)
GATEWAY_CONFIG_TG_BASE = 990000
# refresh/one tg = 8_000_000 + numeric extension → display station/vdn/hunt-group
EXTENSION_DETAIL_TG_BASE = 8_000_000


def _run_display_alarms_form(
    sess: Any,
    fields: list[str] | None,
    *,
    status: str,
    retry_on_error: bool = False,
) -> tuple[str, bool, str | None, float]:
    """
    One OSSI display alarms.
    fields=None → SAT defaults (Active=y Resolved=n).
    Returns (text, ok, error, elapsed_sec).
    """
    t0 = time.perf_counter()
    try:
        st = sess.run(
            "display alarms",
            max_more_pages=80,
            form_fields=fields,
            retry_on_error=retry_on_error,
        )
        text = st.text or ""
        elapsed = round(time.perf_counter() - t0, 2)
        more = getattr(st, "more_pages", 0)
        if st.ok:
            return text, True, None, elapsed
        return text, bool(text.strip()) and not (st.error or ""), st.error, elapsed
    except Exception as exc:
        return "", False, str(exc), round(time.perf_counter() - t0, 2)


def _save_alarms_raw_debug(kind: str, text: str) -> None:
    """Short raw dump for Date Alarmed troubleshooting (no credentials)."""
    try:
        p = PATHS.data_dir / f"display_alarms_{kind}_last.txt"
        PATHS.data_dir.mkdir(parents=True, exist_ok=True)
        p.write_text((text or "")[:80000], encoding="utf-8", errors="replace")
    except Exception:
        pass


def refresh_alarms(*, which: str = "active") -> dict[str, Any]:
    """Active alarms only — one OSSI `display alarms` (SAT default Active=y)."""
    global _alarm_active, _last_alarm_at
    with _lock:
        if not _connected or _session is None:
            return _write_alarms_payload()
        sess = _session

    new_active: list[dict[str, Any]] | None = None
    sec_a = 0.0
    kept_prev = False
    with _ossi_lock:
        text_a, ok_a, _err_a, sec_a = _run_display_alarms_form(
            sess, None, status="active"
        )
        parsed_a = parse_alarms(text_a, status="active") if text_a else []
        _save_alarms_raw_debug("active", text_a)
        if parsed_a or ok_a:
            new_active = parsed_a

    with _lock:
        if new_active is not None:
            prev_n = len(_alarm_active)
            new_n = len(new_active)
            # Refuse truncated/desynced overwrite of a fuller cache
            if prev_n >= 20 and new_n > 0 and new_n < prev_n * 0.5:
                kept_prev = True
            else:
                _alarm_active = new_active
                _alarm_resolved = []
        _last_alarm_at = time.monotonic()
    payload = _write_alarms_payload()
    payload["timing"] = {
        "activeSec": sec_a,
        "totalSec": sec_a,
        "activeRows": len(new_active or []),
    }
    if kept_prev:
        payload["warning"] = (
            f"display alarms looked incomplete ({len(new_active or [])}) "
            f"— kept previous {len(payload.get('active') or [])}"
        )
    return payload


def _write_gateways_payload() -> dict[str, Any]:
    global _gateway_items
    with _lock:
        items = list(_gateway_items)
        connected = _connected
    payload = {
        "ok": True,
        "connected": connected,
        "lastUpdate": _now_iso(),
        "items": items,
        "summary": gateway_summary(items),
        "source": "avaya-ossi",
    }
    try:
        PATHS.data_dir.mkdir(parents=True, exist_ok=True)
        PATHS.gateways.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except Exception:
        pass
    try:
        GATEWAYS_PUBLIC.write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8"
        )
    except Exception:
        pass
    return payload


def refresh_gateways() -> dict[str, Any]:
    """One OSSI `list media-gateway`; Mj/Mn/Wn from current Active alarm cache."""
    global _gateway_items, _last_gateway_at
    with _lock:
        if not _connected or _session is None:
            return gateways_public()
        sess = _session
        alarms = list(_alarm_active)

    sec = 0.0
    new_items: list[dict[str, Any]] | None = None
    err: str | None = None
    with _ossi_lock:
        t0 = time.perf_counter()
        try:
            st = sess.run(
                "list media-gateway",
                max_more_pages=80,
                retry_on_error=False,
                more_idle=3.0,
            )
            text = st.text or ""
            sec = round(time.perf_counter() - t0, 2)
            try:
                p = PATHS.data_dir / "list_media-gateway_last.txt"
                PATHS.data_dir.mkdir(parents=True, exist_ok=True)
                p.write_text(text[:400000], encoding="utf-8", errors="replace")
            except Exception:
                pass
            parsed = parse_list_media_gateway(text)
            if parsed or getattr(st, "ok", False):
                new_items = join_gateways(parsed, alarms)
            else:
                err = getattr(st, "error", None) or "list media-gateway failed"
        except Exception as exc:
            err = str(exc)
            sec = round(time.perf_counter() - t0, 2)

    kept_prev = False
    with _lock:
        if new_items is not None:
            prev_n = len(_gateway_items)
            new_n = len(new_items)
            if new_n == 0 and prev_n > 0:
                # Command returned nothing — retry next Auto, do not zero the table
                kept_prev = True
            elif prev_n > new_n > 0:
                seen = {int(x.get("mg") or 0) for x in new_items}
                extra = []
                for old in _gateway_items:
                    if int(old.get("mg") or 0) in seen:
                        continue
                    row = dict(old)
                    row["error"] = "UPDATE FAILED"
                    extra.append(row)
                new_items = list(new_items) + extra
                _gateway_items = new_items
            else:
                _gateway_items = new_items
        _last_gateway_at = time.monotonic()
    payload = _write_gateways_payload()
    payload["timing"] = {
        "listSec": sec,
        "rows": len(new_items if new_items is not None else payload.get("items") or []),
    }
    if kept_prev:
        payload["warning"] = (
            f"list media-gateway incomplete ({len(new_items or [])}) "
            f"— kept previous {len(payload.get('items') or [])}"
        )
    if err:
        payload["error"] = err
    return payload


def gateways_public() -> dict[str, Any]:
    with _lock:
        if _gateway_items:
            return _write_gateways_payload()
    disk = _read_json(PATHS.gateways, None)
    if isinstance(disk, dict) and (disk.get("items") is not None or disk.get("ok")):
        return disk
    pub = _read_json(GATEWAYS_PUBLIC, None)
    if isinstance(pub, dict):
        return pub
    return {
        "ok": True,
        "connected": _connected,
        "lastUpdate": None,
        "items": [],
        "summary": gateway_summary([]),
    }


def _gw_meta(mg: int) -> dict[str, Any]:
    with _lock:
        items = list(_gateway_items)
    for g in items:
        if int(g.get("mg") or 0) == int(mg):
            return dict(g)
    return {"mg": int(mg)}


def gateway_config_public(mg: int) -> dict[str, Any]:
    with _lock:
        cached = _gw_config_by_mg.get(int(mg))
        connected = _connected
    if cached:
        out = dict(cached)
        out["connected"] = connected
        out["cached"] = True
        return out
    return {
        "ok": True,
        "connected": connected,
        "mg": int(mg),
        "boards": [],
        "assigned": [],
        "cached": True,
        "lastUpdate": None,
        **_gw_meta(mg),
    }


def refresh_gateway_config(mg: int) -> dict[str, Any]:
    """On-click OSSI `list configuration media-gateway N` (data is often page 2+)."""
    global _gw_config_by_mg
    mg_i = int(mg)
    if mg_i < 1:
        return {"ok": False, "error": "mg required", "mg": mg_i, "boards": [], "assigned": []}
    with _lock:
        if not _connected or _session is None:
            raise RuntimeError("Not connected")
        sess = _session
        ext_items = list(_extension_items)
        alarms = list(_alarm_active)

    cmd = f"list configuration media-gateway {mg_i}"
    text = ""
    err: str | None = None
    sec = 0.0
    with _ossi_lock:
        t0 = time.perf_counter()
        try:
            st = sess.run(cmd, max_more_pages=25, retry_on_error=False)
            text = st.text or ""
            if not parse_list_configuration_media_gateway(text, mg_i):
                st2 = sess.run(
                    "list configuration media-gateway",
                    max_more_pages=25,
                    form_fields=[f"0001\t{mg_i}"],
                    retry_on_error=False,
                )
                alt = st2.text or ""
                if parse_list_configuration_media_gateway(alt, mg_i) or len(alt) > len(text):
                    text = alt
                    cmd = "list configuration media-gateway + form"
            if not getattr(st, "ok", True):
                err = getattr(st, "error", None)
        except Exception as exc:
            err = str(exc)
        sec = round(time.perf_counter() - t0, 2)
        try:
            p = PATHS.data_dir / f"list_configuration_media-gateway_{mg_i}_last.txt"
            PATHS.data_dir.mkdir(parents=True, exist_ok=True)
            p.write_text(text[:200000], encoding="utf-8", errors="replace")
        except Exception:
            pass
        time.sleep(0.15)

    boards = parse_list_configuration_media_gateway(text, mg_i)
    attach_board_alarms(boards, alarms)
    hw = scan_gw_hw_faults(alarms, mg_i)
    assigned = join_config_extensions(boards, ext_items)
    assigned_n = sum(
        1 for b in boards for p in (b.get("ports") or []) if p.get("state") == "assigned"
    )
    unassigned_n = sum(
        1 for b in boards for p in (b.get("ports") or []) if p.get("state") == "unassigned"
    )
    meta = _gw_meta(mg_i)
    payload = {
        "ok": err is None,
        "connected": True,
        "mg": mg_i,
        "command": cmd,
        "boards": boards,
        "assigned": assigned,
        "summary": {
            "boards": len(boards),
            "assigned": assigned_n,
            "unassigned": unassigned_n,
            "withExt": sum(1 for a in assigned if a.get("extension")),
        },
        "lastUpdate": _now_iso(),
        "timing": {"listSec": sec},
        "cached": False,
        "mj": int(meta.get("mj") or 0),
        "mn": int(meta.get("mn") or 0),
        "wn": int(meta.get("wn") or 0),
        "psuFault": bool(hw.get("psuFault")),
        "fanFault": bool(hw.get("fanFault")),
        **{k: v for k, v in meta.items() if k not in ("mj", "mn", "wn")},
    }
    if err:
        payload["error"] = err
        payload["ok"] = bool(boards)
    with _lock:
        if boards or not _gw_config_by_mg.get(mg_i):
            _gw_config_by_mg[mg_i] = payload
        elif _gw_config_by_mg.get(mg_i) and err:
            prev = dict(_gw_config_by_mg[mg_i])
            prev["error"] = err
            prev["connected"] = True
            return prev
    return payload


def _write_extensions_payload() -> dict[str, Any]:
    global _extension_items
    with _lock:
        items = list(_extension_items)
        connected = _connected
    payload = {
        "ok": True,
        "connected": connected,
        "lastUpdate": _now_iso(),
        "items": items,
        "summary": extension_summary(items),
        "source": "avaya-ossi",
        "command": "list extension + list station + list uniform-dialplan",
    }
    try:
        PATHS.data_dir.mkdir(parents=True, exist_ok=True)
        PATHS.extensions.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except Exception:
        pass
    try:
        EXTENSIONS_PUBLIC.write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8"
        )
    except Exception:
        pass
    return payload


def refresh_extensions() -> dict[str, Any]:
    """list extension + list station + list uniform-dialplan — not part of 90s pack.

    Holds `_ossi_lock` for the whole triple so 90s pack waits (queue), never interleaves.
    """
    global _extension_items, _last_extension_at, _pack_phase
    with _lock:
        if not _connected or _session is None:
            return extensions_public()
        sess = _session
        prev_items = list(_extension_items)
        _pack_phase = "extensions"

    sec = 0.0
    station_sec = 0.0
    udp_sec = 0.0
    new_items: list[dict[str, Any]] | None = None
    station_map: dict[str, dict[str, str]] = {}
    err: str | None = None
    more_pages = 0
    station_pages = 0
    udp_pages = 0
    truncated = False
    station_truncated = False
    udp_truncated = False
    station_err: str | None = None
    udp_err: str | None = None
    udp_rows: list[dict[str, Any]] | None = None
    udp_row_n = 0
    with _ossi_lock:
        t0 = time.perf_counter()
        try:
            st = sess.run(
                "list extension",
                max_more_pages=2000,
                retry_on_error=False,
                more_idle=3.0,
            )
            text = st.text or ""
            sec = round(time.perf_counter() - t0, 2)
            more_pages = int(getattr(st, "more_pages", 0) or 0)
            truncated = bool(getattr(st, "truncated_pages", False))
            try:
                p = PATHS.data_dir / "list_extension_last.txt"
                PATHS.data_dir.mkdir(parents=True, exist_ok=True)
                p.write_text(text[:800000], encoding="utf-8", errors="replace")
            except Exception:
                pass
            parsed = parse_list_extension(text)
            text_l = (text or "").lower()
            # Must actually be list extension output (not residual gateway/trunk)
            cmd_ok = "clist extension" in text_l.replace(" ", " ") or "list extension" in text_l
            looks_like_gw = "g450" in text_l or "g430" in text_l or "media-gateway" in text_l
            known_types = {
                "station-user",
                "vdn-extension",
                "announcement",
                "phantom-user",
                "hunt-group",
                "agent-loginid",
                "data-extension",
            }
            type_hit = sum(
                1
                for r in parsed
                if str(r.get("type") or "").lower() in known_types
                or "endpoint" in str(r.get("type") or "").lower()
            )
            isdn_n = sum(1 for r in parsed if str(r.get("type") or "").lower() == "isdn")
            looks_like_trunk = len(parsed) > 0 and isdn_n >= max(3, int(len(parsed) * 0.8))
            if looks_like_gw or looks_like_trunk or (parsed and type_hit == 0 and len(parsed) < 20):
                err = (
                    "list extension desync/garbage "
                    f"(rows={len(parsed)} typeHits={type_hit}) — kept previous"
                )
                new_items = None
            elif not cmd_ok and len(parsed) < 10:
                err = "list extension response missing command echo — kept previous"
                new_items = None
            elif parsed:
                new_items = parsed
            elif getattr(st, "ok", False):
                new_items = parsed
            else:
                err = getattr(st, "error", None) or "list extension failed"
        except Exception as exc:
            err = str(exc)
            sec = round(time.perf_counter() - t0, 2)

        # Port overlay — same lock so 90s cannot sneak between the lists
        t1 = time.perf_counter()
        try:
            st2 = sess.run(
                "list station",
                max_more_pages=2000,
                retry_on_error=False,
                more_idle=3.0,
            )
            text2 = st2.text or ""
            station_sec = round(time.perf_counter() - t1, 2)
            station_pages = int(getattr(st2, "more_pages", 0) or 0)
            station_truncated = bool(getattr(st2, "truncated_pages", False))
            try:
                p2 = PATHS.data_dir / "list_station_last.txt"
                PATHS.data_dir.mkdir(parents=True, exist_ok=True)
                p2.write_text(text2[:800000], encoding="utf-8", errors="replace")
            except Exception:
                pass
            text2_l = (text2 or "").lower()
            cmd2_ok = "clist station" in text2_l.replace(" ", " ") or "list station" in text2_l
            parsed_st = parse_list_station(text2)
            if not cmd2_ok and len(parsed_st) < 10:
                station_err = "list station response missing command echo — ports kept previous"
            elif parsed_st:
                station_map = parsed_st
            elif getattr(st2, "ok", False):
                station_map = parsed_st
            else:
                station_err = getattr(st2, "error", None) or "list station failed"
        except Exception as exc:
            station_err = str(exc)
            station_sec = round(time.perf_counter() - t1, 2)

        t2 = time.perf_counter()
        try:
            def _run_udp():
                return sess.run(
                    "list uniform-dialplan",
                    max_more_pages=2000,
                    retry_on_error=False,
                    more_idle=3.0,
                )

            st3 = _run_udp()
            text3 = st3.text or ""
            parsed_udp = parse_list_uniform_dialplan(text3)
            if not udp_list_ok(text3, parsed_udp):
                time.sleep(0.45)
                st3 = _run_udp()
                text3 = st3.text or ""
                parsed_udp = parse_list_uniform_dialplan(text3)
            udp_sec = round(time.perf_counter() - t2, 2)
            udp_pages = int(getattr(st3, "more_pages", 0) or 0)
            udp_truncated = bool(getattr(st3, "truncated_pages", False))
            udp_row_n = len(parsed_udp)
            dump_ok = udp_list_ok(text3, parsed_udp)
            try:
                PATHS.data_dir.mkdir(parents=True, exist_ok=True)
                dump_name = (
                    "list_uniform-dialplan_last.txt"
                    if dump_ok
                    else "list_uniform-dialplan_bad.txt"
                )
                (PATHS.data_dir / dump_name).write_text(
                    (text3 or "")[:800000], encoding="utf-8", errors="replace"
                )
            except Exception:
                pass
            if dump_ok:
                udp_rows = parsed_udp
            else:
                udp_err = (
                    "list uniform-dialplan desync/garbage "
                    f"(rows={udp_row_n}) — UDP kept previous"
                )
                udp_rows = None
        except Exception as exc:
            udp_err = str(exc)
            udp_sec = round(time.perf_counter() - t2, 2)
            udp_rows = None

    kept_prev = False
    with _lock:
        if new_items is not None:
            prev_n = len(_extension_items)
            new_n = len(new_items)
            if prev_n >= 50 and new_n < prev_n * 0.5:
                kept_prev = True
                merged = merge_extension_ports(
                    list(_extension_items), station_map, prev_items
                )
                _extension_items = merged
            else:
                _extension_items = merge_extension_ports(
                    new_items, station_map, prev_items
                )
        elif station_map and _extension_items:
            # Extension list failed; still apply ports onto last-good inventory
            _extension_items = merge_extension_ports(
                list(_extension_items), station_map, prev_items
            )
        try:
            _extension_items = merge_udp_into_extensions(
                list(_extension_items), udp_rows, prev_items
            )
        except Exception as exc:
            udp_err = str(exc)
            try:
                _extension_items = merge_udp_into_extensions(
                    list(_extension_items), None, prev_items
                )
            except Exception:
                pass
        _last_extension_at = time.monotonic()
    try:
        payload = _write_extensions_payload()
        payload["timing"] = {
            "listSec": sec,
            "stationSec": station_sec,
            "udpSec": udp_sec,
            "rows": len(payload.get("items") or []),
            "portRows": len(station_map),
            "udpRows": udp_row_n,
            "morePages": more_pages,
            "stationMorePages": station_pages,
            "udpMorePages": udp_pages,
            "truncated": truncated,
            "stationTruncated": station_truncated,
            "udpTruncated": udp_truncated,
        }
        if kept_prev:
            payload["warning"] = (
                f"list extension incomplete ({len(new_items or [])}) "
                f"— kept previous {len(payload.get('items') or [])}"
            )
        if err:
            payload["error"] = err
            payload["ok"] = bool(payload.get("items"))
        warn_bits: list[str] = []
        if payload.get("warning"):
            warn_bits.append(str(payload["warning"]))
        if station_err:
            warn_bits.append(station_err)
        if udp_err:
            warn_bits.append(udp_err)
        if warn_bits:
            payload["warning"] = " · ".join(warn_bits)
        return payload
    finally:
        with _lock:
            if _pack_phase == "extensions":
                _pack_phase = ""


def extensions_public() -> dict[str, Any]:
    with _lock:
        if _extension_items:
            return _write_extensions_payload()
    disk = _read_json(PATHS.extensions, None)
    if isinstance(disk, dict) and (disk.get("items") is not None or disk.get("ok")):
        return disk
    pub = _read_json(EXTENSIONS_PUBLIC, None)
    if isinstance(pub, dict):
        return pub
    return {
        "ok": True,
        "connected": _connected,
        "lastUpdate": None,
        "items": [],
        "summary": extension_summary([]),
        "source": "avaya-ossi",
        "command": "list extension + list station + list uniform-dialplan",
    }


def _norm_ext_type(typ: str) -> str:
    t = str(typ or "").strip()
    if t in ("", "—", "-", "–"):
        return ""
    return t


def _ext_row_matches(row_ext: str, want: str) -> bool:
    if row_ext == want:
        return True
    if want.isdigit() and _EXT_RE.match(row_ext):
        m = re.match(r"^(\d+)([A-Za-z]?)$", row_ext)
        if m and m.group(1) == want:
            return True
    return False


def _lookup_extension_row(ext: str) -> dict[str, Any] | None:
    with _lock:
        items = list(_extension_items)
    for r in items:
        if isinstance(r, dict) and _ext_row_matches(str(r.get("extension") or "").strip(), ext):
            return r
    for src in (_read_json(PATHS.extensions, None), _read_json(EXTENSIONS_PUBLIC, None)):
        if not isinstance(src, dict):
            continue
        for r in src.get("items") or []:
            if isinstance(r, dict) and _ext_row_matches(str(r.get("extension") or "").strip(), ext):
                return r
    return None


def _extension_detail_command(ext: str, typ: str) -> str | None:
    """Pick one read-only display command from cached list-extension type."""
    t = _norm_ext_type(typ).lower()
    if not t:
        return None
    if (
        t in ("announcement", "qsig", "udp-ext", "data-extension")
        or "announcement" in t
        or "qsig" in t
        or "udp" in t
    ):
        return None
    if t in ("vdn-extension", "vdn") or t.startswith("vdn"):
        return f"display vdn {ext}"
    if t in ("hunt-group", "hunt") or "hunt" in t:
        return f"display hunt-group {ext}"
    if t in ("station-user", "phantom-user"):
        return f"display station {ext}"
    if any(
        k in t
        for k in ("station", "phantom", "analog", "dcp", "sip", "h.323", "h323", "endpoint")
    ):
        return f"display station {ext}"
    return None


def _opt_cache_field(row: dict[str, Any] | None, key: str) -> str | None:
    if not row:
        return None
    s = str(row.get(key) or "").strip()
    if not s or s in ("—", "-"):
        return None
    return s


def refresh_extension_detail(ext: str, type_hint: str | None = None) -> dict[str, Any]:
    """One OSSI `display station|vdn|hunt-group` for the Extension Details pane."""
    t0 = time.perf_counter()
    raw_ext = str(ext or "").strip()

    def _payload(**kw: Any) -> dict[str, Any]:
        out = {
            "ok": False,
            "extension": raw_ext,
            "type": "",
            "command": None,
            "formRows": [],
            "buttons": [],
            "port": None,
            "name": None,
            "setType": None,
            "error": None,
            "elapsedSec": round(time.perf_counter() - t0, 2),
            "fromCache": False,
            "cacheOnly": False,
        }
        out.update(kw)
        return out

    if not _EXT_RE.match(raw_ext):
        return _payload(error="invalid extension")

    row = _lookup_extension_row(raw_ext)
    cache_type = _norm_ext_type(str((row or {}).get("type") or ""))
    typ = _norm_ext_type(str(type_hint or "")) or cache_type
    cmd_ext = str((row or {}).get("extension") or raw_ext).strip()
    if not _EXT_RE.match(cmd_ext):
        cmd_ext = raw_ext

    cmd = _extension_detail_command(cmd_ext, typ)
    if cmd is None and not typ and row is not None:
        rt = cache_type.lower()
        if rt != "udp-ext" and "udp" not in rt:
            cmd = f"display station {cmd_ext}"

    if cmd is None:
        return _payload(
            ok=True,
            extension=cmd_ext,
            type=typ or cache_type,
            command=None,
            formRows=[],
            port=_opt_cache_field(row, "port"),
            name=_opt_cache_field(row, "name"),
            setType=None,
            error=None,
            cacheOnly=True,
            note="cache-only (no CM form for this type)",
        )

    with _lock:
        if not _connected or _session is None:
            return _payload(
                ok=False,
                extension=cmd_ext,
                type=typ or cache_type,
                command=cmd,
                error="Not connected",
            )
        sess = _session

    def _run_ro(command: str) -> tuple[str, str | None]:
        st = sess.run(
            command,
            max_more_pages=80,
            retry_on_error=False,
            more_idle=3.0,
        )
        raw = st.text or ""
        e: str | None = None
        if not getattr(st, "ok", True):
            e = getattr(st, "error", None)
        if "\nd" not in raw.replace("\r", "") and not (e or "").strip():
            time.sleep(0.35)
            st = sess.run(
                command,
                max_more_pages=80,
                retry_on_error=False,
                more_idle=3.0,
            )
            raw = st.text or ""
            if not getattr(st, "ok", True):
                e = getattr(st, "error", None)
        return raw, e

    text = ""
    err: str | None = None
    status_text = ""
    status_err: str | None = None
    with _ossi_lock:
        try:
            text, err = _run_ro(cmd)
        except Exception as exc:
            err = str(exc)
        try:
            kind = "station"
            cl = cmd.lower()
            if cl.startswith("display vdn"):
                kind = "vdn"
            elif cl.startswith("display hunt"):
                kind = "hunt"
            p = PATHS.data_dir / f"display_{kind}_{cmd_ext}_last.txt"
            PATHS.data_dir.mkdir(parents=True, exist_ok=True)
            p.write_text((text or "")[:80000], encoding="utf-8", errors="replace")
        except Exception:
            pass
        if cmd.lower().startswith("display station"):
            try:
                status_text, status_err = _run_ro(f"status station {cmd_ext}")
            except Exception as exc:
                status_err = str(exc)
            try:
                sp = PATHS.data_dir / f"status_station_{cmd_ext}_last.txt"
                PATHS.data_dir.mkdir(parents=True, exist_ok=True)
                sp.write_text((status_text or "")[:80000], encoding="utf-8", errors="replace")
            except Exception:
                pass
        time.sleep(0.15)

    if cmd.lower().startswith("display vdn"):
        parsed = parse_display_vdn(text, cmd_ext)
    elif cmd.lower().startswith("display hunt"):
        parsed = parse_display_hunt(text, cmd_ext)
    else:
        parsed = parse_display_station(text, cmd_ext)

    form_rows = list(parsed.get("formRows") or [])
    cmd_out = cmd
    if cmd.lower().startswith("display station"):
        st_parsed = parse_status_station(status_text, cmd_ext)
        form_rows.extend(st_parsed.get("formRows") or [])
        cmd_out = f"{cmd} + status station {cmd_ext}"
        if st_parsed.get("error") and not err:
            err = st_parsed.get("error")
        if status_err and not err:
            err = status_err

    parse_err = parsed.get("error")
    combined = parse_err or err
    useful = bool(form_rows or parsed.get("port") or parsed.get("name") or parsed.get("setType"))
    ok = useful if combined else True
    if combined and not useful:
        ok = False

    return _payload(
        ok=ok,
        extension=cmd_ext,
        type=typ or cache_type,
        command=cmd_out,
        formRows=form_rows,
        port=parsed.get("port"),
        name=parsed.get("name"),
        setType=parsed.get("setType"),
        buttons=parsed.get("buttons") or [],
        error=combined,
        cacheOnly=False,
    )


def alarms_public() -> dict[str, Any]:
    with _lock:
        if _alarm_active or _alarm_resolved:
            return _write_alarms_payload()
    # disk fallback
    disk = _read_json(PATHS.alarms, None)
    if isinstance(disk, dict) and disk.get("ok"):
        return disk
    pub = _read_json(ALARMS_PUBLIC, None)
    if isinstance(pub, dict):
        return pub
    return {
        "ok": True,
        "connected": _connected,
        "lastUpdate": None,
        "active": [],
        "resolved": [],
        "mtceTypes": [],
        "summary": _alarm_summary([]),
    }


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    server_version = "OssiBridge/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        # quiet — no request logging of credentials
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code: int, obj: Any) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any]:
        """Read JSON body. Supports Content-Length and chunked/no-length clients."""
        raw = b""
        try:
            length = self.headers.get("Content-Length")
            if length is not None and str(length).isdigit() and int(length) > 0:
                raw = self.rfile.read(int(length))
            else:
                # HttpClient may use chunked transfer without Content-Length
                te = (self.headers.get("Transfer-Encoding") or "").lower()
                if "chunked" in te:
                    while True:
                        line = self.rfile.readline()
                        if not line:
                            break
                        size_s = line.strip().split(b";")[0]
                        try:
                            size = int(size_s, 16)
                        except ValueError:
                            break
                        if size == 0:
                            self.rfile.readline()  # trailing CRLF
                            break
                        raw += self.rfile.read(size)
                        self.rfile.readline()  # chunk CRLF
                else:
                    # last resort: short non-blocking-ish read
                    self.connection.settimeout(0.5)
                    try:
                        while True:
                            chunk = self.rfile.read(65536)
                            if not chunk:
                                break
                            raw += chunk
                    except Exception:
                        pass
        except Exception:
            return {}
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.rstrip("/") or "/"
        try:
            if path == "/health":
                self._send(200, {"ok": True, "service": "ossi-bridge", "connected": _connected})
                return
            if path == "/session":
                with _lock:
                    self._send(200, {"ok": True, **session_public()})
                return
            if path == "/monitored":
                obj = save_monitored_items(load_monitored_items())
                self._send(200, {"ok": True, **obj})
                return
            if path in ("/trunk-data", "/trunk_data"):
                # Read-only cache — do NOT touch_ui (that was keeping OSSI "alive"
                # forever when the dashboard only polled trunk_data without Login).
                with _lock:
                    live = _connected
                    cm = _last_cm_time
                    sched = _schedule_public()
                data = _read_json(PATHS.trunk_data, {"items": [], "connected": False})
                if not isinstance(data, dict):
                    data = {"items": [], "connected": False}
                # Always override file cache with live session flag (stale connected:true was misleading UI)
                data["connected"] = live
                data.update(sched)
                if not live:
                    # keep last host/items for display, but never claim Monitoring from disk alone
                    data["connected"] = False
                # Expose System Time on trunk-data so UI can update without /api/cm-time route
                if cm and cm.get("systemTime"):
                    data["systemTime"] = cm.get("systemTime")
                    data["cmTime"] = cm
                # Piggyback alarms / gateways (old CmApi may lack those routes)
                try:
                    data["alarms"] = alarms_public()
                except Exception:
                    pass
                try:
                    data["gateways"] = gateways_public()
                except Exception:
                    pass
                try:
                    data["extensions"] = extensions_public()
                except Exception:
                    pass
                self._send(200, {"ok": True, "data": data})
                return
            if path in ("/extensions", "/extension", "/list-extension"):
                qs = urlparse(self.path).query or ""
                force = "force=1" in qs or "force=true" in qs.lower() or "refresh=1" in qs
                try:
                    if force:
                        touch_ui()
                        payload = refresh_extensions()
                    else:
                        if _connected:
                            touch_ui()
                        payload = extensions_public()
                    self._send(200, payload)
                except Exception as exc:
                    code = 401 if "Not connected" in str(exc) else 500
                    self._send(code, {"ok": False, "error": str(exc)})
                return
            if path in ("/gateways", "/gateway", "/media-gateways"):
                qs = urlparse(self.path).query or ""
                force = "force=1" in qs or "force=true" in qs.lower() or "refresh=1" in qs
                try:
                    if force:
                        touch_ui()
                        payload = refresh_gateways()
                    else:
                        if _connected:
                            touch_ui()
                        payload = gateways_public()
                    self._send(200, payload)
                except Exception as exc:
                    code = 401 if "Not connected" in str(exc) else 500
                    self._send(code, {"ok": False, "error": str(exc)})
                return
            # GET /gateways/51/config
            if path.startswith("/gateways/") and path.endswith("/config"):
                parts = path.strip("/").split("/")
                qs = urlparse(self.path).query or ""
                force = "force=1" in qs or "force=true" in qs.lower() or "refresh=1" in qs
                try:
                    mg = int(parts[1]) if len(parts) >= 3 else 0
                except ValueError:
                    mg = 0
                if mg < 1:
                    self._send(400, {"ok": False, "error": "invalid mg"})
                    return
                try:
                    if force:
                        touch_ui()
                        payload = refresh_gateway_config(mg)
                    else:
                        if _connected:
                            touch_ui()
                        payload = gateway_config_public(mg)
                    self._send(200, payload)
                except Exception as exc:
                    code = 401 if "Not connected" in str(exc) else 500
                    self._send(code, {"ok": False, "error": str(exc)})
                return
            if path in ("/alarms", "/alarm"):
                # Cached list (also written to site alarms_cache.json for static fallback)
                qs = urlparse(self.path).query or ""
                force = "force=1" in qs or "force=true" in qs.lower() or "refresh=1" in qs
                try:
                    if force:
                        touch_ui()
                        payload = refresh_alarms()
                    else:
                        if _connected:
                            touch_ui()
                        payload = alarms_public()
                    self._send(200, payload)
                except Exception as exc:
                    code = 401 if "Not connected" in str(exc) else 500
                    self._send(code, {"ok": False, "error": str(exc)})
                return
            if path in ("/cm-time", "/system-time", "/time"):
                # Only count as UI when a logged-in page asks; requires live session
                try:
                    qs = urlparse(self.path).query or ""
                    force = "force=1" in qs or "force=true" in qs.lower()
                    with _lock:
                        if not _connected:
                            self._send(401, {"ok": False, "error": "Not connected"})
                            return
                    touch_ui()
                    result = fetch_cm_time(force=force)
                    self._send(200, result)
                except Exception as exc:
                    code = 401 if "Not connected" in str(exc) else 500
                    self._send(code, {"ok": False, "error": str(exc)})
                return
            # GET /trunks/123/detail — prefer cache from 60s status trunk (+ channels)
            if path.startswith("/trunks/") and path.endswith("/detail"):
                parts = path.strip("/").split("/")
                if len(parts) == 3 and parts[0] == "trunks" and parts[2] == "detail":
                    try:
                        tg = int(parts[1])
                    except ValueError:
                        self._send(400, {"ok": False, "error": "invalid tg"})
                        return
                    qs = urlparse(self.path).query or ""
                    force = "force=1" in qs or "force=true" in qs.lower()
                    with _lock:
                        if not _connected or _session is None:
                            self._send(401, {"ok": False, "error": "Not connected"})
                            return
                        touch_ui()
                        mon = next((m for m in load_monitored_items() if m["tg"] == tg), {})
                        meta = dict(_tg_catalog.get(tg, {}))
                        sess = _session
                    # Cache hit: channels from last list poll (no extra OSSI)
                    if not force:
                        by = _load_trunk_items_map()
                        row = by.get(int(tg))
                        if row is not None and isinstance(row.get("channels"), list):
                            self._send(
                                200,
                                {
                                    "ok": not bool(row.get("error")),
                                    "tg": tg,
                                    "name": row.get("name") or meta.get("name") or f"TG {tg}",
                                    "note": mon.get("note", "") or row.get("note", ""),
                                    "type": row.get("type") or meta.get("type") or "",
                                    "tac": row.get("tac") or meta.get("tac") or "",
                                    "counts": {
                                        "total": row.get("total"),
                                        "idle": row.get("idle"),
                                        "busy": row.get("busy"),
                                        "oos": row.get("oos"),
                                    },
                                    "channels": row.get("channels") or [],
                                    "error": row.get("error"),
                                    "fromCache": True,
                                    "lastUpdate": row.get("lastUpdate"),
                                },
                            )
                            return
                    # force=1 or no cache yet → one OSSI status trunk (also updates cache)
                    try:
                        result = refresh_one_tg(tg)
                        row = result.get("item") or {}
                        self._send(
                            200,
                            {
                                "ok": result.get("ok", True),
                                "tg": tg,
                                "name": row.get("name") or meta.get("name") or f"TG {tg}",
                                "note": mon.get("note", "") or row.get("note", ""),
                                "type": row.get("type") or meta.get("type") or "",
                                "tac": row.get("tac") or meta.get("tac") or "",
                                "counts": {
                                    "total": row.get("total"),
                                    "idle": row.get("idle"),
                                    "busy": row.get("busy"),
                                    "oos": row.get("oos"),
                                },
                                "channels": row.get("channels") or [],
                                "error": row.get("error"),
                                "fromCache": False,
                                "lastUpdate": row.get("lastUpdate"),
                            },
                        )
                    except Exception as exc:
                        self._send(
                            401 if "Not connected" in str(exc) else 500,
                            {"ok": False, "error": str(exc)},
                        )
                    return
            self._send(404, {"ok": False, "error": "not found"})
        except Exception as exc:
            self._send(500, {"ok": False, "error": str(exc)})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.rstrip("/") or "/"
        body = self._read_json()
        try:
            if path == "/session/connect":
                with _lock:
                    result = connect_unlocked(body)
                # Do not poll trunks here — login UI runs each OSSI command
                # (status trunk / display alarms / list media-gateway) with a live bar.
                try:
                    by = _load_trunk_items_map()
                    result["trunkData"] = write_trunk_data(
                        list(by.values()), error=None, refreshing=False
                    )
                except Exception:
                    result["trunkData"] = None
                self._send(200, result)
                return
            if path == "/session/disconnect":
                with _lock:
                    disconnect_unlocked()
                    by = _load_trunk_items_map()
                    write_trunk_data(list(by.values()), error=None, refreshing=False)
                self._send(200, {"ok": True, "connected": False})
                return
            if path in ("/session/heartbeat", "/heartbeat"):
                # Stamp UI present + which tab is open.
                # NEVER run display time here — fetch_cm_time waits on _ossi_lock
                # and CmApi PostLightAsync times out at 8s, so the beat never
                # reaches this handler while a pack is running. Watchdog then
                # treats the UI as gone and logs off mid-use.
                global _ui_active_tab, _ui_open_mg, _ui_packing
                touch_ui()
                tab = str(body.get("tab") or body.get("Tab") or "").strip().lower()
                raw_mg = body.get("openMg")
                if raw_mg is None:
                    raw_mg = body.get("OpenMg")
                try:
                    mg_i = int(raw_mg) if raw_mg is not None and str(raw_mg).strip() != "" else 0
                except (TypeError, ValueError):
                    mg_i = 0
                raw_pack = body.get("packing")
                if raw_pack is None:
                    raw_pack = body.get("Packing")
                packing = _as_bool(raw_pack)
                with _lock:
                    if tab in (
                        "trunk",
                        "alarm",
                        "gateway",
                        "cdr",
                        "station",
                        "extension",
                        "map",
                        "vdn",
                    ):
                        _ui_active_tab = tab
                    _ui_open_mg = mg_i if mg_i >= 1 else 0
                    was_packing = _ui_packing
                    _ui_packing = packing
                    # While UI pack is in flight, skip auto. When it ends, if the
                    # deadline already passed, wait a full interval (no double pack).
                    if not packing and was_packing:
                        if _next_refresh_mono <= 0 or time.monotonic() >= _next_refresh_mono:
                            _arm_next_refresh(AUTO_REFRESH_SEC)
                    st = session_public()
                self._send(200, {"ok": True, **st})
                return
            if path == "/refresh":
                touch_ui()
                # Do not hold _lock for entire multi-TG poll
                data = refresh_unlocked()
                self._send(200, {"ok": True, "data": data})
                return
            if path in ("/alarms/refresh", "/alarms"):
                touch_ui()
                try:
                    payload = refresh_alarms()
                    self._send(200, payload)
                except Exception as exc:
                    self._send(
                        401 if "Not connected" in str(exc) else 500,
                        {"ok": False, "error": str(exc)},
                    )
                return
            if path in ("/gateways/refresh", "/gateway/refresh"):
                touch_ui()
                try:
                    payload = refresh_gateways()
                    self._send(200, payload)
                except Exception as exc:
                    self._send(
                        401 if "Not connected" in str(exc) else 500,
                        {"ok": False, "error": str(exc)},
                    )
                return
            if path in ("/gateways/config", "/gateway/config"):
                touch_ui()
                try:
                    mg = int(body.get("mg") or body.get("Mg") or 0)
                except (TypeError, ValueError):
                    mg = 0
                if mg < 1:
                    self._send(400, {"ok": False, "error": "mg required"})
                    return
                try:
                    payload = refresh_gateway_config(mg)
                    self._send(200, payload)
                except Exception as exc:
                    self._send(
                        401 if "Not connected" in str(exc) else 500,
                        {"ok": False, "error": str(exc)},
                    )
                return
            if path in ("/extensions/refresh", "/extension/refresh"):
                touch_ui()
                try:
                    payload = refresh_extensions()
                    self._send(200, payload)
                except Exception as ext_exc:
                    self._send(
                        401 if "Not connected" in str(ext_exc) else 500,
                        {"ok": False, "error": str(ext_exc)},
                    )
                return
            if path in ("/extensions/detail", "/extension/detail"):
                touch_ui()
                ext = str(
                    body.get("extension")
                    or body.get("Extension")
                    or body.get("ext")
                    or ""
                ).strip()
                raw_type = body.get("type")
                if raw_type is None:
                    raw_type = body.get("Type")
                type_hint = str(raw_type).strip() if raw_type is not None else ""
                try:
                    payload = refresh_extension_detail(
                        ext, type_hint=type_hint or None
                    )
                    self._send(200, payload)
                except Exception as exc:
                    self._send(
                        401 if "Not connected" in str(exc) else 500,
                        {"ok": False, "error": str(exc)},
                    )
                return
            if path in ("/refresh/one", "/refresh/tg"):
                touch_ui()
                tg = int(body.get("tg") or body.get("Tg") or 0)
                if tg < 1:
                    self._send(400, {"ok": False, "error": "tg required"})
                    return
                try:
                    result = refresh_one_tg(tg)
                    self._send(200, result)
                except Exception as exc:
                    self._send(401 if "Not connected" in str(exc) else 500, {"ok": False, "error": str(exc)})
                return
            if path == "/monitored/add":
                tg = int(body.get("tg") or body.get("Tg") or 0)
                note = str(body.get("note") or "")
                if tg < 1:
                    self._send(400, {"ok": False, "error": "tg required"})
                    return
                with _lock:
                    items = load_monitored_items()
                    if not any(i["tg"] == tg for i in items):
                        items.append({"tg": tg, "order": len(items), "note": note})
                    obj = save_monitored_items(items)
                self._send(200, {"ok": True, **obj})
                return
            if path == "/monitored/remove":
                tg = int(body.get("tg") or body.get("Tg") or 0)
                with _lock:
                    items = [i for i in load_monitored_items() if i["tg"] != tg]
                    obj = save_monitored_items(items)
                    by = _load_trunk_items_map()
                    if tg in by:
                        del by[tg]
                        write_trunk_data(list(by.values()), error=None)
                self._send(200, {"ok": True, **obj})
                return
            if path == "/monitored/note":
                tg = int(body.get("tg") or body.get("Tg") or 0)
                note = str(body.get("note") or body.get("Note") or "")[:200]
                with _lock:
                    items = load_monitored_items()
                    for it in items:
                        if it["tg"] == tg:
                            it["note"] = note
                            break
                    obj = save_monitored_items(items)
                self._send(200, {"ok": True, **obj})
                return
            self._send(404, {"ok": False, "error": "not found"})
        except Exception as exc:
            self._send(500, {"ok": False, "error": str(exc), "trace": traceback.format_exc()[-500:]})

    def do_PUT(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.rstrip("/") or "/"
        body = self._read_json()
        try:
            if path == "/monitored":
                with _lock:
                    if isinstance(body.get("items"), list):
                        obj = save_monitored_items(body["items"])
                    else:
                        trunks = body.get("trunks") or []
                        obj = save_monitored([int(x) for x in trunks])
                    if _connected and body.get("refresh", True):
                        # optional: skip heavy refresh when only reordering
                        if body.get("refresh") is not False:
                            pass
                        # only refresh status if explicitly requested
                        if body.get("refreshStatus"):
                            refresh_unlocked()
                self._send(200, {"ok": True, **obj})
                return
            self._send(404, {"ok": False, "error": "not found"})
        except Exception as exc:
            self._send(500, {"ok": False, "error": str(exc)})

class _ExclusiveHTTPServer(ThreadingHTTPServer):
    """Refuse SO_REUSEADDR multi-bind — second instance must fail to start."""

    allow_reuse_address = False


def _acquire_bridge_lock(port: int) -> Any:
    """One bridge per port — multiple instances desync the CM OSSI stream."""
    PATHS.data_dir.mkdir(parents=True, exist_ok=True)
    lock_path = PATHS.data_dir / f"ossi_bridge_{port}.lock"
    fh = open(lock_path, "a+b")
    try:
        if sys.platform == "win32":
            import msvcrt

            # msvcrt.locking needs existing bytes in file
            fh.seek(0, os.SEEK_END)
            if fh.tell() < 1:
                fh.write(b"\0")
                fh.flush()
            fh.seek(0)
            try:
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                fh.close()
                raise SystemExit(
                    f"OSSI bridge already running on port {port} "
                    f"(lock {lock_path}). Kill extra python ossi_service.py first."
                ) from exc
        else:
            import fcntl

            try:
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                fh.close()
                raise SystemExit(
                    f"OSSI bridge already running on port {port} (lock {lock_path})."
                ) from exc
        fh.seek(0)
        fh.truncate()
        fh.write(f"pid={os.getpid()}\nport={port}\n".encode("utf-8"))
        fh.flush()
        return fh
    except SystemExit:
        raise
    except Exception:
        try:
            fh.close()
        except Exception:
            pass
        raise


def _health_already_up(host: str, port: int) -> bool:
    """If another bridge already serves /health on this port, do not start a second."""
    import urllib.error
    import urllib.request

    probe = "127.0.0.1" if host in ("0.0.0.0", "::", "") else host
    url = f"http://{probe}:{port}/health"
    try:
        with urllib.request.urlopen(url, timeout=1.5) as resp:
            body = (resp.read() or b"").decode("utf-8", errors="replace")
            return resp.status == 200 and ("ossi-bridge" in body or '"ok"' in body)
    except Exception:
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description="OSSI bridge for CM NOC")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=18776)
    parser.add_argument("--data-dir", default=str(PATHS.data_dir))
    args = parser.parse_args()

    PATHS.data_dir = Path(args.data_dir)
    ensure_seed_files()

    # Soft single-instance: if health already answers, exit quietly (CmApi / bat / us)
    if _health_already_up(args.host, args.port):
        print(
            f"ossi-bridge already up on http://{args.host}:{args.port} — not starting second",
            flush=True,
        )
        return 0

    lock_fh = _acquire_bridge_lock(args.port)

    # Re-check after lock (race with another starter)
    if _health_already_up(args.host, args.port):
        try:
            lock_fh.close()
        except Exception:
            pass
        print(
            f"ossi-bridge already up on http://{args.host}:{args.port} — not starting second",
            flush=True,
        )
        return 0

    t = threading.Thread(target=_auto_loop, name="ossi-auto-refresh", daemon=True)
    t.start()

    try:
        httpd = _ExclusiveHTTPServer((args.host, args.port), Handler)
    except OSError as exc:
        try:
            lock_fh.close()
        except Exception:
            pass
        # Port in use by healthy peer → OK; otherwise hard fail
        if _health_already_up(args.host, args.port):
            print(
                f"ossi-bridge already bound {args.host}:{args.port} — exit",
                flush=True,
            )
            return 0
        raise SystemExit(f"Cannot bind {args.host}:{args.port}: {exc}") from exc
    print(
        f"ossi-bridge listening http://{args.host}:{args.port} data={PATHS.data_dir}",
        flush=True,
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        _stop.set()
        with _lock:
            disconnect_unlocked()
        httpd.server_close()
        try:
            lock_fh.close()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
