"""Parse OSSI text for trunk inventory / channel status (read-only)."""

from __future__ import annotations

import re
from typing import Any


def _lines(text: str) -> list[str]:
    return [ln.strip() for ln in text.replace("\r", "").split("\n") if ln.strip()]


def _data_rows(text: str) -> list[str]:
    """Return OSSI d-line payloads (without leading d)."""
    rows: list[str] = []
    for ln in _lines(text):
        if ln.startswith("d") and len(ln) > 1:
            # skip lone d
            payload = ln[1:]
            if payload:
                rows.append(payload)
    return rows


def parse_trunk_groups(ossi_text: str) -> dict[int, dict[str, Any]]:
    """
    Parse `list trunk-group` OSSI dump → {tg: {name, tac, type, total}}.

    Typical d-lines (tab-separated-ish):
      1\\t1401\\tisdn\\tOUTSIDE CALL\\t23
    """
    out: dict[int, dict[str, Any]] = {}
    for payload in _data_rows(ossi_text):
        # Normalize tabs / multi-space
        parts = re.split(r"[\t]+", payload)
        if len(parts) < 2:
            parts = re.split(r"\s{2,}", payload.strip())
        if len(parts) < 2:
            # single-space fallback: first token digits
            m = re.match(
                r"^(\d{1,4})\s+(\S+)?\s*(isdn|sip|wats|co|tie|pri|fxo|fxs|h\.323)?\s*(.+?)\s+(\d{1,3})\s*$",
                payload,
                re.I,
            )
            if not m:
                continue
            tg = int(m.group(1))
            out[tg] = {
                "tg": tg,
                "tac": (m.group(2) or "").strip(),
                "type": (m.group(3) or "").strip(),
                "name": (m.group(4) or "").strip()[:48],
                "total": int(m.group(5)),
            }
            continue

        # Prefer first field int as TG
        try:
            tg = int(parts[0].strip())
        except ValueError:
            continue
        if tg < 1 or tg > 9999:
            continue

        tac = parts[1].strip() if len(parts) > 1 else ""
        typ = ""
        name = ""
        total = 0
        # Typical: tg, TAC, type, name, members (tabs). Type may be isdn-pri / sip-did / …
        if len(parts) >= 3:
            p2 = parts[2].strip()
            if p2 and not p2.isdigit():
                typ = p2
        if len(parts) >= 4:
            last = parts[-1].strip()
            if last.isdigit():
                total = int(last)
                name = " ".join(p.strip() for p in parts[3:-1] if p.strip())
            else:
                name = " ".join(p.strip() for p in parts[3:] if p.strip())
        rest = [p.strip() for p in parts[2:] if p.strip()]
        type_re = re.compile(
            r"^(isdn|sip|wats|co|tie|pri|fxo|fxs|h\.323|atm|isdn-pri|sip-did|qsig|dcp|ip)$",
            re.I,
        )
        if not typ:
            for i, tok in enumerate(rest):
                if type_re.match(tok):
                    typ = tok
                    name_parts = []
                    for j in range(i + 1, len(rest)):
                        if rest[j].isdigit() and j == len(rest) - 1:
                            total = int(rest[j])
                        elif rest[j].isdigit() and j >= len(rest) - 2:
                            try:
                                total = int(rest[-1])
                            except ValueError:
                                pass
                        else:
                            if not rest[j].isdigit():
                                name_parts.append(rest[j])
                    if not name:
                        name = " ".join(name_parts).strip()
                    if total == 0:
                        for tok2 in reversed(rest):
                            if tok2.isdigit():
                                total = int(tok2)
                                break
                    break
        if not typ and rest:
            joined = " ".join(parts)
            m2 = re.search(
                r"(\d{1,4})\s+(\d{3,5})\s+(isdn|sip|wats)\s+(.+?)\s+(\d{1,3})\b",
                joined,
                re.I,
            )
            if m2:
                tg = int(m2.group(1))
                tac, typ, name, total = (
                    m2.group(2),
                    m2.group(3),
                    m2.group(4).strip(),
                    int(m2.group(5)),
                )

        if tg not in out:
            out[tg] = {
                "tg": tg,
                "tac": tac,
                "type": typ,
                "name": name[:48] if name else f"TG {tg}",
                "total": total,
            }
    return out


