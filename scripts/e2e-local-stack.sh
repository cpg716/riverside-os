#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "e2e-local-stack.sh: docker is required for the local Playwright DB stack." >&2
  exit 1
fi

export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:password@localhost:5433/riverside_os}"
export E2E_API_BASE="${E2E_API_BASE:-http://127.0.0.1:43300}"
export E2E_BASE_URL="${E2E_BASE_URL:-http://localhost:43173}"

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
"$ROOT/scripts/apply-migrations-docker.sh"
docker compose exec -T db psql -U postgres -d riverside_os -v ON_ERROR_STOP=1 < "$ROOT/scripts/seed_staff_register_test.sql"
docker compose exec -T db psql -U postgres -d riverside_os -v ON_ERROR_STOP=1 < "$ROOT/scripts/seed_e2e_non_admin_staff.sql"

exec npx concurrently -k -s first -n api,ui -c blue,magenta \
  "npm run dev:server" \
  "npx wait-on -t 600000 tcp:$api_bind && cd client && VITE_DEV_PROXY_TARGET=$E2E_API_BASE npm run dev -- --host $ui_host --port $ui_port --strictPort"
