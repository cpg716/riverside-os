#!/usr/bin/env bash
# Apply active migrations/[0-9][0-9]*_*.sql in order using psql and DATABASE_URL.
# Skips files already recorded in public.ros_schema_migrations.
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

ledger_exists() {
  psql "$DATABASE_URL" -tAc \
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ros_schema_migrations');" \
    | tr -d '[:space:]'
}

for f in $(ls "$ROOT"/migrations/[0-9][0-9]*_*.sql 2>/dev/null | sort -V); do
  base="$(basename "$f")"
  if [ "$(ledger_exists)" = "t" ]; then
    applied="$(psql "$DATABASE_URL" -tAc "SELECT EXISTS(SELECT 1 FROM ros_schema_migrations WHERE version = '$base');" | tr -d '[:space:]')"
  else
    applied="f"
  fi
  if [ "$applied" = "t" ]; then
    echo "Skip (ledger): $base"
    continue
  fi
  echo "Applying $base"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 < "$f"
  if [ "$(ledger_exists)" != "t" ]; then
    echo "Migration $base did not create public.ros_schema_migrations; cannot record ledger state." >&2
    exit 1
  fi
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "INSERT INTO ros_schema_migrations (version) SELECT '$base' WHERE NOT EXISTS (SELECT 1 FROM ros_schema_migrations WHERE version = '$base');"
done

echo "Done. Ledger: SELECT * FROM ros_schema_migrations ORDER BY version;"
