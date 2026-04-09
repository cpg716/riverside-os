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
echo "Ledger rows only:"
docker compose exec -T db psql -U postgres -d riverside_os -c "SELECT version, applied_at FROM ros_schema_migrations ORDER BY version;"
