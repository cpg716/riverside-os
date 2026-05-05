#!/usr/bin/env bash
# Apply active migrations/[0-9][0-9]*_*.sql in order to Docker Postgres.
# Skips files already recorded in public.ros_schema_migrations.
# Run from repo root: ./scripts/apply-migrations-docker.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RIVERSIDE_DB_NAME="${RIVERSIDE_DB_NAME:-riverside_os}"

docker compose up -d db

ledger_exists() {
  docker compose exec -T db psql -U postgres -d "$RIVERSIDE_DB_NAME" -tAc \
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ros_schema_migrations');" \
    | tr -d '[:space:]'
}

# Prefix is two or more digits (00–99 and 100+); avoids missing three-digit migration files.
for f in $(ls "$ROOT"/migrations/[0-9][0-9]*_*.sql 2>/dev/null | sort -V); do
  base="$(basename "$f")"
  if [ "$(ledger_exists)" = "t" ]; then
    applied="$(docker compose exec -T db psql -U postgres -d "$RIVERSIDE_DB_NAME" -tAc "SELECT EXISTS(SELECT 1 FROM ros_schema_migrations WHERE version = '$base');" | tr -d '[:space:]')"
  else
    applied="f"
  fi
  if [ "$applied" = "t" ]; then
    echo "Skip (ledger): $base"
    continue
  fi
  echo "Applying $base to $RIVERSIDE_DB_NAME"
  docker compose exec -T db psql -U postgres -d "$RIVERSIDE_DB_NAME" -v ON_ERROR_STOP=1 < "$f"
  if [ "$(ledger_exists)" != "t" ]; then
    echo "Migration $base did not create public.ros_schema_migrations; cannot record ledger state." >&2
    exit 1
  fi
  docker compose exec -T db psql -U postgres -d "$RIVERSIDE_DB_NAME" -v ON_ERROR_STOP=1 -c "INSERT INTO ros_schema_migrations (version) SELECT '$base' WHERE NOT EXISTS (SELECT 1 FROM ros_schema_migrations WHERE version = '$base');"
done

echo "Done. Ledger: SELECT * FROM ros_schema_migrations ORDER BY version; — status: ./scripts/migration-status-docker.sh"
