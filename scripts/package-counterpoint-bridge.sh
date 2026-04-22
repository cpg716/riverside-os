#!/usr/bin/env bash
# Build a zip you can copy to the Counterpoint Windows server (no node_modules).
# Includes env.example (same as .env.example + banner) for operators who miss dotfiles in Explorer.
# Run from repo root: ./scripts/package-counterpoint-bridge.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/counterpoint-bridge-for-windows.zip"
STAGE="$(mktemp -d)"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

rm -f "$OUT"

mkdir -p "$STAGE/counterpoint-bridge"
# Copy bridge tree minus bulky / sensitive / local artifacts (no rsync required)
shopt -s dotglob nullglob
for src in "$ROOT/counterpoint-bridge"/* "$ROOT/counterpoint-bridge"/.[!.]*; do
  [[ -e "$src" ]] || continue
  base="$(basename "$src")"
  case "$base" in
    node_modules|.env|.counterpoint-bridge-state.json|.DS_Store) continue ;;
  esac
  case "$base" in
    *.zip) continue ;;
  esac
  cp -a "$src" "$STAGE/counterpoint-bridge/"
done
shopt -u dotglob nullglob

BRIDGE_VER="$(grep -E '^const BRIDGE_VERSION' "$STAGE/counterpoint-bridge/index.mjs" | sed -n "s/.*\"\([^\"]*\)\".*/\1/p")"
{
  echo "================================================================================"
  echo "  Riverside OS — Counterpoint bridge — environment template"
  echo "  Package file: env.example (same content as .env.example, easier to spot on Windows)"
  echo "  START_BRIDGE.cmd creates .env from .env.example, or from env.example if needed."
  echo "  Bridge version line in index.mjs: ${BRIDGE_VER:-unknown}"
  echo "  Built: $(date -u +"%Y-%m-%dT%H:%MZ")"
  echo "================================================================================"
  echo ""
  cat "$ROOT/counterpoint-bridge/.env.example"
} > "$STAGE/counterpoint-bridge/env.example"

{
  echo "Riverside OS — Counterpoint → ROS bridge (Windows package)"
  echo "Bridge version: ${BRIDGE_VER:-unknown}"
  echo "Packaged: $(date -u +"%Y-%m-%dT%H:%MZ") UTC"
  echo ""
  echo "Contents:"
  echo "  - START_BRIDGE.cmd       Double-click to install deps and run"
  echo "  - DISCOVER_SCHEMA.cmd   Schema probe (SQL only; no ROS token)"
  echo "  - .env.example          Full template (copy to .env)"
  echo "  - env.example           Same template + header (copy to .env if you prefer)"
  echo "  - INSTALL_ON_COUNTERPOINT_SERVER.txt"
  echo "  - README.md"
  echo ""
  echo "First run: set SQL_CONNECTION_STRING, ROS_BASE_URL, COUNTERPOINT_SYNC_TOKEN in .env"
  echo "Optional: CP_IMPORT_SINCE=2018-01-01 and __CP_IMPORT_SINCE__ in ticket/note queries."
  echo ""
  echo "After migration sign-off:"
  echo "  - stop the bridge on the Counterpoint PC"
  echo "  - remove any startup or scheduled launch entry"
  echo "  - delete this package/folder or rotate COUNTERPOINT_SYNC_TOKEN"
  echo "Full runbook: docs/COUNTERPOINT_ONE_TIME_IMPORT.md (in main Riverside OS repo)"
} > "$STAGE/counterpoint-bridge/PACKAGE_README.txt"

(
  cd "$STAGE"
  zip -r "$OUT" counterpoint-bridge
)

echo "Wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo "Copy that zip to the Counterpoint PC, unzip, install Node LTS, then double-click START_BRIDGE.cmd"
echo "After successful migration sign-off, stop the bridge and retire the package or rotate COUNTERPOINT_SYNC_TOKEN."
