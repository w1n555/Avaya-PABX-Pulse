"""Parse Avaya CM OSSI `list extension` + `list station` + `list uniform-dialplan`.

`list extension` (2 d-lines per record + n):

  d700\\tVDN-extension\\t1\\t1
  dHotline-700\\t1
  n

`list station` (3 d-lines per record + n; tabs required):

  d20002\\t043V612\\t\\t\\t
  d1\\t\\tCallrID\\t\\tno
  d\\t\\t\\t4\\t1
  n
  d20014\\t043V314\\tChan Wing Kit\\t\\t
  ...

`list uniform-dialplan` (2 d-lines per record + n):

  d20002\\t5\\t0\\t\\text
  dn\\t
  n

line1: matchingPattern, Len, Del, InsertDigits, type.
"""

from __future__ import annotations

import re
from typing import Any

_EXT_RE = re.compile(r"^\d{2,13}[A-Za-z]?$")
# IP S00001 / media-gateway 043V612 / unassigned X / analog ANA00001
_PORT_RE = re.compile(
    r"^(?:"
    r"X|"
    r"S\d{3,8}|"
    r"\d{1,3}V\d{1,8}|"
    r"ANA\d+|"
    r"T\d+|"
    r"IP"
    r")$",
    re.I,
)

# display station FIDs from live CM 10.2 dumps (display_station_48902 / 29188)
# paired against SAT page 1. 0016 is Security Code — never map.
# Do NOT map display-time 0001/0002/0003.
_STATION_FID_MAP: dict[str, str] = {
    "8005ff00": "Extension",
    "8005": "Extension",
    "004fff00": "Set type",
    "004f": "Set type",
    "8004ff00": "Port",
    "8004": "Port",
    "8003ff00": "Name",
    "8003": "Name",
    "8001ff00": "COR",
    "8001": "COR",
    "8002ff00": "COS",
    "8002": "COS",
    "4a3bff00": "TN",
    "4a3b": "TN",
    "8007ff00": "Coverage Path 1",
    "8007": "Coverage Path 1",
    "ce2aff00": "Coverage Path 2",
    "ce2a": "Coverage Path 2",
}
_VDN_FID_MAP: dict[str, str] = {
    "8003ff00": "Name",
    "8003": "Name",
    "8005ff00": "Extension",
    "8005": "Extension",
}
_HUNT_FID_MAP: dict[str, str] = {
    "8003ff00": "Group name",
    "8003": "Group name",
    "8005ff00": "Group number",
    "8005": "Group number",
}

_STATION_FORM_LABELS: tuple[str, ...] = (
    "Set type",
    "Port",
    "Name",
    "COR",
    "COS",
    "TN",
    "Coverage Path",
    "Coverage Path 1",
    "Coverage Path 2",
    "Room",
)
_VDN_FORM_LABELS: tuple[str, ...] = (
    "Name",
    "Destination",
    "Vector",
    "COR",
    "TN",
    "Measured",
)
# status station (live CM 10.2): 22468 CF=000f 926787582; 25085 ECF 7539/753c/753e.
# Empty slots still returned as "—". No SAC.
_STATUS_STATION_FID_MAP: dict[str, str] = {
    "000fff00": "CF Destination",
    "000f": "CF Destination",
    "0026ff00": "User DND",
    "0026": "User DND",
    "7539ff00": "ECF Uncond Internal",
    "7539": "ECF Uncond Internal",
    "753aff00": "ECF Uncond External",
    "753a": "ECF Uncond External",
    "753bff00": "ECF Busy Internal",
    "753b": "ECF Busy Internal",
    "753cff00": "ECF Busy External",
    "753c": "ECF Busy External",
    "753dff00": "ECF No Reply Internal",
    "753d": "ECF No Reply Internal",
    "753eff00": "ECF No Reply External",
    "753e": "ECF No Reply External",
}
_STATUS_STATION_LABELS: tuple[str, ...] = (
    "User DND",
    "CF Destination",
    "ECF Uncond Internal",
    "ECF Uncond External",
    "ECF Busy Internal",
    "ECF Busy External",
    "ECF No Reply Internal",
    "ECF No Reply External",
)
_HUNT_FORM_LABELS: tuple[str, ...] = (
    "Group name",
    "Group number",
    "Group type",
    "Coverage Path",
    "COR",
    "TN",
    "Queue",
)

