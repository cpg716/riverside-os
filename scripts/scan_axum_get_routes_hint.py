#!/usr/bin/env python3
"""
Heuristic list of Axum route path literals on lines that also mention get(.

Use when updating docs/AI_REPORTING_DATA_CATALOG.md §0: compare output to the doc;
this does NOT resolve .nest("/api/foo", ...) prefixes — paths are per-router file only.

Usage (from repo root):
  python3 scripts/scan_axum_get_routes_hint.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROUTE_RE = re.compile(r'\.route\(\s*"([^"]+)"')


def main() -> int:
    api_dir = Path(__file__).resolve().parent.parent / "server" / "src" / "api"
    if not api_dir.is_dir():
        print("No server/src/api directory", file=sys.stderr)
        return 1

    hits: list[tuple[str, str]] = []
    for fp in sorted(api_dir.glob("*.rs")):
        try:
            text = fp.read_text(encoding="utf-8")
        except OSError as e:
            print(f"skip {fp.name}: {e}", file=sys.stderr)
            continue
        for line in text.splitlines():
            if "get(" not in line or ".route(" not in line:
                continue
            m = ROUTE_RE.search(line)
            if m:
                hits.append((fp.name, m.group(1)))

    current = ""
    for fname, path in hits:
        if fname != current:
            print(f"\n# {fname}")
            current = fname
        print(f"  {path}")
    print(f"\nTotal get-adjacent route lines: {len(hits)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
