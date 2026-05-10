#!/usr/bin/env bash
# Smoke-test the Windows Counterpoint bridge package contents.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/counterpoint-bridge-for-windows.zip"
UNPACK_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$UNPACK_DIR"
  rm -f "$OUT"
}
trap cleanup EXIT

fail() {
  echo "Counterpoint bridge package smoke failed: $*" >&2
  exit 1
}

require_file() {
  local path="$1"
  [[ -f "$UNPACK_DIR/$path" ]] || fail "missing required file: $path"
}

assert_absent_name() {
  local name="$1"
  if find "$UNPACK_DIR/counterpoint-bridge" -name "$name" -print -quit | grep -q .; then
    fail "forbidden file included: $name"
  fi
}

"$ROOT/scripts/package-counterpoint-bridge.sh" >/dev/null

[[ -s "$OUT" ]] || fail "package zip was not created"

unzip -t "$OUT" >/dev/null
unzip -q "$OUT" -d "$UNPACK_DIR"

required_files=(
  "counterpoint-bridge/index.mjs"
  "counterpoint-bridge/package.json"
  "counterpoint-bridge/package-lock.json"
  "counterpoint-bridge/README.md"
  "counterpoint-bridge/INSTALL_ON_COUNTERPOINT_SERVER.txt"
  "counterpoint-bridge/START_BRIDGE.cmd"
  "counterpoint-bridge/DISCOVER_SCHEMA.cmd"
  "counterpoint-bridge/.env.example"
  "counterpoint-bridge/env.example"
  "counterpoint-bridge/PACKAGE_README.txt"
  "counterpoint-bridge/dashboard.html"
  "counterpoint-bridge/SCHEMA_PROBE_ALIGNMENT.txt"
)

for file in "${required_files[@]}"; do
  require_file "$file"
done

assert_absent_name ".env"
assert_absent_name ".counterpoint-bridge-state.json"
assert_absent_name "node_modules"
assert_absent_name ".DS_Store"
assert_absent_name "*.zip"
assert_absent_name "*.log"
assert_absent_name "counterpoint-schema-report.txt"

bridge_version="$(
  grep -E '^const BRIDGE_VERSION' "$UNPACK_DIR/counterpoint-bridge/index.mjs" |
    sed -n 's/.*"\([^"]*\)".*/\1/p'
)"
[[ -n "$bridge_version" ]] || fail "BRIDGE_VERSION could not be extracted"

grep -Fq "$bridge_version" "$UNPACK_DIR/counterpoint-bridge/env.example" ||
  fail "env.example does not include bridge version $bridge_version"
grep -Fq "$bridge_version" "$UNPACK_DIR/counterpoint-bridge/PACKAGE_README.txt" ||
  fail "PACKAGE_README.txt does not include bridge version $bridge_version"

echo "Counterpoint bridge package smoke passed for bridge $bridge_version"