_SECRET_RE = re.compile(
    r"security|password|passwd|\bpin\b|pincode|auth(?:en)?|secret",
    re.I,
)

_SET_TYPE_CODES = frozenset(
    s.lower()
    for s in (
        "analog",
        "sip",
        "h.323",
        "h323",
        "callr",
        "callrid",
        "9641",
        "9641g",
        "9641gs",
        "9611",
        "9611g",
        "9608",
        "9608g",
        "9621",
        "9621g",
        "9630",
        "9630g",
        "9640",
        "9640g",
        "9650",
        "9650c",
        "9670",
        "9670g",
        "9601",
        "9404",
        "9408",
        "9504",
        "9508",
        "2420",
        "2410",
        "2402",
        "6408",
        "6408d",
        "6408d+",
        "6408+",
        "6416",
        "6416d+",
        "6424",
        "6424d+",
        "6402",
        "6402d",
        "j129",
        "j139",
        "j159",
        "j169",
        "j179",
        "j189",
        "j207",
        "j307",
        "4610",
        "4610sw",
        "4620",
        "4620sw",
        "4621",
        "4621sw",
        "4622",
        "4622sw",
        "4624",
        "4625",
        "4625sw",
        "4601",
        "4602",
        "4602sw",
        "4606",
        "4630",
        "4690",
        "1408",
        "1416",
        "1603",
        "1608",
        "1616",
        "8405d",
        "8410d",
        "8434d",
        "8411d",
        "2500",
        "8110",
        "6210",
        "6221",
    )
)
_SET_TYPE_RE = re.compile(r"^j\d{2,4}$", re.I)
_HUNT_TYPE_CODES = frozenset(
    {
        "ucd-mia",
        "ucd-loa",
        "ead-mia",
        "ead-loa",
        "ddc",
        "slm",
        "circ",
        "skill",
        "ucd",
        "ead",
        "cd-mia",
        "cd-loa",
    }
)
_MEASURED_CODES = frozenset({"internal", "external", "none", "both"})
_NAME_SKIP = frozenset(
    {
        "y",
        "n",
        "yes",
        "no",
        "on",
        "off",
        "internal",
        "external",
        "none",
        "both",
        "standard",
    }
)


def _norm_lines(text: str) -> list[str]:
    raw = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    raw = re.sub(r"more\?\s*\[y\]y?", "\n", raw, flags=re.I)
    return [ln.strip() for ln in raw.split("\n") if ln.strip()]


def _d_fields(line: str) -> list[str]:
    if not line.startswith("d"):
        return []
    return [(x or "").strip() for x in line[1:].split("\t")]


def parse_list_extension(text: str) -> list[dict[str, Any]]:
    """Return one row per extension from OSSI `list extension`."""
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    lines = _norm_lines(text)
    i = 0
    while i < len(lines):
        ln = lines[i]
        if ln == "n" or ln == "t" or ln.startswith("c") or ln.startswith("f"):
            i += 1
            continue
        f = _d_fields(ln)
        if not f:
            i += 1
            continue
        ext = f[0]
        if not _EXT_RE.match(ext):
            i += 1
            continue

        typ = (f[1] if len(f) > 1 else "") or "—"
        name = ""
        # Second d-line is name (optional empties)
        j = i + 1
        if j < len(lines):
            f2 = _d_fields(lines[j])
            if f2:
                # name is first field of second d-line (may be blank)
                name = f2[0] if f2[0] else ""
                # If second line looks like another extension header, do not consume
                if _EXT_RE.match(f2[0]) and len(f2) >= 2 and f2[1] and not f2[1].isdigit():
                    # e.g. next record started without name line
                    name = ""
                    j = i
                else:
                    pass  # consumed name line
            elif lines[j] == "n":
                j = i  # no name line
        if j > i:
            i = j + 1
        else:
            i += 1

        if ext in seen:
            continue
        seen.add(ext)
        rows.append(
            {
                "extension": ext,
                "type": typ,
                "port": "—",
                "name": name if name else "—",
                "room": "",
                "cor": "",
                "cos": "",
                "raw": "\t".join(f + ([name] if name else [])),
            }
        )

    def _ext_key(e: str) -> tuple:
        m = re.match(r"^(\d+)([A-Za-z]?)$", e)
        if m:
            return (int(m.group(1)), m.group(2) or "")
        return (0, e)

    rows.sort(key=lambda r: _ext_key(str(r.get("extension") or "")))
    return rows


