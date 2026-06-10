#!/usr/bin/env bash
# Apply active migrations/[0-9][0-9]*_*.sql in order using psql and DATABASE_URL.
# Skips files already recorded in public.ros_schema_migrations.
# Detects file-content drift: warns when an already-applied file has changed since it was recorded.
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

# Ensure the ledger has a checksum column for drift detection.
ensure_checksum_column() {
  if [ "$(ledger_exists)" = "t" ]; then
    psql "$DATABASE_URL" -tAc \
      "ALTER TABLE ros_schema_migrations ADD COLUMN IF NOT EXISTS file_sha256 text;" >/dev/null 2>&1 || true
  fi
}

file_sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

ensure_checksum_column

DRIFT_COUNT=0

for f in $(ls "$ROOT"/migrations/[0-9][0-9]*_*.sql 2>/dev/null | sort -V); do
  base="$(basename "$f")"
  current_sha="$(file_sha256 "$f")"

  if [ "$(ledger_exists)" = "t" ]; then
    applied="$(psql "$DATABASE_URL" -tAc "SELECT EXISTS(SELECT 1 FROM ros_schema_migrations WHERE version = '$base');" | tr -d '[:space:]')"
  else
    applied="f"
  fi

  if [ "$applied" = "t" ]; then
    # Check for drift: compare stored checksum with current file.
    stored_sha="$(psql "$DATABASE_URL" -tAc "SELECT COALESCE(file_sha256, '') FROM ros_schema_migrations WHERE version = '$base';" | tr -d '[:space:]')"
    if [ -z "$stored_sha" ]; then
      # Backfill checksum for legacy rows that were applied before checksums existed.
      psql "$DATABASE_URL" -tAc "UPDATE ros_schema_migrations SET file_sha256 = '$current_sha' WHERE version = '$base' AND (file_sha256 IS NULL OR btrim(file_sha256) = '');" >/dev/null
      echo "Skip (ledger, checksum recorded): $base"
    elif [ "$stored_sha" != "$current_sha" ]; then
      echo "⚠ DRIFT: $base has changed since it was applied! (stored=$stored_sha current=$current_sha)"
      echo "  → This file was modified after being applied. You may need a new migration to reconcile."
      DRIFT_COUNT=$((DRIFT_COUNT + 1))
    else
      echo "Skip (ledger): $base"
    fi
    continue
  fi

  echo "Applying $base"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 < "$f"
  if [ "$(ledger_exists)" != "t" ]; then
    echo "Migration $base did not create public.ros_schema_migrations; cannot record ledger state." >&2
    exit 1
  fi
  ensure_checksum_column
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
    "WITH recorded AS (
       UPDATE ros_schema_migrations
          SET file_sha256 = CASE
              WHEN file_sha256 IS NULL OR btrim(file_sha256) = '' THEN '$current_sha'
              ELSE file_sha256
          END
        WHERE version = '$base'
        RETURNING 1
     )
     INSERT INTO ros_schema_migrations (version, file_sha256)
     SELECT '$base', '$current_sha'
     WHERE NOT EXISTS (SELECT 1 FROM recorded);"
done

echo ""
if [ "$DRIFT_COUNT" -gt 0 ]; then
  echo "⚠ $DRIFT_COUNT migration file(s) have changed since they were applied."
  echo "  Create a new numbered migration to add any missing schema changes."
else
  echo "✓ No drift detected. All checksums match."
fi
echo "Done. Ledger: SELECT version, file_sha256 FROM ros_schema_migrations ORDER BY version;"
