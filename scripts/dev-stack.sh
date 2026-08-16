#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

bash "$ROOT/scripts/dev-stack-preflight.sh"

# Capture one identity for the whole dev session. The API and Vite start at
# different times, so reading Git independently can create a false mismatch if
# a commit lands while the stack is starting.
if [[ -z "${RIVERSIDE_DEV_BUILD_SHA:-}" ]]; then
  CURRENT_DEV_BUILD_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
  if [[ -n "$CURRENT_DEV_BUILD_SHA" ]]; then
    export RIVERSIDE_DEV_BUILD_SHA="$CURRENT_DEV_BUILD_SHA"
  fi
fi

cd "$ROOT"

if [[ "${1:-}" == "--with-bridge" ]]; then
  exec concurrently -n api,ui,bridge -c blue,magenta,green \
    "npm run dev:server" \
    "npm run dev:client:wait" \
    "npm run dev:bridge"
fi

exec concurrently -n api,ui -c blue,magenta \
  "npm run dev:server" \
  "npm run dev:client:wait"