def _is_port(value: str) -> bool:
    s = (value or "").strip()
    return bool(s) and bool(_PORT_RE.match(s))


def parse_list_station(text: str) -> dict[str, dict[str, str]]:
    """Map extension → {port, name, room} from OSSI `list station`."""
    by_ext: dict[str, dict[str, str]] = {}
    lines = _norm_lines(text)
    i = 0
    while i < len(lines):
        ln = lines[i]
        if ln == "n" or ln == "t" or ln.startswith("c") or ln.startswith("f"):
            i += 1
            continue
        f = _d_fields(ln)
        if not f:
            i += 1
            continue
        ext = (f[0] or "").strip()
        port = (f[1] if len(f) > 1 else "").strip()
        if not _EXT_RE.match(ext) or not _is_port(port):
            i += 1
            continue
        name = (f[2] if len(f) > 2 else "").strip()
        room = (f[3] if len(f) > 3 else "").strip()
        if ext not in by_ext:
            by_ext[ext] = {
                "extension": ext,
                "port": port,
                "name": name,
                "room": room,
            }
        # Skip the rest of this record (2 more d-lines + n) unless next header
        i += 1
        skipped = 0
        while i < len(lines) and skipped < 4:
            nxt = lines[i]
            f2 = _d_fields(nxt)
            if f2:
                ext2 = (f2[0] or "").strip()
                port2 = (f2[1] if len(f2) > 1 else "").strip()
                if _EXT_RE.match(ext2) and _is_port(port2):
                    break
            if nxt == "n":
                i += 1
                break
            if nxt == "t" or nxt.startswith("c"):
                break
            i += 1
            skipped += 1
    return by_ext


