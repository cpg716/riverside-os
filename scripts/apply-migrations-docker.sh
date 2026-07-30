#!/usr/bin/env bash
# Apply active migrations/[0-9][0-9]*_*.sql in order to Docker Postgres.
# Skips files already recorded in public.ros_schema_migrations.
# Detects file-content drift: warns when an already-applied file has changed since it was recorded.
# Run from repo root: ./scripts/apply-migrations-docker.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RIVERSIDE_DB_NAME="${RIVERSIDE_DB_NAME:-riverside_os}"
SOURCE_LOCKED_REPAIR_172="172_reassign_txn_624853_to_glenn_jones.sql"
SOURCE_LOCKED_REPAIR_172_TRANSACTION_ID="e9fbb62d-02e6-4256-9b3c-e6faced388a8"

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

repair_public_serial_sequences() {
  $DPSQL -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  rec record;
  max_value bigint;
BEGIN
  FOR rec IN
    SELECT
      n.nspname AS table_schema,
      c.relname AS table_name,
      a.attname AS column_name,
      pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) AS sequence_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname = 'public'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL
  LOOP
    EXECUTE format(
      'SELECT COALESCE(MAX(%I), 0) FROM %I.%I',
      rec.column_name,
      rec.table_schema,
      rec.table_name
    )
    INTO max_value;

    EXECUTE format(
      'SELECT setval(%L::regclass, GREATEST(%s + 1, 1), false)',
      rec.sequence_name,
      max_value
    );
  END LOOP;
END $$;
SQL
}

is_source_locked_repair() {
  local base="$1"
  local current_sha="$2"
  if [ "$base" != "$SOURCE_LOCKED_REPAIR_172" ]; then
    return 1
  fi
  case "$current_sha" in
    ac91ab897c2466bb2ed6bd7cde70d6598fdb0a91a015436603164b06b6dedf94|\
    6df69fb81a161753715ad710e38b2ff4cdf871574c8fa026ed9393c2f89b5434|\
    4218c3eaf983876b53a65760942112b22e020445fd8d4f199dc6f83bd8593744|\
    88e6a096956e145afd88f47cb3feb061c5a265f6f1c6872773e37ef3dd33da5c)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

source_locked_repair_is_applicable() {
  $DPSQL -tAc \
    "SELECT EXISTS(SELECT 1 FROM public.transactions WHERE id = '$SOURCE_LOCKED_REPAIR_172_TRANSACTION_ID'::uuid);" \
    | tr -d '[:space:]'
}

record_migration() {
  local base="$1"
  local current_sha="$2"
  $DPSQL -v ON_ERROR_STOP=1 -c \
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

  if is_source_locked_repair "$base" "$current_sha" \
    && [ "$(source_locked_repair_is_applicable)" != "t" ]; then
    echo "Skip (source-locked repair not applicable): $base"
    record_migration "$base" "$current_sha"
    continue
  fi

  echo "Applying $base to $RIVERSIDE_DB_NAME"
  repair_public_serial_sequences
  $DPSQL -v ON_ERROR_STOP=1 < "$f"
  if [ "$(ledger_exists)" != "t" ]; then
    echo "Migration $base did not create public.ros_schema_migrations; cannot record ledger state." >&2
    exit 1
  fi
  ensure_checksum_column
  record_migration "$base" "$current_sha"
done

echo ""
if [ "$DRIFT_COUNT" -gt 0 ]; then
  echo "⚠ $DRIFT_COUNT migration file(s) have changed since they were applied."
  echo "  Create a new numbered migration to add any missing schema changes."
else
  echo "✓ No drift detected. All checksums match."
fi
echo "Done. Ledger: SELECT version, file_sha256 FROM ros_schema_migrations ORDER BY version; — status: ./scripts/migration-status-docker.sh"
