#!/usr/bin/env bash
# Prove that the local sandbox PostgreSQL database can be dumped and restored.
# This script accepts only known local/test modes and refuses production.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SOURCE_DB="${RIVERSIDE_DB_NAME:-riverside_os}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
TARGET_DB="riverside_restore_drill_${STAMP}_$$"
DUMP_FILE="$(mktemp "${TMPDIR:-/tmp}/riverside-restore-drill.XXXXXX.dump")"

PSQL=(docker compose exec -T db psql -X -v ON_ERROR_STOP=1 -U postgres)

cleanup() {
  "${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS \"${TARGET_DB}\" WITH (FORCE);" >/dev/null 2>&1 || true
  rm -f "$DUMP_FILE"
}
trap cleanup EXIT

docker compose up -d db >/dev/null

if [[ ! "$SOURCE_DB" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "Refusing unsafe source database name: $SOURCE_DB" >&2
  exit 1
fi

SOURCE_MODE="$("${PSQL[@]}" -d "$SOURCE_DB" -tAc \
  "SELECT COALESCE(environment_mode, '') FROM store_settings WHERE id = 1;" | tr -d '[:space:]')"
case "$SOURCE_MODE" in
  development|test|e2e|sandbox) ;;
  *)
    echo "Refusing restore drill: source database mode is '${SOURCE_MODE:-unknown}', not development/test/e2e/sandbox." >&2
    exit 1
    ;;
esac

echo "Creating compressed dump from local ${SOURCE_MODE} database '${SOURCE_DB}'..."
docker compose exec -T db pg_dump -U postgres -d "$SOURCE_DB" -Fc --no-owner --no-privileges >"$DUMP_FILE"

if [[ ! -s "$DUMP_FILE" ]]; then
  echo "Backup dump is empty." >&2
  exit 1
fi
docker compose exec -T db pg_restore --list <"$DUMP_FILE" >/dev/null

SOURCE_LEDGER="$("${PSQL[@]}" -d "$SOURCE_DB" -tAc \
  "SELECT version || '|' || COALESCE(file_sha256, '') FROM ros_schema_migrations ORDER BY version;")"
SOURCE_COUNTS="$("${PSQL[@]}" -d "$SOURCE_DB" -tAc \
  "SELECT (SELECT COUNT(*) FROM transactions) || '|' ||
          (SELECT COUNT(*) FROM products) || '|' ||
          (SELECT COUNT(*) FROM product_variants) || '|' ||
          (SELECT COUNT(*) FROM customers) || '|' ||
          (SELECT COUNT(*) FROM staff);")"

"${PSQL[@]}" -d postgres -c "CREATE DATABASE \"${TARGET_DB}\";" >/dev/null
docker compose exec -T db pg_restore -U postgres -d "$TARGET_DB" \
  --exit-on-error --single-transaction --no-owner --no-privileges <"$DUMP_FILE"

RESTORED_MODE="$("${PSQL[@]}" -d "$TARGET_DB" -tAc \
  "SELECT COALESCE(environment_mode, '') FROM store_settings WHERE id = 1;" | tr -d '[:space:]')"
RESTORED_LEDGER="$("${PSQL[@]}" -d "$TARGET_DB" -tAc \
  "SELECT version || '|' || COALESCE(file_sha256, '') FROM ros_schema_migrations ORDER BY version;")"
RESTORED_COUNTS="$("${PSQL[@]}" -d "$TARGET_DB" -tAc \
  "SELECT (SELECT COUNT(*) FROM transactions) || '|' ||
          (SELECT COUNT(*) FROM products) || '|' ||
          (SELECT COUNT(*) FROM product_variants) || '|' ||
          (SELECT COUNT(*) FROM customers) || '|' ||
          (SELECT COUNT(*) FROM staff);")"

if [[ "$RESTORED_MODE" != "$SOURCE_MODE" ]]; then
  echo "Restore validation failed: environment mode changed from '$SOURCE_MODE' to '$RESTORED_MODE'." >&2
  exit 1
fi
if [[ "$RESTORED_LEDGER" != "$SOURCE_LEDGER" ]]; then
  echo "Restore validation failed: migration ledger or checksums differ from the source database." >&2
  exit 1
fi
if [[ "$RESTORED_COUNTS" != "$SOURCE_COUNTS" ]]; then
  echo "Restore validation failed: core table counts differ (source=$SOURCE_COUNTS restored=$RESTORED_COUNTS)." >&2
  exit 1
fi

DUMP_BYTES="$(wc -c <"$DUMP_FILE" | tr -d '[:space:]')"
LATEST_MIGRATION="$(printf '%s\n' "$RESTORED_LEDGER" | tail -n 1 | cut -d'|' -f1)"
echo "Restore drill passed: dump_bytes=${DUMP_BYTES}, restored_database=${TARGET_DB}, latest_migration=${LATEST_MIGRATION}, core_counts=${RESTORED_COUNTS}."
