#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "e2e-local-stack.sh: docker is required for the local Playwright DB stack." >&2
  exit 1
fi

E2E_DB_NAME="riverside_os_e2e"
export RIVERSIDE_MODE="e2e"
export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:password@localhost:5433/$E2E_DB_NAME}"
export E2E_API_BASE="${E2E_API_BASE:-http://127.0.0.1:43300}"
export E2E_BASE_URL="${E2E_BASE_URL:-http://localhost:43173}"
export E2E_CORECARD_BASE="${E2E_CORECARD_BASE:-http://127.0.0.1:43400}"
export E2E_CORECARD_PORT="${E2E_CORECARD_PORT:-43400}"

export RIVERSIDE_ENABLE_E2E_TEST_SUPPORT="${RIVERSIDE_ENABLE_E2E_TEST_SUPPORT:-1}"
export RIVERSIDE_CORECARD_BASE_URL="${RIVERSIDE_CORECARD_BASE_URL:-$E2E_CORECARD_BASE}"
export RIVERSIDE_CORECARD_CLIENT_ID="${RIVERSIDE_CORECARD_CLIENT_ID:-e2e-client}"
export RIVERSIDE_CORECARD_CLIENT_SECRET="${RIVERSIDE_CORECARD_CLIENT_SECRET:-e2e-secret}"
export RIVERSIDE_CORECARD_REGION="${RIVERSIDE_CORECARD_REGION:-us}"
export RIVERSIDE_CORECARD_ENVIRONMENT="${RIVERSIDE_CORECARD_ENVIRONMENT:-e2e}"
export RIVERSIDE_CORECARD_TIMEOUT_SECS="${RIVERSIDE_CORECARD_TIMEOUT_SECS:-5}"
export RIVERSIDE_CORECARD_REDACTION="${RIVERSIDE_CORECARD_REDACTION:-strict}"
export RIVERSIDE_CORECARD_LOG_PAYLOADS="${RIVERSIDE_CORECARD_LOG_PAYLOADS:-false}"
export RIVERSIDE_CORECARD_WEBHOOK_SECRET="${RIVERSIDE_CORECARD_WEBHOOK_SECRET:-e2e-corecard-webhook}"
export RIVERSIDE_CORECARD_WEBHOOK_ALLOW_UNSIGNED="${RIVERSIDE_CORECARD_WEBHOOK_ALLOW_UNSIGNED:-false}"
export RIVERSIDE_CORECARD_REPAIR_POLL_SECS="${RIVERSIDE_CORECARD_REPAIR_POLL_SECS:-3600}"
export RIVERSIDE_CORECARD_SNAPSHOT_RETENTION_DAYS="${RIVERSIDE_CORECARD_SNAPSHOT_RETENTION_DAYS:-30}"

api_bind="${E2E_API_BASE#http://}"
api_bind="${api_bind#https://}"
api_bind="${api_bind%%/*}"
export RIVERSIDE_HTTP_BIND="${RIVERSIDE_HTTP_BIND:-$api_bind}"

ui_host_port="${E2E_BASE_URL#http://}"
ui_host_port="${ui_host_port#https://}"
ui_host_port="${ui_host_port%%/*}"
ui_host="${ui_host_port%:*}"
ui_port="${ui_host_port##*:}"

docker compose up -d db

# Ensure isolated E2E database exists
echo "Ensuring E2E database $E2E_DB_NAME exists..."
docker compose exec -T db psql -U postgres -c "SELECT 1 FROM pg_database WHERE datname = '$E2E_DB_NAME'" | grep -q 1 || \
docker compose exec -T db psql -U postgres -c "CREATE DATABASE $E2E_DB_NAME"

export RIVERSIDE_DB_NAME="$E2E_DB_NAME"
"$ROOT/scripts/apply-migrations-docker.sh"

docker compose exec -T db psql -U postgres -d "$E2E_DB_NAME" -v ON_ERROR_STOP=1 < "$ROOT/scripts/seed_staff_register_test.sql"
docker compose exec -T db psql -U postgres -d "$E2E_DB_NAME" -v ON_ERROR_STOP=1 < "$ROOT/scripts/seed_e2e_non_admin_staff.sql"
docker compose exec -T db psql -U postgres -d "$E2E_DB_NAME" -v ON_ERROR_STOP=1 < "$ROOT/scripts/seed_e2e_rms_staff.sql"

exec npx concurrently -k -s first -n api,ui,corecard -c blue,magenta,cyan \
  "npm run dev:server" \
  "cd client && VITE_DEV_PROXY_TARGET=$E2E_API_BASE npm run dev -- --host $ui_host --port $ui_port --strictPort" \
  "node scripts/fake-corecard-server.mjs"
