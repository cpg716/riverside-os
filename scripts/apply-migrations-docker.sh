#!/usr/bin/env bash
# Apply migrations/NN_*.sql in order to Docker Postgres (docker-compose.yml).
# Skips files already recorded in public.ros_schema_migrations (see migrations/00_ros_migration_ledger.sql).
# Run from repo root: ./scripts/apply-migrations-docker.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

docker compose up -d db

LEDGER_EXISTS="$(docker compose exec -T db psql -U postgres -d riverside_os -tAc "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ros_schema_migrations');" | tr -d '[:space:]')"

if [ "$LEDGER_EXISTS" != "t" ]; then
  echo "Bootstrapping migration ledger (00_ros_migration_ledger.sql)"
  docker compose exec -T db psql -U postgres -d riverside_os -v ON_ERROR_STOP=1 < "$ROOT/migrations/00_ros_migration_ledger.sql"
  docker compose exec -T db psql -U postgres -d riverside_os -v ON_ERROR_STOP=1 -c "INSERT INTO ros_schema_migrations (version) VALUES ('00_ros_migration_ledger.sql') ON CONFLICT (version) DO NOTHING;"
fi

# Prefix is two or more digits (00–99 and 100+); avoids missing three-digit migration files.
for f in $(ls "$ROOT"/migrations/[0-9][0-9]*_*.sql 2>/dev/null | sort -V); do
  base="$(basename "$f")"
  applied="$(docker compose exec -T db psql -U postgres -d riverside_os -tAc "SELECT EXISTS(SELECT 1 FROM ros_schema_migrations WHERE version = '$base');" | tr -d '[:space:]')"
  if [ "$applied" = "t" ]; then
    echo "Skip (ledger): $base"
    continue
  fi
  echo "Applying $base"
  docker compose exec -T db psql -U postgres -d riverside_os -v ON_ERROR_STOP=1 < "$f"
  docker compose exec -T db psql -U postgres -d riverside_os -v ON_ERROR_STOP=1 -c "INSERT INTO ros_schema_migrations (version) VALUES ('$base') ON CONFLICT (version) DO NOTHING;"
done

echo "Done. Ledger: SELECT * FROM ros_schema_migrations ORDER BY version; — status: ./scripts/migration-status-docker.sh"
