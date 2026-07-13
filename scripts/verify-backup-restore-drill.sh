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

"${PSQL[@]}" -d postgres -c "CREATE DATABASE \"${TARGET_DB}\";" >/dev/null
docker compose exec -T db pg_restore -U postgres -d "$TARGET_DB" \
  --exit-on-error --no-owner --no-privileges <"$DUMP_FILE"

RESTORED_MODE="$("${PSQL[@]}" -d "$TARGET_DB" -tAc \
  "SELECT COALESCE(environment_mode, '') FROM store_settings WHERE id = 1;" | tr -d '[:space:]')"
LATEST_MIGRATION="$("${PSQL[@]}" -d "$TARGET_DB" -tAc \
  "SELECT version FROM ros_schema_migrations ORDER BY regexp_replace(version, '[^0-9].*$', '')::int DESC LIMIT 1;" | tr -d '[:space:]')"

"${PSQL[@]}" -d "$TARGET_DB" -tAc \
  "SELECT COUNT(*) FROM transactions; SELECT COUNT(*) FROM products; SELECT COUNT(*) FROM staff;" >/dev/null

if [[ "$RESTORED_MODE" != "$SOURCE_MODE" ]]; then
  echo "Restore validation failed: environment mode changed from '$SOURCE_MODE' to '$RESTORED_MODE'." >&2
  exit 1
fi
if [[ "$LATEST_MIGRATION" != 125_* ]]; then
  echo "Restore validation failed: expected migration 125, found '${LATEST_MIGRATION:-none}'." >&2
  exit 1
fi

DUMP_BYTES="$(wc -c <"$DUMP_FILE" | tr -d '[:space:]')"
echo "Restore drill passed: dump_bytes=${DUMP_BYTES}, restored_database=${TARGET_DB}, latest_migration=${LATEST_MIGRATION}."
