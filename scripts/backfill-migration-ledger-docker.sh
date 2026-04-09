#!/usr/bin/env bash
# Insert ros_schema_migrations rows for any migration whose schema probe passes but is not yet in the ledger.
# Use once on an existing DB that predates the ledger. Then use apply-migrations-docker.sh for new files.
# Run from repo root: ./scripts/backfill-migration-ledger-docker.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

docker compose up -d db

docker compose exec -T db psql -U postgres -d riverside_os -v ON_ERROR_STOP=1 < "$ROOT/migrations/00_ros_migration_ledger.sql" >/dev/null

cat "$ROOT/scripts/ros_migration_build_probes.sql" "$ROOT/scripts/ros_migration_backfill_insert.sql" \
  | docker compose exec -T db psql -U postgres -d riverside_os -v ON_ERROR_STOP=1

echo "Backfill complete. Verify with ./scripts/migration-status-docker.sh"
