#!/usr/bin/env bash
# export-integration-credentials.sh
#
# Dumps the integration_credentials table (encrypted API keys, tokens, secrets)
# from a source database for transfer to another environment.
#
# Usage:
#   export DATABASE_URL="postgres://user:pass@dev-host:5432/riverside_os"
#   bash scripts/export-integration-credentials.sh > riverside-credentials.pgsql
#
#   # Or explicitly:
#   bash scripts/export-integration-credentials.sh "postgres://user:pass@dev:5432/riverside_os" > creds.pgsql
#
#   # Write directly to repo root file (for git commit):
#   bash scripts/export-integration-credentials.sh [database-url] [integration-credentials.sql]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DB_URL="${1:-${DATABASE_URL:-}}"
OUT_FILE="${2:-$ROOT_DIR/integration-credentials.sql}"

if [[ -z "$DB_URL" ]]; then
  echo "Usage: $0 <database-url> [outfile]" >&2
  echo "   or: DATABASE_URL=<url> $0 [outfile]" >&2
  echo "   Default outfile: $ROOT_DIR/integration-credentials.sql" >&2
  exit 1
fi

echo "-- Riverside OS Integration Credentials Export" >&2
echo "-- Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
echo "-- Source: ${DB_URL%%:*}://***@***" >&2
echo "-- Destination: $OUT_FILE" >&2
echo "" >&2

pg_dump \
  --data-only \
  --table=integration_credentials \
  --no-owner \
  --no-privileges \
  --column-inserts \
  "$DB_URL" > "$OUT_FILE"

echo "-- Export complete: $OUT_FILE" >&2
