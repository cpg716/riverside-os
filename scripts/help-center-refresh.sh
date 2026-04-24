#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

AUTO_BOOT=1
RUN_AIDOCS_CHECK=1
RUN_SCREENSHOTS=1
RUN_GENERATE_HELP=1
RUN_REINDEX=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-auto-boot)
      AUTO_BOOT=0
      ;;
    --skip-aidocs-check)
      RUN_AIDOCS_CHECK=0
      ;;
    --skip-screenshots)
      RUN_SCREENSHOTS=0
      ;;
    --skip-generate-help)
      RUN_GENERATE_HELP=0
      ;;
    --reindex-search)
      RUN_REINDEX=1
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
  shift
done

export E2E_BASE_URL="${E2E_BASE_URL:-http://localhost:43173}"
export E2E_API_BASE="${E2E_API_BASE:-http://127.0.0.1:43300}"
export E2E_BO_STAFF_CODE="${E2E_BO_STAFF_CODE:-1234}"
export E2E_BO_STAFF_PIN="${E2E_BO_STAFF_PIN:-1234}"

STACK_PID=""
STACK_LOG=""

cleanup() {
  if [[ -n "${STACK_PID}" ]]; then
    kill "${STACK_PID}" >/dev/null 2>&1 || true
    wait "${STACK_PID}" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

wait_for_url() {
  local url="$1"
  local name="$2"
  local tries="${3:-90}"
  for ((i = 1; i <= tries; i += 1)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "[help-center-refresh] ${name} ready: ${url}"
      return 0
    fi
    sleep 1
  done
  echo "[help-center-refresh] Timed out waiting for ${name}: ${url}" >&2
  if [[ -n "${STACK_LOG}" && -f "${STACK_LOG}" ]]; then
    echo "--- stack log ---" >&2
    tail -n 200 "${STACK_LOG}" >&2 || true
  fi
  return 1
}

if [[ "${AUTO_BOOT}" == "1" ]]; then
  if ! curl -fsS "${E2E_API_BASE}/api/staff/list-for-pos" >/dev/null 2>&1 || ! curl -fsS "${E2E_BASE_URL}" >/dev/null 2>&1; then
    STACK_LOG="$(mktemp -t riverside-help-refresh.XXXXXX.log)"
    echo "[help-center-refresh] Starting local E2E stack..."
    npm run dev:e2e:stack >"${STACK_LOG}" 2>&1 &
    STACK_PID="$!"
    wait_for_url "${E2E_API_BASE}/api/staff/list-for-pos" "API"
    wait_for_url "${E2E_BASE_URL}" "UI"
  else
    echo "[help-center-refresh] Reusing running UI/API."
  fi
fi

if [[ "${RUN_AIDOCS_CHECK}" == "1" ]]; then
  if command -v uv >/dev/null 2>&1; then
    echo "[help-center-refresh] Running aidocs check..."
    uvx --from aidocs aidocs check || true
  else
    echo "[help-center-refresh] uv not found; skipping aidocs check."
  fi
fi

if [[ "${RUN_SCREENSHOTS}" == "1" ]]; then
  echo "[help-center-refresh] Capturing Help screenshots..."
  (
    cd client
    npm run generate:help:screenshots -- \
      --base-url "${E2E_BASE_URL}" \
      --api-base "${E2E_API_BASE}" \
      --staff-code "${E2E_BO_STAFF_CODE}" \
      --staff-pin "${E2E_BO_STAFF_PIN}"
  )
fi

if [[ "${RUN_GENERATE_HELP}" == "1" ]]; then
  echo "[help-center-refresh] Regenerating Help manifests..."
  npm run generate:help
fi

if [[ "${RUN_REINDEX}" == "1" ]]; then
  echo "[help-center-refresh] Reindexing Help search..."
  curl -fsS -X POST "${E2E_API_BASE}/api/help/admin/ops/reindex-search" \
    -H "x-riverside-staff-code: ${E2E_BO_STAFF_CODE}" \
    -H "x-riverside-staff-pin: ${E2E_BO_STAFF_PIN}" \
    -H "Content-Type: application/json" \
    -d '{"full_reindex_fallback":true}'
  echo
fi

echo "[help-center-refresh] Done."
