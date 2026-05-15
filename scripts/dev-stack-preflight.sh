#!/usr/bin/env bash
set -euo pipefail

PORTS=(3000 3002 5173)
SERVER_ENV="$(cd "$(dirname "$0")/.." && pwd)/server/.env"
HELCIM_TUNNEL_AGENT="$HOME/Library/LaunchAgents/com.cloudflare.riverside-helcim.plist"
HELCIM_TUNNEL_LABEL="com.cloudflare.riverside-helcim"

reclaim_port() {
  local port="$1"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    return 0
  fi

  echo "[dev-preflight] reclaiming port ${port} from existing listener(s): ${pids}"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true

  for _ in {1..20}; do
    if ! lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done

  local remaining
  remaining="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$remaining" ]]; then
    echo "[dev-preflight] force stopping stubborn listener(s) on port ${port}: ${remaining}"
    # shellcheck disable=SC2086
    kill -9 $remaining 2>/dev/null || true
  fi
}

database_url() {
  if [[ -n "${DATABASE_URL:-}" ]]; then
    printf '%s\n' "$DATABASE_URL"
    return 0
  fi

  if [[ ! -f "$SERVER_ENV" ]]; then
    return 0
  fi

  local raw
  raw="$(grep -E "^DATABASE_URL=" "$SERVER_ENV" | tail -n 1 || true)"
  if [[ -z "$raw" ]]; then
    return 0
  fi

  local value="${raw#*=}"
  if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s\n' "$value"
}

check_database_ready() {
  local url
  url="$(database_url)"
  if [[ -z "$url" ]]; then
    return 0
  fi

  local endpoint
  endpoint="$(DATABASE_URL="$url" node -e '
const raw = process.env.DATABASE_URL;
try {
  const parsed = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) process.exit(0);
  const port = parsed.port || "5432";
  process.stdout.write(`${parsed.hostname} ${port}`);
} catch {
  process.exit(0);
}
' 2>/dev/null || true)"
  if [[ -z "$endpoint" ]]; then
    return 0
  fi

  local host port
  read -r host port <<< "$endpoint"
  if nc -z "$host" "$port" >/dev/null 2>&1; then
    return 0
  fi

  echo "[dev-preflight] PostgreSQL is not reachable at ${host}:${port} from DATABASE_URL." >&2
  echo "[dev-preflight] Start or wake the local Docker/OrbStack engine, then run: npm run docker:db" >&2
  echo "[dev-preflight] For a fresh database, also run: ./scripts/apply-migrations-docker.sh" >&2
  exit 1
}

ensure_helcim_tunnel() {
  if [[ ! -f "$HELCIM_TUNNEL_AGENT" ]]; then
    return 0
  fi

  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "[dev-preflight] Helcim Cloudflare tunnel agent exists, but cloudflared is not installed." >&2
    echo "[dev-preflight] Live terminal webhooks will not reach ROS until cloudflared is available." >&2
    return 0
  fi

  local domain="gui/$(id -u)"
  if ! launchctl print "${domain}/${HELCIM_TUNNEL_LABEL}" >/dev/null 2>&1; then
    if ! launchctl bootstrap "$domain" "$HELCIM_TUNNEL_AGENT" >/dev/null 2>&1; then
      echo "[dev-preflight] Could not load Helcim Cloudflare tunnel agent." >&2
      echo "[dev-preflight] Live terminal webhooks may not reach ROS until the tunnel is started." >&2
      return 0
    fi
    launchctl enable "${domain}/${HELCIM_TUNNEL_LABEL}" >/dev/null 2>&1 || true
  fi

  launchctl kickstart -k "${domain}/${HELCIM_TUNNEL_LABEL}" >/dev/null 2>&1 || {
    echo "[dev-preflight] Could not start Helcim Cloudflare tunnel agent." >&2
    echo "[dev-preflight] Live terminal webhooks may not reach ROS until the tunnel is started." >&2
  }
}

for port in "${PORTS[@]}"; do
  reclaim_port "$port"
done

ensure_helcim_tunnel
check_database_ready
