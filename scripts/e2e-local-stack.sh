#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "e2e-local-stack.sh: docker is required for the local Playwright DB stack." >&2
  exit 1
fi

E2E_DB_NAME="${E2E_DB_NAME:-riverside_os_e2e}"
if [[ ! "$E2E_DB_NAME" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  echo "e2e-local-stack.sh: E2E_DB_NAME must be a PostgreSQL identifier." >&2
  exit 1
fi

# Every default local Playwright run resets the same database and owns the same
# API/UI ports. Hold one atomic lock for the full stack lifetime so a second run
# cannot drop the first run's database or kill its listeners during setup.
E2E_LOCK_DIR="${TMPDIR:-/tmp}/riverside-os-e2e-stack.lock"
E2E_LOCK_WAIT_SECONDS="${E2E_LOCK_WAIT_SECONDS:-600}"
if [[ ! "$E2E_LOCK_WAIT_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "e2e-local-stack.sh: E2E_LOCK_WAIT_SECONDS must be a non-negative integer." >&2
  exit 1
fi

release_e2e_lock() {
  if [[ -f "$E2E_LOCK_DIR/pid" ]] && [[ "$(<"$E2E_LOCK_DIR/pid")" == "$$" ]]; then
    rm -f "$E2E_LOCK_DIR/pid"
    rmdir "$E2E_LOCK_DIR" 2>/dev/null || true
  fi
}

lock_deadline=$(( $(date +%s) + E2E_LOCK_WAIT_SECONDS ))
while ! mkdir "$E2E_LOCK_DIR" 2>/dev/null; do
  lock_owner=""
  if [[ -f "$E2E_LOCK_DIR/pid" ]]; then
    lock_owner="$(<"$E2E_LOCK_DIR/pid")"
  fi
  if [[ -z "$lock_owner" ]] || ! kill -0 "$lock_owner" 2>/dev/null; then
    rm -f "$E2E_LOCK_DIR/pid"
    rmdir "$E2E_LOCK_DIR" 2>/dev/null || true
    continue
  fi
  if (( $(date +%s) >= lock_deadline )); then
    echo "e2e-local-stack.sh: timed out waiting for active E2E stack process $lock_owner." >&2
    exit 1
  fi
  echo "Waiting for active E2E stack process $lock_owner to finish..."
  sleep 1
done
printf '%s\n' "$$" > "$E2E_LOCK_DIR/pid"
trap release_e2e_lock EXIT INT TERM

export RIVERSIDE_MODE="e2e"
export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:password@localhost:5433/$E2E_DB_NAME}"
export RIVERSIDE_BACKUP_ALLOW_DOCKER_FALLBACK="${RIVERSIDE_BACKUP_ALLOW_DOCKER_FALLBACK:-1}"
export E2E_API_BASE="${E2E_API_BASE:-http://127.0.0.1:43300}"
export E2E_BASE_URL="${E2E_BASE_URL:-http://localhost:43173}"
export RIVERSIDE_ENABLE_E2E_TEST_SUPPORT="${RIVERSIDE_ENABLE_E2E_TEST_SUPPORT:-1}"
export E2E_ALLOW_REGISTER_RESET="${E2E_ALLOW_REGISTER_RESET:-1}"
# The deterministic E2E database must never rebuild or incrementally update the
# developer/production Meilisearch indexes loaded from server/.env.
export RIVERSIDE_MEILISEARCH_URL=""
export RIVERSIDE_MEILISEARCH_DAILY_REINDEX_ENABLED="0"
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

npx concurrently -k -s first -n api,ui -c blue,magenta \
  "npm run dev:server" \
  "cd client && VITE_DEV_PROXY_TARGET=$E2E_API_BASE npm run dev -- --host $ui_host --port $ui_port --strictPort"
