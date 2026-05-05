#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

left_out="$(mktemp)"
right_out="$(mktemp)"
trap 'rm -f "$left_out" "$right_out"' EXIT

dump_and_normalize() {
  local target="$1"
  local out="$2"

  if [[ "$target" == postgres://* || "$target" == postgresql://* ]]; then
    pg_dump "$target" --schema-only --no-owner --no-privileges
  else
    docker compose exec -T db pg_dump -U postgres -d "$target" --schema-only --no-owner --no-privileges
  fi \
    | sed '/^-- Dumped /d; /^\\restrict /d; /^\\unrestrict /d' \
    > "$out"
}

left="${1:-${SCHEMA_DIFF_LEFT:-}}"
right="${2:-${SCHEMA_DIFF_RIGHT:-}}"

if [ -z "$left" ] || [ -z "$right" ]; then
  echo "Usage: scripts/schema_diff.sh <left-db-or-url> <right-db-or-url>" >&2
  echo "Example: scripts/schema_diff.sh riverside_schema_contract_build riverside_schema_contract_candidate" >&2
  exit 2
fi

docker compose up -d db >/dev/null
dump_and_normalize "$left" "$left_out"
dump_and_normalize "$right" "$right_out"

if diff -u "$left_out" "$right_out"; then
  echo "Schema diff OK: normalized schemas match."
fi
