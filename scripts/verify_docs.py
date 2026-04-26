#!/usr/bin/env python3
"""
Lightweight documentation drift checks.

Checks:
1. Relative Markdown links in repo-root Markdown and docs/**/*.md.
2. Known stale path strings from renamed files / retired active flows.
3. Migration references that point at missing files or stale current ceilings.
4. Backticked repo path references that point at missing files or folders.
5. Staff corpus drift via scripts/verify_ai_knowledge_drift.py.

This intentionally avoids external dependencies so it can run in local shells,
CI, and release-prep checklists.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent

MARKDOWN_LINK_RE = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")
INLINE_CODE_RE = re.compile(r"`([^`\n]+)`")
MIGRATION_FILENAME_RE = re.compile(r"\b(\d{2,3}[a-z]?_[A-Za-z0-9_]+\.sql)\b")
MIGRATION_PATH_RE = re.compile(r"\bmigrations/(\d{2,3}[a-z]?_[A-Za-z0-9_]+\.sql)\b")
MIGRATION_CEILING_RE = re.compile(
    r"(?:current repo ceiling|latest numbered files currently extend through|current files|through the latest numbered migration).*",
    re.IGNORECASE,
)

SKIP_LINK_PREFIXES = (
    "#",
    "http://",
    "https://",
    "file://",
    "mailto:",
    "tel:",
)

EXCLUDED_MD_PARTS = {
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".vite",
}

# Files that intentionally mention historical paths as audit evidence.
STALE_STRING_ALLOWLIST = {
    "docs/DOCUMENTATION_AUDIT_2026.md",
    "docs/API_AI.md",
    "docs/ROS_AI_HELP_CORPUS.md",
    "docs/ROS_GEMMA_WORKER.md",
    "ROS_AI_INTEGRATION_PLAN.md",
}

STALE_STRINGS = {
    "server/src/api/orders.rs": "Use server/src/api/transactions.rs for active transaction routes.",
    "server/src/logic/order_checkout.rs": "Use server/src/logic/transaction_checkout.rs.",
    "server/src/logic/order_recalc.rs": "Use server/src/logic/transaction_recalc.rs.",
    "server/src/logic/order_list.rs": "Use server/src/logic/transaction_list.rs.",
    "client/src/components/layout/Header.tsx": "Use GlobalTopBar.tsx or App.tsx ownership depending on context.",
    "client/src/components/layout/TopBar.tsx": "Use client/src/components/layout/GlobalTopBar.tsx.",
    "REPORTING_BOOKED_AND_RECOGNITION.md": "Use REPORTING_BOOKED_AND_FULFILLED.md.",
    "docs/REPORTING_BOOKED_AND_RECOGNITION.md": "Use docs/REPORTING_BOOKED_AND_FULFILLED.md.",
    "docs/staff/orders-back-office.md": "Use docs/staff/transactions-back-office.md.",
    "orders-back-office.md": "Use transactions-back-office.md for active staff docs.",
    "POST /api/ai/admin/reindex-docs": "Retired active flow; use Help Center generate:help and ros_help reindex docs.",
    "npm run reindex:staff-docs": "Retired active flow; use Help Center generate:help and ros_help reindex docs.",
}

STALE_CONTEXT_ALLOW_WORDS = (
    "retired",
    "historical",
    "history",
    "former",
    "old ",
    "old:",
    "pre-78",
    "do not use",
    "not the former",
    "no longer exist",
    "no longer exists",
)

MIGRATION_CEILING_ALLOWLIST = {
    "docs/DOCUMENTATION_AUDIT_2026.md",
}

REPO_PATH_PREFIXES = (
    "client/",
    "counterpoint-bridge/",
    "docs/",
    "migrations/",
    "scripts/",
    "server/",
    "tests/",
)

REPO_ROOT_FILES = {
    "AGENTS.md",
    "CHANGELOG.md",
    "DEVELOPER.md",
    "README.md",
    "ROS_AI_INTEGRATION_PLAN.md",
    "ThingsBeforeLaunch.md",
    "docker-compose.yml",
    "package.json",
}

PATH_REFERENCE_ALLOWLIST = {
    "client/src/components/pos/*",
    "client/src/components/store*",
    "docs/staff/*.md",
    "migrations/NN_reporting_views.sql",
    "client/src/assets/docs/inventory-manual.md",
    "client/src/assets/images/help/inventory/",
    "server/logs/api-runtime.log",
    "server/src/api/<module>.rs",
    "server/src/logic/pos*.rs",
    "server/src/logic/podium*.rs",
    "server/src/logic/store_*.rs",
    "server/src/logic/meilisearch_*.rs",
}

PATH_REFERENCE_FILE_ALLOWLIST = {
    "docs/API_AI.md",
    "docs/DOCUMENTATION_AUDIT_2026.md",
    "docs/RETIRED_DOCUMENT_SUMMARIES.md",
    "docs/ROS_AI_HELP_CORPUS.md",
    "ROS_AI_INTEGRATION_PLAN.md",
}


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    message: str


def repo_relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def markdown_files() -> list[Path]:
    files: list[Path] = []
    for path in ROOT.rglob("*.md"):
        rel = path.relative_to(ROOT)
        rel_parts = set(rel.parts)
        if rel_parts & EXCLUDED_MD_PARTS:
            continue
        if any(part.startswith(".") for part in rel.parts):
            continue
        files.append(path)
    return sorted(files)


def normalize_link(raw_href: str) -> str:
    href = raw_href.strip()
    if href.startswith("<") and href.endswith(">"):
        href = href[1:-1]
    return href.split("#", 1)[0]


def verify_links(files: list[Path]) -> list[Finding]:
    findings: list[Finding] = []
    for path in files:
        text = path.read_text(encoding="utf-8", errors="ignore")
        for line_no, line in enumerate(text.splitlines(), start=1):
            for match in MARKDOWN_LINK_RE.finditer(line):
                href = normalize_link(match.group(1))
                if not href or href.startswith(SKIP_LINK_PREFIXES):
                    continue
                if href.startswith("app://") or href.startswith("plugin://"):
                    continue
                target = (path.parent / href).resolve()
                try:
                    target.relative_to(ROOT)
                except ValueError:
                    # Local links should stay inside the repository.
                    findings.append(
                        Finding(
                            repo_relative(path),
                            line_no,
                            f"link escapes repo: {match.group(1)}",
                        )
                    )
                    continue
                if not target.exists():
                    findings.append(
                        Finding(
                            repo_relative(path),
                            line_no,
                            f"broken relative link: {match.group(1)} -> {target}",
                        )
                    )
    return findings


def verify_stale_strings(files: list[Path]) -> list[Finding]:
    findings: list[Finding] = []
    for path in files:
        rel = repo_relative(path)
        if rel in STALE_STRING_ALLOWLIST:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for line_no, line in enumerate(text.splitlines(), start=1):
            lowered = line.lower()
            for stale, replacement in STALE_STRINGS.items():
                if stale in line:
                    if any(word in lowered for word in STALE_CONTEXT_ALLOW_WORDS):
                        continue
                    findings.append(Finding(rel, line_no, f"stale reference `{stale}`: {replacement}"))
    return findings


def migration_files() -> set[str]:
    migrations_dir = ROOT / "migrations"
    if not migrations_dir.exists():
        return set()
    return {path.name for path in migrations_dir.glob("*.sql")}


def migration_sort_key(filename: str) -> tuple[int, str]:
    prefix = filename.split("_", 1)[0]
    match = re.match(r"(\d+)", prefix)
    number = int(match.group(1)) if match else -1
    return (number, filename)


def latest_migration_filename(existing: set[str]) -> str | None:
    if not existing:
        return None
    return max(existing, key=migration_sort_key)


def is_placeholder_migration(filename: str) -> bool:
    return filename.startswith("NN_")


def verify_migration_references(files: list[Path]) -> list[Finding]:
    existing = migration_files()
    latest = latest_migration_filename(existing)
    findings: list[Finding] = []

    for path in files:
        rel = repo_relative(path)
        text = path.read_text(encoding="utf-8", errors="ignore")
        for line_no, line in enumerate(text.splitlines(), start=1):
            for match in MIGRATION_PATH_RE.finditer(line):
                filename = match.group(1)
                if is_placeholder_migration(filename):
                    continue
                if filename not in existing:
                    findings.append(
                        Finding(
                            rel,
                            line_no,
                            f"migration file does not exist: migrations/{filename}",
                        )
                    )

            if latest and rel not in MIGRATION_CEILING_ALLOWLIST and MIGRATION_CEILING_RE.search(line):
                filenames = {
                    match.group(1)
                    for match in MIGRATION_FILENAME_RE.finditer(line)
                    if not is_placeholder_migration(match.group(1))
                }
                if filenames and latest not in filenames:
                    findings.append(
                        Finding(
                            rel,
                            line_no,
                            f"stale migration ceiling; latest repo migration is `{latest}`",
                        )
                    )
                elif re.search(r"\b00\s*[–-]\s*(\d{2,3})\b", line):
                    range_match = re.search(r"\b00\s*[–-]\s*(\d{2,3})\b", line)
                    if range_match and int(range_match.group(1)) < migration_sort_key(latest)[0]:
                        findings.append(
                            Finding(
                                rel,
                                line_no,
                                f"stale migration range; latest repo migration is `{latest}`",
                            )
                        )
                else:
                    current_number_match = re.search(r"\bcurrently\s+\*{0,2}`?(\d{2,3})`?\*{0,2}\b", line, re.IGNORECASE)
                    if current_number_match and int(current_number_match.group(1)) < migration_sort_key(latest)[0]:
                        findings.append(
                            Finding(
                                rel,
                                line_no,
                                f"stale migration ceiling number; latest repo migration is `{latest}`",
                            )
                        )

    return findings


def clean_path_reference(raw: str) -> str:
    value = raw.strip()
    value = value.rstrip(".,;:")
    value = re.sub(r":\d+(?:-\d+)?$", "", value)
    if value.startswith("./"):
        value = value[2:]
    return value


def looks_like_repo_path(value: str) -> bool:
    if value in REPO_ROOT_FILES:
        return True
    return value.startswith(REPO_PATH_PREFIXES)


def should_skip_path_reference(value: str) -> bool:
    if value in PATH_REFERENCE_ALLOWLIST:
        return True
    if value.startswith("migrations/NN_"):
        return True
    if any(token in value for token in ("<", ">", "*", "{", "}", "$", "...")):
        return True
    if "/." in value or value.startswith("."):
        return True
    if value.startswith(("http://", "https://", "file://", "/api/", "api/")):
        return True
    if " " in value:
        return True
    return False


def verify_repo_path_references(files: list[Path]) -> list[Finding]:
    findings: list[Finding] = []
    for path in files:
        rel = repo_relative(path)
        if rel in PATH_REFERENCE_FILE_ALLOWLIST:
            continue
        if path.name.startswith(("PLAN_", "PORTING_")):
            continue
        if rel.startswith("docs/reviews/"):
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for line_no, line in enumerate(text.splitlines(), start=1):
            for match in INLINE_CODE_RE.finditer(line):
                value = clean_path_reference(match.group(1))
                if not value or not looks_like_repo_path(value) or should_skip_path_reference(value):
                    continue
                target = (ROOT / value).resolve()
                try:
                    target.relative_to(ROOT)
                except ValueError:
                    findings.append(Finding(rel, line_no, f"path escapes repo: `{value}`"))
                    continue
                if not target.exists():
                    findings.append(Finding(rel, line_no, f"repo path does not exist: `{value}`"))
    return findings


def run_staff_corpus_check() -> int:
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts/verify_ai_knowledge_drift.py")],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.stdout:
        print(result.stdout.rstrip())
    if result.stderr:
        print(result.stderr.rstrip(), file=sys.stderr)
    return result.returncode


def print_findings(title: str, findings: list[Finding]) -> None:
    if not findings:
        print(f"OK: {title}")
        return
    print(f"FAIL: {title}", file=sys.stderr)
    for finding in findings:
        print(f"  {finding.path}:{finding.line}: {finding.message}", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify Riverside OS Markdown documentation health.")
    parser.add_argument(
        "--skip-staff-corpus",
        action="store_true",
        help="Skip docs/staff/CORPUS.manifest.json drift check.",
    )
    args = parser.parse_args()

    files = markdown_files()
    link_findings = verify_links(files)
    stale_findings = verify_stale_strings(files)
    migration_findings = verify_migration_references(files)
    path_findings = verify_repo_path_references(files)

    print(f"Scanned {len(files)} Markdown files.")
    print_findings("relative Markdown links", link_findings)
    print_findings("known stale references", stale_findings)
    print_findings("migration references", migration_findings)
    print_findings("repo path references", path_findings)

    staff_status = 0
    if not args.skip_staff_corpus:
        staff_status = run_staff_corpus_check()

    if link_findings or stale_findings or migration_findings or path_findings or staff_status != 0:
        return 1
    print("OK: documentation checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
