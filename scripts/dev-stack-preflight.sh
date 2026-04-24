#!/usr/bin/env bash
set -euo pipefail

PORTS=(3000 3002 5173)

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

for port in "${PORTS[@]}"; do
  reclaim_port "$port"
done
