#!/usr/bin/env python3
"""
Drift checks for AI-facing documentation (staff RAG corpus).

1. Every path in docs/staff/CORPUS.manifest.json must exist on disk.
2. Every *.md under docs/staff/ (except _TEMPLATE.md) must appear in the manifest.

Does NOT verify AI_REPORTING_DATA_CATALOG.md against Axum routes — that still needs
human review when adding GET handlers; see docs/AI_CONTEXT_FOR_ASSISTANTS.md §8.

Usage (from repo root):
  python3 scripts/verify_ai_knowledge_drift.py
  python3 scripts/verify_ai_knowledge_drift.py --allow-orphans   # warn only for unlisted staff .md
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify staff corpus manifest vs files on disk.")
    parser.add_argument(
        "--allow-orphans",
        action="store_true",
        help="Do not fail if a staff .md file is missing from CORPUS.manifest.json (print warning only).",
    )
    args = parser.parse_args()

    root = Path(__file__).resolve().parent.parent
    manifest_path = root / "docs/staff/CORPUS.manifest.json"
    if not manifest_path.is_file():
        print(f"FAIL: missing {manifest_path.relative_to(root)}", file=sys.stderr)
        return 1

    with manifest_path.open(encoding="utf-8") as f:
        data = json.load(f)
    listed = data.get("files")
    if not isinstance(listed, list) or not all(isinstance(x, str) for x in listed):
        print("FAIL: CORPUS.manifest.json must have a string array 'files'", file=sys.stderr)
        return 1

    listed_set = set(listed)
    missing = sorted(p for p in listed_set if not (root / p).is_file())
    if missing:
        print("FAIL: manifest lists files that do not exist:", file=sys.stderr)
        for p in missing:
            print(f"  {p}", file=sys.stderr)
        return 1

    staff_md: set[str] = set()
    staff_root = root / "docs/staff"
    if staff_root.is_dir():
        for p in staff_root.rglob("*.md"):
            if p.name == "_TEMPLATE.md":
                continue
            staff_md.add(p.relative_to(root).as_posix())

    not_listed = sorted(staff_md - listed_set)
    if not_listed:
        msg = "Staff Markdown files exist but are NOT in docs/staff/CORPUS.manifest.json:"
        if args.allow_orphans:
            print("WARN:", msg)
            for p in not_listed:
                print(f"  {p}")
            print("(allowed by --allow-orphans)")
            print("OK: manifest paths exist;", len(listed_set), "entries.")
            return 0
        print(msg, file=sys.stderr)
        for p in not_listed:
            print(f"  {p}", file=sys.stderr)
        return 2

    print("OK: corpus manifest", len(listed_set), "paths exist; no unlisted staff guides.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