def merge_extension_ports(
    extensions: list[dict[str, Any]],
    station_by_ext: dict[str, dict[str, str]] | None,
    prev_items: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Overlay Port/Room from list station; keep last-good ports if station list is thin."""
    prev_ports: dict[str, str] = {}
    prev_rooms: dict[str, str] = {}
    for r in prev_items or []:
        e = str(r.get("extension") or "").strip()
        p = str(r.get("port") or "").strip()
        if e and p and p != "—":
            prev_ports[e] = p
        rm = str(r.get("room") or "").strip()
        if e and rm and rm != "—":
            prev_rooms[e] = rm

    use_station = dict(station_by_ext or {})
    if prev_ports and len(use_station) < max(50, int(len(prev_ports) * 0.5)):
        use_station = {}

    out: list[dict[str, Any]] = []
    for r in extensions:
        row = dict(r)
        ext = str(row.get("extension") or "").strip()
        st = use_station.get(ext) or {}
        port = str(st.get("port") or "").strip()
        room = str(st.get("room") or "").strip()
        if not port:
            port = prev_ports.get(ext, "")
        if not room:
            room = prev_rooms.get(ext, "")
        row["port"] = port if port else "—"
        if room:
            row["room"] = room
        out.append(row)
    return out


_UDP_TYPES = frozenset({"ext", "aar", "ars"})


def _ext_sort_key(e: str) -> tuple:
    m = re.match(r"^(\d+)([A-Za-z]?)$", e)
    if m:
        return (int(m.group(1)), m.group(2) or "")
    return (0, e)


def _is_udp_header(f: list[str]) -> bool:
    if len(f) < 5:
        return False
    if not (f[0] or "").strip():
        return False
    if (f[4] or "").strip().lower() not in _UDP_TYPES:
        return False
    try:
        int((f[1] or "").strip())
    except (TypeError, ValueError):
        return False
    return True


def looks_like_list_station_dump(text: str) -> bool:
    """True when a supposed UDP dump is leftover list-station pages."""
    raw = text or ""
    low = raw.lower()
    if "callrid" in low.replace(" ", ""):
        return True
    if re.search(r"\b\d{1,3}V\d{2,}\b", raw) and "uniform-dialplan" not in low.replace(" ", "").replace("-", ""):
        return True
    return False


def udp_list_ok(text: str, rows: list[dict[str, Any]] | None) -> bool:
    """Accept list uniform-dialplan only with command echo and real UDP rows."""
    raw = text or ""
    low = raw.lower()
    ns = low.replace(" ", "")
    cmd_ok = "clistuniform-dialplan" in ns or "uniform-dialplan" in low or "uniformdialplan" in ns
    if looks_like_list_station_dump(raw) and not cmd_ok:
        return False
    if looks_like_list_station_dump(raw) and len(rows or []) < 20:
        return False
    if not cmd_ok and len(rows or []) < 20:
        return False
    return len(rows or []) >= 20


def parse_list_uniform_dialplan(text: str) -> list[dict[str, Any]]:
    """Return every UDP row (ext/aar/ars). Caller filters exact-length ext."""
    rows: list[dict[str, Any]] = []
    lines = _norm_lines(text)
    i = 0
    while i < len(lines):
        ln = lines[i]
        if ln == "n" or ln == "t" or ln.startswith("c") or ln.startswith("f"):
            i += 1
            continue
        f = _d_fields(ln)
        if not _is_udp_header(f):
            i += 1
            continue
        rows.append(
            {
                "pattern": (f[0] or "").strip(),
                "len": (f[1] or "").strip(),
                "del": (f[2] or "").strip(),
                "insertDigits": (f[3] or "").strip(),
                "type": (f[4] or "").strip(),
            }
        )
        j = i + 1
        if j < len(lines):
            f2 = _d_fields(lines[j])
            if f2 and _is_udp_header(f2):
                i += 1
                continue
            if lines[j] == "n" or lines[j] == "t" or lines[j].startswith("c"):
                i += 1
                continue
            i = j + 1
            continue
        i += 1
    return rows


_UDP_TYPE_RANK = {"ext": 0, "aar": 1, "ars": 2}


def _udp_exact_by_pattern(udp_rows: list[dict[str, Any]] | None) -> dict[str, dict[str, Any]]:
    """Exact UDP rows (ext/aar/ars AND len(pattern)==Len). Prefixes skipped.

    Same pattern may appear as ext and ars; ARS Insert Digits win (飛線).
    """
    by: dict[str, dict[str, Any]] = {}
    for r in udp_rows or []:
        typ = str(r.get("type") or "").strip().lower()
        if typ not in _UDP_TYPES:
            continue
        pat = str(r.get("pattern") or "").strip()
        try:
            ln = int(str(r.get("len") or "").strip())
        except (TypeError, ValueError):
            continue
        if not pat or len(pat) != ln:
            continue
        ins = str(r.get("insertDigits") or "").strip()
        cur = by.get(pat)
        if cur is None:
            by[pat] = {
                "pattern": pat,
                "insertDigits": ins,
                "udpType": typ,
                "udpTypes": [typ],
            }
            continue
        types = list(cur.get("udpTypes") or [])
        if typ not in types:
            types.append(typ)
            cur["udpTypes"] = types
        if ins and (not cur.get("insertDigits") or typ == "ars"):
            cur["insertDigits"] = ins
        if _UDP_TYPE_RANK.get(typ, -1) > _UDP_TYPE_RANK.get(str(cur.get("udpType") or ""), -1):
            cur["udpType"] = typ
    return by


def _udp_exact_ext_rows(udp_rows: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """type=ext AND len(pattern)==Len. Do not expand prefixes."""
    return [r for r in _udp_exact_by_pattern(udp_rows).values() if r.get("udpType") == "ext" or "ext" in (r.get("udpTypes") or [])]


def _is_udp_only_type(typ: str) -> bool:
    t = str(typ or "").strip().lower()
    return t.startswith("udp-")


def _prev_udp_exact_count(prev_items: list[dict[str, Any]] | None) -> int:
    n = 0
    for r in prev_items or []:
        if r.get("inUdp") or _is_udp_only_type(str(r.get("type") or "")):
            n += 1
    return n


def merge_udp_into_extensions(
    items: list[dict[str, Any]] | None,
    udp_rows: list[dict[str, Any]] | None,
    prev_items: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Join exact UDP ext/aar/ars onto port-merged list-extension items.

    Exact = type ext|aar|ars and len(pattern)==Len. Prefixes (e.g. 572 Len=7) skipped.
    Insert Digits come from UDP (ARS 飛線 wins if both). UDP-only rows are
    type udp-ext / udp-aar / udp-ars (not clickable). Failed UDP keeps previous.
    """
    prev_items = prev_items or []
    prev_by_ext: dict[str, dict[str, Any]] = {}
    for r in prev_items:
        e = str(r.get("extension") or "").strip()
        if e and e not in prev_by_ext:
            prev_by_ext[e] = r

    by_pat = _udp_exact_by_pattern(udp_rows) if udp_rows is not None else {}
    new_exact_n = len(by_pat)
    prev_udp_n = _prev_udp_exact_count(prev_items)
    skip_apply = udp_rows is None or new_exact_n == 0
    if not skip_apply and prev_udp_n >= 50 and new_exact_n < prev_udp_n * 0.5:
        skip_apply = True

    if skip_apply:
        out: list[dict[str, Any]] = []
        seen: set[str] = set()
        for r in items or []:
            row = dict(r)
            ext = str(row.get("extension") or "").strip()
            prev = prev_by_ext.get(ext) or {}
            if "insertDigits" in prev:
                row["insertDigits"] = str(prev.get("insertDigits") or "")
            else:
                row["insertDigits"] = str(row.get("insertDigits") or "")
            if "inUdp" in prev:
                row["inUdp"] = bool(prev.get("inUdp"))
            elif "inUdp" not in row:
                row["inUdp"] = False
            if prev.get("udpType") and not row.get("udpType"):
                row["udpType"] = prev.get("udpType")
            if ext:
                seen.add(ext)
            out.append(row)
        for r in prev_items:
            if not _is_udp_only_type(str(r.get("type") or "")):
                continue
            ext = str(r.get("extension") or "").strip()
            if not ext or ext in seen:
                continue
            out.append(dict(r))
            seen.add(ext)
        out.sort(key=lambda r: _ext_sort_key(str(r.get("extension") or "")))
        return out

    out = []
    seen = set()
    for r in items or []:
        if _is_udp_only_type(str(r.get("type") or "")):
            continue
        row = dict(r)
        ext = str(row.get("extension") or "").strip()
        hit = by_pat.get(ext)
        if hit:
            row["insertDigits"] = str(hit.get("insertDigits") or "")
            row["inUdp"] = True
            row["udpType"] = str(hit.get("udpType") or "")
        else:
            row["insertDigits"] = ""
            row["inUdp"] = False
            row.pop("udpType", None)
        if ext:
            seen.add(ext)
        out.append(row)
    for pat, hit in by_pat.items():
        if pat in seen:
            continue
        ut = str(hit.get("udpType") or "ext")
        out.append(
            {
                "extension": pat,
                "type": f"udp-{ut}",
                "port": "—",
                "name": "—",
                "insertDigits": str(hit.get("insertDigits") or ""),
                "source": "udp",
                "inUdp": True,
                "udpType": ut,
                "room": "",
            }
        )
        seen.add(pat)
    out.sort(key=lambda r: _ext_sort_key(str(r.get("extension") or "")))
    return out


def extension_summary(items: list[dict[str, Any]] | None) -> dict[str, Any]:
    items = items or []
    by_type: dict[str, int] = {}
    port_n = 0
    udp_only = 0
    in_udp = 0
    matched_list_ext = 0
    udp_ext_n = 0
    udp_ars = 0
    udp_aar = 0
    for r in items:
        t = str(r.get("type") or "—").strip() or "—"
        by_type[t] = by_type.get(t, 0) + 1
        p = str(r.get("port") or "").strip()
        if p and p != "—":
            port_n += 1
        ut = str(r.get("udpType") or "").strip().lower()
        if _is_udp_only_type(t):
            udp_only += 1
        if r.get("inUdp"):
            in_udp += 1
        if ut == "ars" or t == "udp-ars":
            udp_ars += 1
        if ut == "aar" or t == "udp-aar":
            udp_aar += 1
        if ut == "ext" or t == "udp-ext":
            udp_ext_n += 1
            if t != "udp-ext" and not _is_udp_only_type(t):
                matched_list_ext += 1
    types = sorted(by_type.keys(), key=lambda x: (-by_type[x], x.lower()))
    coverage = (
        round(100.0 * matched_list_ext / max(1, udp_ext_n), 1) if udp_ext_n else None
    )
    return {
        "total": len(items),
        "typeCount": len(by_type),
        "byType": by_type,
        "types": types,
        "portCount": port_n,
        "udpOnly": udp_only,
        "inUdp": in_udp,
        "udpArs": udp_ars,
        "udpAar": udp_aar,
        "coveragePct": coverage,
    }


def pair_ossi_fields(text: str) -> list[tuple[str, str]]:
    """Pair each `f` FID line with the following `d` value line (tab-separated).

    Multiple leading `f` lines queue against subsequent `d` lines (list-style).
    `more?[y]` is stripped. `c` / `n` / `t` / `e` are ignored for pairing.
    """
    pairs: list[tuple[str, str]] = []
    pending: list[list[str]] = []
    for ln in _norm_lines(text):
        if ln.startswith("f"):
            pending.append([(x or "").strip() for x in ln[1:].split("\t")])
            continue
        if ln.startswith("d") and not ln.lower().startswith("display"):
            vals = [(x or "").strip() for x in ln[1:].split("\t")]
            fids = pending.pop(0) if pending else []
            n = max(len(fids), len(vals))
            for i in range(n):
                fid = fids[i] if i < len(fids) else ""
                val = vals[i] if i < len(vals) else ""
                if fid or val:
                    pairs.append((fid, val))
            continue
    return pairs


def _looks_secret(fid: str, label: str) -> bool:
    blob = f"{fid or ''} {label or ''}"
    return bool(_SECRET_RE.search(blob))


def _fid_lookup(fid: str, table: dict[str, str]) -> str | None:
    s = re.sub(r"[^0-9a-fA-F]", "", fid or "").lower()
    if not s:
        return None
    if s in table:
        return table[s]
    if len(s) >= 4 and s[:4] in table:
        return table[s[:4]]
    return None


def _ossi_e_error(text: str) -> str | None:
    msgs: list[str] = []
    seen: set[str] = set()
    for ln in _norm_lines(text):
        if not re.match(r"^e\d+\s", ln):
            continue
        m = re.match(r"^e\d+\s+\S+\s+(.*)$", ln)
        msg = (m.group(1) if m else ln[1:]).strip()
        if msg and msg not in seen:
            seen.add(msg)
            msgs.append(msg)
    return "; ".join(msgs) if msgs else None


def _is_set_type(value: str) -> bool:
    s = (value or "").strip()
    if not s:
        return False
    low = s.lower()
    return low in _SET_TYPE_CODES or bool(_SET_TYPE_RE.match(s))


def _is_hunt_type(value: str) -> bool:
    return (value or "").strip().lower() in _HUNT_TYPE_CODES


def _is_measured(value: str) -> bool:
    return (value or "").strip().lower() in _MEASURED_CODES


def _is_yn_skip(value: str) -> bool:
    return (value or "").strip().lower() in _NAME_SKIP


def _form_rows(found: dict[str, str], labels: tuple[str, ...]) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for lab in labels:
        val = (found.get(lab) or "").strip()
        if not val:
            continue
        if _looks_secret("", lab):
            continue
        rows.append({"label": lab, "value": val})
    return rows


def _apply_fid_pairs(
    pairs: list[tuple[str, str]],
    fid_map: dict[str, str],
    whitelist: tuple[str, ...],
) -> tuple[dict[str, str], list[tuple[str, str]]]:
    """Map known FIDs onto whitelist labels. Return (found, leftover pairs)."""
    found: dict[str, str] = {}
    leftover: list[tuple[str, str]] = []
    allow = set(whitelist)
    for fid, val in pairs:
        val = (val or "").strip()
        if not val:
            continue
        if _looks_secret(fid, ""):
            continue
        label = _fid_lookup(fid, fid_map)
        if not label or _looks_secret(fid, label):
            leftover.append((fid, val))
            continue
        if label == "Extension":
            leftover.append((fid, val))
            continue
        if label not in allow:
            leftover.append((fid, val))
            continue
        if label not in found:
            found[label] = val
    return found, leftover


def _name_from_values(values: list[str], ext: str, skip: set[str]) -> str | None:
    best = ""
    for v in values:
        s = (v or "").strip()
        if not s or s in skip:
            continue
        if s == ext or _is_port(s) or _is_set_type(s) or _is_yn_skip(s):
            continue
        if _is_hunt_type(s) or _is_measured(s):
            continue
        if not re.search(r"[A-Za-z]", s):
            continue
        if _looks_secret(s, s):
            continue
        if len(s) > len(best):
            best = s
    return best or None


def parse_status_station(text: str, ext: str) -> dict[str, Any]:
    """Whitelist live status-station rows; empty slots still emitted as —."""
    ext = str(ext or "").strip()
    err = _ossi_e_error(text)
    pairs = pair_ossi_fields(text)
    found: dict[str, str] = {}
    for fid, val in pairs:
        if _looks_secret(fid, ""):
            continue
        lab = _fid_lookup(fid, _STATUS_STATION_FID_MAP)
        if not lab or _looks_secret(fid, lab):
            continue
        v = (val or "").strip()
        if lab not in found:
            found[lab] = v
    rows: list[dict[str, str]] = []
    for lab in _STATUS_STATION_LABELS:
        v = (found.get(lab) or "").strip()
        if not v or v in ("-", "—"):
            v = "—"
        rows.append({"label": lab, "value": v})
    return {"formRows": rows, "error": err, "extension": ext}


def parse_display_station(text: str, ext: str) -> dict[str, Any]:
    """Whitelist rows from OSSI `display station` (never Security Code / PIN)."""
    ext = str(ext or "").strip()
    err = _ossi_e_error(text)
    pairs = pair_ossi_fields(text)
    found, leftover = _apply_fid_pairs(pairs, _STATION_FID_MAP, _STATION_FORM_LABELS)
    skip = set(found.values())
    skip.add(ext)
    leftovers = [v for _f, v in leftover if v and v not in skip]
    all_vals = [v for _f, v in pairs if (v or "").strip()]

    if not found.get("Port"):
        for v in leftovers + all_vals:
            if _is_port(v):
                found["Port"] = v
                skip.add(v)
                break
    if not found.get("Set type"):
        for v in leftovers + all_vals:
            if v != ext and _is_set_type(v):
                found["Set type"] = v
                skip.add(v)
                break
    # Name: only FID 8003. Do not guess from leftover (picks "as-needed" etc).

    buttons: list[dict[str, Any]] = []
    if not _is_analog_set(found.get("Set type") or ""):
        buttons = parse_station_buttons(pairs)

    return {
        "formRows": _form_rows(found, _STATION_FORM_LABELS),
        "port": found.get("Port") or None,
        "name": found.get("Name") or None,
        "setType": found.get("Set type") or None,
        "buttons": buttons,
        "error": err,
    }


def _is_analog_set(typ: str) -> bool:
    t = str(typ or "").strip().lower()
    if not t:
        return False
    if t in ("analog", "callrid", "callr", "2500", "8110") or t.startswith("ana"):
        return True
    return False


def parse_station_buttons(pairs: list[tuple[str, str]]) -> list[dict[str, Any]]:
    """display-station 801f01xx type / 02 list / 03 digits. Digital physical keys 1–24 only."""
    by: dict[int, dict[str, str]] = {}
    for fid, val in pairs:
        s = re.sub(r"[^0-9a-fA-F]", "", fid or "").lower()
        m = re.match(r"^801f(01|02|03)([0-9a-f]{2})$", s)
        if not m:
            continue
        kind, hx = m.group(1), m.group(2)
        n = int(hx, 16)
        if n < 1 or n > 24:
            continue
        slot = by.setdefault(n, {"type": "", "lst": "", "digits": ""})
        v = (val or "").strip()
        if kind == "01":
            slot["type"] = v
        elif kind == "02":
            slot["lst"] = v
        elif kind == "03":
            slot["digits"] = v
    rows: list[dict[str, Any]] = []
    for n in range(1, 25):
        s = by.get(n) or {}
        typ = (s.get("type") or "").strip()
        extra = " ".join(x for x in ((s.get("lst") or "").strip(), (s.get("digits") or "").strip()) if x)
        if typ and extra:
            label = f"{typ} {extra}"
        elif typ:
            label = typ
        else:
            label = "—"
        rows.append({"n": n, "type": typ, "extra": extra, "label": label})
    return rows


def parse_display_vdn(text: str, ext: str) -> dict[str, Any]:
    """Whitelist rows from OSSI `display vdn`."""
    ext = str(ext or "").strip()
    err = _ossi_e_error(text)
    pairs = pair_ossi_fields(text)
    found, leftover = _apply_fid_pairs(pairs, _VDN_FID_MAP, _VDN_FORM_LABELS)
    skip = set(found.values())
    skip.add(ext)
    leftovers = [v for _f, v in leftover if v and v not in skip]
    all_vals = [v for _f, v in pairs if (v or "").strip()]

    if not found.get("Name"):
        name = _name_from_values(leftovers + all_vals, ext, skip)
        if name:
            found["Name"] = name
            skip.add(name)
    if not found.get("Destination"):
        for v in leftovers + all_vals:
            if v != ext and _EXT_RE.match(v):
                found["Destination"] = v
                skip.add(v)
                break
    if not found.get("Measured"):
        for v in leftovers + all_vals:
            if _is_measured(v):
                found["Measured"] = v
                break

    return {
        "formRows": _form_rows(found, _VDN_FORM_LABELS),
        "port": None,
        "name": found.get("Name") or None,
        "setType": None,
        "error": err,
    }


def parse_display_hunt(text: str, ext: str) -> dict[str, Any]:
    """Whitelist rows from OSSI `display hunt-group`."""
    ext = str(ext or "").strip()
    err = _ossi_e_error(text)
    pairs = pair_ossi_fields(text)
    found, leftover = _apply_fid_pairs(pairs, _HUNT_FID_MAP, _HUNT_FORM_LABELS)
    skip = set(found.values())
    skip.add(ext)
    leftovers = [v for _f, v in leftover if v and v not in skip]
    all_vals = [v for _f, v in pairs if (v or "").strip()]

    if not found.get("Group name"):
        name = _name_from_values(leftovers + all_vals, ext, skip)
        if name:
            found["Group name"] = name
            skip.add(name)
    if not found.get("Group number"):
        for v in leftovers + all_vals:
            if v == ext or (ext.isdigit() and v.lstrip("0") == ext.lstrip("0") and v.isdigit()):
                found["Group number"] = v
                skip.add(v)
                break
    if not found.get("Group type"):
        for v in leftovers + all_vals:
            if _is_hunt_type(v):
                found["Group type"] = v
                skip.add(v)
                break

    return {
        "formRows": _form_rows(found, _HUNT_FORM_LABELS),
        "port": None,
        "name": found.get("Group name") or None,
        "setType": found.get("Group type") or None,
        "error": err,
    }
