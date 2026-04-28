#!/usr/bin/env bash
# cleanup-e2e-pollution.sh
# Purge E2E test data from the primary development database.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DB_URL="${DATABASE_URL:-postgresql://postgres:password@localhost:5433/riverside_os}"

echo "Cleaning up E2E data from $DB_URL..."
psql "$DB_URL" -f "$ROOT/scripts/cleanup-e2e-pollution.sql"
echo "Cleanup complete."
