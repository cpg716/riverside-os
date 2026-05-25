#!/usr/bin/env bash
# import-integration-credentials.sh
#
# Imports integration_credentials into a target database.
# Requires the same RIVERSIDE_CREDENTIALS_KEY on both source and target.
#
# Usage:
#   export DATABASE_URL="postgres://user:pass@prod-host:5432/riverside_os"
#   bash scripts/import-integration-credentials.sh riverside-credentials.pgsql
#
# The script truncates the existing integration_credentials table before import
# to avoid duplicate-key conflicts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DUMP_FILE="${1:-}"
DB_URL="${DATABASE_URL:-}"

if [[ -z "$DUMP_FILE" ]] || [[ ! -f "$DUMP_FILE" ]]; then
  echo "Usage: $0 <dump-file.pgsql>" >&2
  echo "   or: DATABASE_URL=<url> $0 <dump-file.pgsql>" >&2
  exit 1
fi

if [[ -z "$DB_URL" ]]; then
  echo "DATABASE_URL must be set." >&2
  exit 1
fi

echo "==> Clearing existing integration_credentials on target..." >&2
psql "$DB_URL" -c "TRUNCATE TABLE integration_credentials;" >&2

echo "==> Importing $(wc -l < "$DUMP_FILE") lines from $DUMP_FILE..." >&2
psql "$DB_URL" < "$DUMP_FILE"

echo "==> Verifying import..." >&2
COUNT=$(psql "$DB_URL" -t -c "SELECT count(*) FROM integration_credentials;" | xargs)
echo "==> $COUNT credential rows restored." >&2

if [[ "$COUNT" -eq 0 ]]; then
  echo "WARNING: 0 rows imported. Check the dump file and target connection." >&2
  exit 1
fi

echo "==> Done. Restart the Riverside OS server to load credentials." >&2