_IDLE = re.compile(r"idle|in-service/idle", re.I)
_BUSY = re.compile(
    r"active|in-use|busy|seized|connected|talking|in-service/active", re.I
)
_OOS = re.compile(
    r"oos|out-of-service|out of service|disabled|down|unavailable|far-end", re.I
)


def parse_channel_counts(ossi_text: str) -> dict[str, int]:
    """
    Parse `status trunk N` OSSI → idle / busy / oos / total counts.
    """
    idle = busy = oos = other = 0
    seen = 0
    for payload in _data_rows(ossi_text):
        # Member lines usually contain ####/####
        if not re.search(r"\d{4}/\d{4}", payload):
            # sometimes glued without tab: 0001/0001001V101 in-service/idle
            if not re.search(r"\d{4}/\d{4}", payload.replace(" ", "")):
                continue
        seen += 1
        low = payload.lower()
        if _OOS.search(low) and not _BUSY.search(low):
            oos += 1
        elif _IDLE.search(low):
            idle += 1
        elif _BUSY.search(low):
            busy += 1
        else:
            # unknown service state
            if "in-service" in low:
                idle += 1
            else:
                other += 1
                oos += 1  # treat unknown non-inservice as oos-ish

    total = idle + busy + oos
    if total == 0 and seen == 0:
        # fallback: count any d-line with slash member pattern in full text
        for ln in _lines(ossi_text):
            if re.search(r"\d{4}/\d{4}", ln):
                total += 1
                if _IDLE.search(ln):
                    idle += 1
                elif _BUSY.search(ln):
                    busy += 1
                else:
                    oos += 1
        total = idle + busy + oos

    return {
        "total": total,
        "idle": idle,
        "busy": busy,
        "oos": oos,
    }


def utilization_pct(busy: int, total: int) -> float:
    if total <= 0:
        return 0.0
    return round(100.0 * busy / total, 1)


def status_color(idle: int, util: float) -> str:
    """green / yellow / red per product rules."""
    if idle == 0 or util > 90:
        return "red"
    if util >= 70:
        return "yellow"
    return "green"


def parse_channels(ossi_text: str) -> list[dict[str, str]]:
    """
    Parse `status trunk N` into channel rows.
    Connected field is port/raw only (no station reverse-lookup).
    """
    rows: list[dict[str, str]] = []
    # Example: 0001/0008 001V108 in-service/active no 002V201
    # or tab-separated OSSI d-lines
    pat = re.compile(
        r"(?P<mem>\d{4}/\d{4})\s*"
        r"(?P<port>\d{3}V\d+|\S+?)?\s+"
        r"(?P<state>in-service/\S+|OOS/\S+|\S+)\s+"
        r"(?P<busy>yes|no)\s*"
        r"(?P<conn>\S.*)?$",
        re.I,
    )
    for payload in _data_rows(ossi_text):
        line = payload.strip()
        if not re.search(r"\d{4}/\d{4}", line):
            continue
        # normalize tabs
        line_n = re.sub(r"[\t]+", " ", line)
        m = pat.search(line_n)
        if not m:
            m2 = re.match(
                r"^(?P<mem>\d{4}/\d{4})(?P<port>\d{3}V\d+)?\s+(?P<state>\S+)\s+(?P<busy>yes|no)\s*(?P<conn>.*)$",
                line_n,
                re.I,
            )
            if not m2:
                continue
            m = m2
        conn = (m.groupdict().get("conn") or "").strip()
        # strip trailing noise
        if conn.lower() in ("", "no", "yes"):
            conn = "" if conn.lower() in ("no", "yes", "") else conn
        rows.append(
            {
                "member": m.group("mem"),
                "port": (m.group("port") or "").strip(),
                "state": m.group("state").strip(),
                "busy": m.group("busy").strip().lower(),
                "connected": conn,  # port/raw only
            }
        )
    return rows
