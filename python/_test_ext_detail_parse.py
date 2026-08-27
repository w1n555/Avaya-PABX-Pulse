#!/usr/bin/env python3
"""Synthetic OSSI tests for extension detail pairing/parse (no CM / no bridge)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from extension_parse import (  # noqa: E402
    pair_ossi_fields,
    parse_display_hunt,
    parse_display_station,
    parse_display_vdn,
    parse_status_station,
)

SAMPLE = """cdisplay station 20002
f8005ff00	0002ff00	0003ff00	8003ff00
d20002	9641	043V612	Chan Wing Kit
f0004ff00
d1
t
"""

SAMPLE_MORE_AND_T = """cdisplay station 20002
f8005ff00	0002ff00	0003ff00	8003ff00
more?[y]
d20002	9641	043V612	Chan Wing Kit
t
f0004ff00
d1
t
"""

SAMPLE_SECRET = """cdisplay station 20002
f8005ff00	0002ff00	0003ff00	8003ff00	00security	password00
d20002	9641	043V612	Chan Wing Kit	9999	1234
f0004ff00
d1
t
"""

SAMPLE_VDN = """cdisplay vdn 700
f8005ff00	8003ff00
d700	Hotline-700
fxx01ff00
d15000
fmeasff00
dinternal
t
"""

SAMPLE_HUNT = """cdisplay hunt-group 1
f8005ff00	8003ff00	0002ff00
d1	Ops Hunt	ucd-mia
t
"""


def _assert(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> int:
    pairs = pair_ossi_fields(SAMPLE)
    _assert(len(pairs) == 5, f"pair_ossi_fields length {len(pairs)} != 5: {pairs}")
    by_fid = {f.lower(): v for f, v in pairs}
    _assert(by_fid.get("8005ff00") == "20002", f"ext fid {by_fid}")
    _assert(by_fid.get("0003ff00") == "043V612", f"port fid {by_fid}")

    parsed = parse_display_station(SAMPLE, "20002")
    _assert(parsed.get("port") == "043V612", f"port={parsed.get('port')!r}")
    _assert(parsed.get("setType") == "9641", f"setType={parsed.get('setType')!r}")
    _assert("Chan" in str(parsed.get("name") or ""), f"name={parsed.get('name')!r}")
    labels = [r["label"].lower() for r in parsed.get("formRows") or []]
    values = [r["value"] for r in parsed.get("formRows") or []]
    for lab in labels:
        _assert("security" not in lab, f"secret label {lab}")
        _assert("password" not in lab, f"secret label {lab}")
        _assert("pin" not in lab, f"secret label {lab}")
    _assert("1" not in values, f"leftover integer leaked into formRows: {parsed['formRows']}")
    _assert("COR" not in [r["label"] for r in parsed["formRows"]], f"guessed COR: {parsed['formRows']}")

    pairs2 = pair_ossi_fields(SAMPLE_MORE_AND_T)
    _assert(len(pairs2) == 5, f"more?[y]/t stopped pairing: {len(pairs2)} {pairs2}")
    p2 = parse_display_station(SAMPLE_MORE_AND_T, "20002")
    _assert(p2.get("port") == "043V612", f"paged port={p2.get('port')!r}")
    _assert("Chan" in str(p2.get("name") or ""), f"paged name={p2.get('name')!r}")

    sec = parse_display_station(SAMPLE_SECRET, "20002")
    sec_vals = [r["value"] for r in sec.get("formRows") or []]
    sec_labs = [r["label"].lower() for r in sec.get("formRows") or []]
    _assert("9999" not in sec_vals, f"security value in formRows: {sec['formRows']}")
    _assert("1234" not in sec_vals, f"password value in formRows: {sec['formRows']}")
    for lab in sec_labs:
        _assert("security" not in lab and "password" not in lab and "pin" not in lab, lab)
    _assert(sec.get("port") == "043V612", f"secret-sample port={sec.get('port')!r}")
    _assert("Chan" in str(sec.get("name") or ""), f"secret-sample name={sec.get('name')!r}")

    vdn = parse_display_vdn(SAMPLE_VDN, "700")
    _assert("Hotline" in str(vdn.get("name") or ""), f"vdn name={vdn.get('name')!r}")
    vdn_by = {r["label"]: r["value"] for r in vdn.get("formRows") or []}
    _assert(vdn_by.get("Destination") == "15000", f"vdn dest {vdn_by}")
    _assert(vdn_by.get("Measured") == "internal", f"vdn measured {vdn_by}")

    st_empty = parse_status_station("cstatus station 20101\nt\n", "20101")
    labs = [r["label"] for r in st_empty["formRows"]]
    _assert(labs[0] == "User DND", labs)
    _assert(labs[1] == "CF Destination", labs)
    _assert(len(labs) == 8, labs)
    _assert(all(r["value"] == "—" for r in st_empty["formRows"]), st_empty)

    syn = (
        "cstatus station 22468\n"
        "f000fff00\t0026ff00\t7539ff00\t753aff00\t753bff00\n"
        "d926787582\tnot activated\t\t\t\n"
        "f753cff00\t753dff00\t753eff00\n"
        "d\t\t926782678\n"
        "t\n"
    )
    st_syn = parse_status_station(syn, "22468")
    bys = {r["label"]: r["value"] for r in st_syn["formRows"]}
    _assert(bys["CF Destination"] == "926787582", bys)
    _assert(bys["User DND"] == "not activated", bys)
    _assert(bys["ECF Uncond Internal"] == "—", bys)
    _assert(bys["ECF No Reply External"] == "926782678", bys)

    hunt = parse_display_hunt(SAMPLE_HUNT, "1")
    _assert("Ops" in str(hunt.get("name") or ""), f"hunt name={hunt.get('name')!r}")
    hunt_by = {r["label"]: r["value"] for r in hunt.get("formRows") or []}
    _assert(hunt_by.get("Group type") == "ucd-mia", f"hunt type {hunt_by}")
    _assert(hunt_by.get("Group number") == "1", f"hunt number {hunt_by}")

    live = Path(__file__).resolve().parent.parent / "data_live" / "display_station_48902_last.txt"
    if live.is_file() and live.stat().st_size > 200:
        raw = live.read_text(encoding="utf-8", errors="replace")
        live_p = parse_display_station(raw, "48902")
        live_by = {r["label"]: r["value"] for r in live_p.get("formRows") or []}
        _assert(live_p.get("setType") == "CallrID", f"48902 setType={live_p}")
        _assert(live_p.get("port") == "027V710", f"48902 port={live_p}")
        _assert(live_by.get("COR") == "1", f"48902 COR {live_by}")
        _assert(live_by.get("COS") == "4", f"48902 COS {live_by}")
        _assert(live_by.get("TN") == "1", f"48902 TN {live_by}")
        _assert(live_p.get("name") != "as-needed", f"48902 guessed name {live_p.get('name')!r}")
        print("48902-ok", live_by)

    print("ok", len(pairs), parsed.get("port"), parsed.get("setType"), parsed.get("name"))
    print("formRows", parsed.get("formRows"))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as exc:
        print("FAIL:", exc, file=sys.stderr)
        raise SystemExit(1)
