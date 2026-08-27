#!/usr/bin/env python3
"""UDP exact ext/aar/ars merge — 21280 insert + 21350 udp-ars."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from extension_parse import merge_udp_into_extensions, parse_list_uniform_dialplan  # noqa: E402


def _assert(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> int:
    udp_text = (
        "d21280\t5\t5\t26298882\tars\n"
        "n\n"
        "d21350\t5\t5\t58031944\tars\n"
        "n\n"
        "d20002\t5\t0\t\ttext\n"
        "n\n"
    )
    udp_rows = parse_list_uniform_dialplan(udp_text)
    items = [
        {
            "extension": "21280",
            "type": "station-user",
            "port": "X",
            "name": "Hotline to 26298882",
        },
        {
            "extension": "20002",
            "type": "station-user",
            "port": "043V612",
            "name": "Chan Wing Kit",
        },
    ]
    out = merge_udp_into_extensions(items, udp_rows)
    by = {str(r.get("extension")): r for r in out}

    a = by.get("21350") or {}
    _assert(a.get("type") == "udp-ars", f"21350 type={a.get('type')!r}")
    _assert(a.get("insertDigits") == "58031944", f"21350 insert={a.get('insertDigits')!r}")
    _assert(a.get("inUdp") is True, "21350 inUdp")

    b = by.get("21280") or {}
    _assert(b.get("type") == "station-user", f"21280 type={b.get('type')!r}")
    _assert(b.get("insertDigits") == "26298882", f"21280 insert={b.get('insertDigits')!r}")
    _assert(b.get("inUdp") is True, "21280 inUdp")
    _assert(b.get("udpType") == "ars", f"21280 udpType={b.get('udpType')!r}")

    dump = Path(__file__).resolve().parent.parent / "data_live" / "list_uniform-dialplan_last.txt"
    if dump.is_file():
        raw = dump.read_text(encoding="utf-8", errors="replace")
        parsed = parse_list_uniform_dialplan(raw)
        if "callrid" in raw.lower().replace(" ", "") or len(parsed) < 20:
            print("dump-skip (not UDP)")
        else:
            live = merge_udp_into_extensions(items, parsed)
            live_by = {str(r.get("extension")): r for r in live}
            _assert(live_by.get("21350", {}).get("insertDigits") == "58031944", live_by.get("21350"))
            _assert(live_by.get("21280", {}).get("insertDigits") == "26298882", live_by.get("21280"))
            print("dump-ok", live_by["21350"]["type"], live_by["21280"]["insertDigits"])
    print("ok", a.get("type"), b.get("insertDigits"))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as exc:
        print("FAIL:", exc, file=sys.stderr)
        raise SystemExit(1)
