#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SQL_FILE="$ROOT_DIR/scripts/counterpoint_real_data_test_run_audit.sql"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required. Point it at the staging clone, not production." >&2
  exit 2
fi

AUDIT_DATE="${AUDIT_DATE:-$(date +%F)}"
OUTPUT_PATH="${OUTPUT_PATH:-}"

if [[ ! "$AUDIT_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "AUDIT_DATE must be YYYY-MM-DD; got: $AUDIT_DATE" >&2
  exit 2
fi

run_psql() {
  PGOPTIONS="${PGOPTIONS:+$PGOPTIONS }-c default_transaction_read_only=on" \
    psql "$DATABASE_URL" \
      --no-psqlrc \
      --set ON_ERROR_STOP=1 \
      --set "audit_date=$AUDIT_DATE" \
      --file "$SQL_FILE"
}

if [[ -n "$OUTPUT_PATH" ]]; then
  mkdir -p "$(dirname "$OUTPUT_PATH")"
  run_psql > "$OUTPUT_PATH"
  echo "Wrote Counterpoint real-data test run evidence to $OUTPUT_PATH"
else
  run_psql
fi
