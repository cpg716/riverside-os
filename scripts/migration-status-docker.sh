#!/usr/bin/env bash
# Report active baseline migration ledger state for the Docker db service.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RIVERSIDE_DB_NAME="${RIVERSIDE_DB_NAME:-riverside_os}"

docker compose up -d db >/dev/null

"$ROOT/scripts/validate_migration_layout.sh"

repo_versions_file="$(mktemp)"
ledger_versions_file="$(mktemp)"
trap 'rm -f "$repo_versions_file" "$ledger_versions_file"' EXIT

find "$ROOT/migrations" -maxdepth 1 -type f -name '[0-9][0-9]*_*.sql' -exec basename {} \; | sort -V > "$repo_versions_file"

ledger_exists="$(
  docker compose exec -T db psql -U postgres -d "$RIVERSIDE_DB_NAME" -tAc \
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ros_schema_migrations');" \
    | tr -d '[:space:]'
)"

if [ "$ledger_exists" = "t" ]; then
  docker compose exec -T db psql -U postgres -d "$RIVERSIDE_DB_NAME" -tAc "SELECT version FROM ros_schema_migrations ORDER BY version;" \
    | sed '/^$/d' | sort -V > "$ledger_versions_file"
else
  : > "$ledger_versions_file"
fi

echo "Repo vs ledger for $RIVERSIDE_DB_NAME:"
missing_from_ledger="$(comm -23 "$repo_versions_file" "$ledger_versions_file" || true)"
extra_in_ledger="$(comm -13 "$repo_versions_file" "$ledger_versions_file" || true)"
repo_count="$(wc -l < "$repo_versions_file" | tr -d '[:space:]')"
ledger_count="$(wc -l < "$ledger_versions_file" | tr -d '[:space:]')"
echo "  active migration files: $repo_count"
echo "  ledger rows: $ledger_count"

if [ -n "$missing_from_ledger" ]; then
  echo "  missing from ledger:"
  printf '%s\n' "$missing_from_ledger" | sed 's/^/    - /'
else
  echo "  missing from ledger: none"
fi

if [ -n "$extra_in_ledger" ]; then
  echo "  ledger rows without active file:"
  printf '%s\n' "$extra_in_ledger" | sed 's/^/    - /'
else
  echo "  ledger rows without active file: none"
fi

if [ -z "$missing_from_ledger" ] && [ -z "$extra_in_ledger" ]; then
  RIVERSIDE_DB_NAME="$RIVERSIDE_DB_NAME" "$ROOT/scripts/validate_schema_contract.sh"
fi
