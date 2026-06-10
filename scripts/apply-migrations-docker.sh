#!/usr/bin/env bash
# Apply active migrations/[0-9][0-9]*_*.sql in order to Docker Postgres.
# Skips files already recorded in public.ros_schema_migrations.
# Detects file-content drift: warns when an already-applied file has changed since it was recorded.
# Run from repo root: ./scripts/apply-migrations-docker.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RIVERSIDE_DB_NAME="${RIVERSIDE_DB_NAME:-riverside_os}"

docker compose up -d db

DPSQL="docker compose exec -T db psql -U postgres -d $RIVERSIDE_DB_NAME"

ledger_exists() {
  $DPSQL -tAc \
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ros_schema_migrations');" \
    | tr -d '[:space:]'
}

ensure_checksum_column() {
  if [ "$(ledger_exists)" = "t" ]; then
    $DPSQL -tAc "ALTER TABLE ros_schema_migrations ADD COLUMN IF NOT EXISTS file_sha256 text;" >/dev/null 2>&1 || true
  fi
}

file_sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

ensure_checksum_column

DRIFT_COUNT=0

# Prefix is two or more digits (00–99 and 100+); avoids missing three-digit migration files.
for f in $(ls "$ROOT"/migrations/[0-9][0-9]*_*.sql 2>/dev/null | sort -V); do
  base="$(basename "$f")"
  current_sha="$(file_sha256 "$f")"

  if [ "$(ledger_exists)" = "t" ]; then
    applied="$($DPSQL -tAc "SELECT EXISTS(SELECT 1 FROM ros_schema_migrations WHERE version = '$base');" | tr -d '[:space:]')"
  else
    applied="f"
  fi

  if [ "$applied" = "t" ]; then
    stored_sha="$($DPSQL -tAc "SELECT COALESCE(file_sha256, '') FROM ros_schema_migrations WHERE version = '$base';" | tr -d '[:space:]')"
    if [ -z "$stored_sha" ]; then
      $DPSQL -tAc "UPDATE ros_schema_migrations SET file_sha256 = '$current_sha' WHERE version = '$base' AND (file_sha256 IS NULL OR btrim(file_sha256) = '');" >/dev/null
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

  echo "Applying $base to $RIVERSIDE_DB_NAME"
  $DPSQL -v ON_ERROR_STOP=1 < "$f"
  if [ "$(ledger_exists)" != "t" ]; then
    echo "Migration $base did not create public.ros_schema_migrations; cannot record ledger state." >&2
    exit 1
  fi
  ensure_checksum_column
  $DPSQL -v ON_ERROR_STOP=1 -c \
    "INSERT INTO ros_schema_migrations (version, file_sha256) VALUES ('$base', '$current_sha') ON CONFLICT (version) DO UPDATE SET file_sha256 = CASE WHEN ros_schema_migrations.file_sha256 IS NULL OR btrim(ros_schema_migrations.file_sha256) = '' THEN EXCLUDED.file_sha256 ELSE ros_schema_migrations.file_sha256 END;"
done

echo ""
if [ "$DRIFT_COUNT" -gt 0 ]; then
  echo "⚠ $DRIFT_COUNT migration file(s) have changed since they were applied."
  echo "  Create a new numbered migration to add any missing schema changes."
else
  echo "✓ No drift detected. All checksums match."
fi
echo "Done. Ledger: SELECT version, file_sha256 FROM ros_schema_migrations ORDER BY version; — status: ./scripts/migration-status-docker.sh"
