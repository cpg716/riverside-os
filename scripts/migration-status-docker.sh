#!/usr/bin/env bash
# Report migration ledger vs heuristic schema probes (Docker db service).
# Run from repo root: ./scripts/migration-status-docker.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

docker compose up -d db

docker compose exec -T db psql -U postgres -d riverside_os -v ON_ERROR_STOP=1 < "$ROOT/migrations/00_ros_migration_ledger.sql" >/dev/null

cat "$ROOT/scripts/ros_migration_build_probes.sql" "$ROOT/scripts/ros_migration_status_select.sql" \
  | docker compose exec -T db psql -U postgres -d riverside_os -v ON_ERROR_STOP=1

echo ""
repo_versions_file="$(mktemp)"
ledger_versions_file="$(mktemp)"
trap 'rm -f "$repo_versions_file" "$ledger_versions_file"' EXIT

find "$ROOT/migrations" -maxdepth 1 -type f -name '[0-9][0-9]*_*.sql' -exec basename {} \; | sort -V > "$repo_versions_file"
docker compose exec -T db psql -U postgres -d riverside_os -tAc "SELECT version FROM ros_schema_migrations ORDER BY version;" \
  | sed '/^$/d' | sort -V > "$ledger_versions_file"

echo "Repo vs ledger:"
missing_from_ledger="$(comm -23 "$repo_versions_file" "$ledger_versions_file" || true)"
extra_in_ledger="$(comm -13 "$repo_versions_file" "$ledger_versions_file" || true)"
repo_count="$(wc -l < "$repo_versions_file" | tr -d '[:space:]')"
ledger_count="$(wc -l < "$ledger_versions_file" | tr -d '[:space:]')"
echo "  repo migration files: $repo_count"
echo "  ledger rows: $ledger_count"
if [ -z "$missing_from_ledger" ]; then
  echo "  missing from ledger: none"
else
  echo "  missing from ledger:"
  printf '%s\n' "$missing_from_ledger" | sed 's/^/    - /'
fi
if [ -z "$extra_in_ledger" ]; then
  echo "  ledger rows without repo file: none"
else
  echo "  ledger rows without repo file:"
  printf '%s\n' "$extra_in_ledger" | sed 's/^/    - /'
fi

echo ""
echo "Ledger rows only:"
docker compose exec -T db psql -U postgres -d riverside_os -c "SELECT version, applied_at FROM ros_schema_migrations ORDER BY version;"
