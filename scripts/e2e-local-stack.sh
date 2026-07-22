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
export RIVERSIDE_BACKUP_ALLOW_DOCKER_FALLBACK="${RIVERSIDE_BACKUP_ALLOW_DOCKER_FALLBACK:-1}"
export E2E_API_BASE="${E2E_API_BASE:-http://127.0.0.1:43300}"
export E2E_BASE_URL="${E2E_BASE_URL:-http://localhost:43173}"
export RIVERSIDE_ENABLE_E2E_TEST_SUPPORT="${RIVERSIDE_ENABLE_E2E_TEST_SUPPORT:-1}"
export COUNTERPOINT_SYNC_TOKEN="${COUNTERPOINT_SYNC_TOKEN:-e2e-counterpoint-sync-token}"
export HELCIM_SIMULATOR_ENABLED="${HELCIM_SIMULATOR_ENABLED:-1}"

api_bind="${E2E_API_BASE#http://}"
api_bind="${api_bind#https://}"
api_bind="${api_bind%%/*}"
export RIVERSIDE_HTTP_BIND="${RIVERSIDE_HTTP_BIND:-$api_bind}"

ui_host_port="${E2E_BASE_URL#http://}"
ui_host_port="${ui_host_port#https://}"
ui_host_port="${ui_host_port%%/*}"
ui_host="${ui_host_port%:*}"
ui_port="${ui_host_port##*:}"
api_port="${api_bind##*:}"

cleanup_stale_listener() {
  local port="$1"
  local pids
  local remaining

  if ! command -v lsof >/dev/null 2>&1; then
    echo "e2e-local-stack.sh: lsof not found; skipping stale-listener cleanup for port ${port}." >&2
    return
  fi

  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | tr '\n' ' ' | xargs 2>/dev/null || true)"
  if [[ -z "${pids}" ]]; then
    return
  fi

  echo "Cleaning stale listener(s) on tcp:${port}..."
  lsof -nP -iTCP:"$port" -sTCP:LISTEN || true
  kill ${pids} 2>/dev/null || true
  sleep 1

  remaining="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | tr '\n' ' ' | xargs 2>/dev/null || true)"
  if [[ -n "${remaining}" ]]; then
    echo "Force-killing remaining listener(s) on tcp:${port}..."
    kill -9 ${remaining} 2>/dev/null || true
    sleep 1
  fi

  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "e2e-local-stack.sh: failed to clear listener on tcp:${port}." >&2
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2 || true
    exit 1
  fi
}

cleanup_stale_listener "$ui_port"
cleanup_stale_listener "$api_port"

docker compose up -d db

# Ensure the isolated E2E database starts from a clean fixture state.
if [[ "${E2E_RESET_DB:-1}" == "1" ]]; then
  echo "Resetting E2E database $E2E_DB_NAME..."
  docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS $E2E_DB_NAME WITH (FORCE);" \
    -c "CREATE DATABASE $E2E_DB_NAME"
else
  echo "Ensuring E2E database $E2E_DB_NAME exists..."
  docker compose exec -T db psql -U postgres -c "SELECT 1 FROM pg_database WHERE datname = '$E2E_DB_NAME'" | grep -q 1 || \
  docker compose exec -T db psql -U postgres -c "CREATE DATABASE $E2E_DB_NAME"
fi

export RIVERSIDE_DB_NAME="$E2E_DB_NAME"
"$ROOT/scripts/apply-migrations-docker.sh"

docker compose exec -T db psql -U postgres -d "$E2E_DB_NAME" -v ON_ERROR_STOP=1 < "$ROOT/scripts/seeds/seed_core_required.sql"
docker compose exec -T db psql -U postgres -d "$E2E_DB_NAME" -v ON_ERROR_STOP=1 < "$ROOT/scripts/seeds/seed_rbac.sql"
docker compose exec -T db psql -U postgres -d "$E2E_DB_NAME" -v ON_ERROR_STOP=1 < "$ROOT/scripts/seeds/seed_e2e.sql"

exec npx concurrently -k -s first -n api,ui -c blue,magenta \
  "npm run dev:server" \
  "cd client && VITE_DEV_PROXY_TARGET=$E2E_API_BASE npm run dev -- --host $ui_host --port $ui_port --strictPort"
