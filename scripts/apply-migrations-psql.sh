#!/usr/bin/env bash
# Apply migrations/NN_*.sql in order to PostgreSQL using psql and DATABASE_URL.
# Skips files already recorded in public.ros_schema_migrations (see migrations/00_ros_migration_ledger.sql).
#
# Requirements: psql on PATH, DATABASE_URL set (same style as server/.env).
# Run from repo root:  export DATABASE_URL="postgresql://..." && ./scripts/apply-migrations-psql.sh
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set. Example: export DATABASE_URL='postgresql://user:pass@host:5432/riverside_os'" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LEDGER_EXISTS="$(psql "$DATABASE_URL" -tAc "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ros_schema_migrations');" | tr -d '[:space:]')"

if [ "$LEDGER_EXISTS" != "t" ]; then
  echo "Bootstrapping migration ledger (00_ros_migration_ledger.sql)"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 < "$ROOT/migrations/00_ros_migration_ledger.sql"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "INSERT INTO ros_schema_migrations (version) VALUES ('00_ros_migration_ledger.sql') ON CONFLICT (version) DO NOTHING;"
fi

for f in $(ls "$ROOT"/migrations/[0-9][0-9]*_*.sql 2>/dev/null | sort -V); do
  base="$(basename "$f")"
  applied="$(psql "$DATABASE_URL" -tAc "SELECT EXISTS(SELECT 1 FROM ros_schema_migrations WHERE version = '$base');" | tr -d '[:space:]')"
  if [ "$applied" = "t" ]; then
    echo "Skip (ledger): $base"
    continue
  fi
  echo "Applying $base"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 < "$f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "INSERT INTO ros_schema_migrations (version) VALUES ('$base') ON CONFLICT (version) DO NOTHING;"
done

echo "Done. Ledger: SELECT * FROM ros_schema_migrations ORDER BY version;"
