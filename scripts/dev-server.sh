#!/usr/bin/env bash
# Ensure rustc 1.88 is used (ort/fastembed). Homebrew rustc 1.86 on PATH breaks the build even when
# server/rust-toolchain.toml requests 1.88 — build scripts invoke `rustc` from PATH.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUSTC_188="$(rustup which rustc --toolchain 1.88 2>/dev/null || true)"
if [[ -z "$RUSTC_188" ]]; then
  echo "dev-server.sh: no toolchain 1.88. Install: rustup toolchain install 1.88" >&2
  exit 1
fi
export PATH="$(dirname "$RUSTC_188"):$PATH"

SERVER_ENV="$ROOT/server/.env"

load_env_default() {
  local key="$1"
  if [[ -n "${!key:-}" ]] || [[ ! -f "$SERVER_ENV" ]]; then
    return 0
  fi
  local raw
  raw="$(grep -E "^${key}=" "$SERVER_ENV" | tail -n 1 || true)"
  if [[ -z "$raw" ]]; then
    return 0
  fi
  local value="${raw#*=}"
  if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
    value="${value:1:${#value}-2}"
  fi
  export "${key}=${value}"
}

is_falsey() {
  case "${1:-}" in
    0|false|FALSE|False|no|NO|off|OFF|disabled|DISABLED|"")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

rosie_arch() {
  case "$(uname -m)" in
    arm64|aarch64)
      printf '%s' "aarch64"
      ;;
    x86_64|amd64)
      printf '%s' "x86_64"
      ;;
    *)
      printf '%s' "$(uname -m)"
      ;;
  esac
}

rosie_platform_suffix() {
  case "$(uname -s)" in
    Darwin)
      printf '%s' "apple-darwin"
      ;;
    Linux)
      printf '%s' "unknown-linux-gnu"
      ;;
    *)
      printf '%s' "unknown"
      ;;
  esac
}

wait_for_rosie_health() {
  local url="$1"
  for _ in {1..90}; do
    if curl -fsS "${url}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

ARCH="$(rosie_arch)"
PLATFORM_SUFFIX="$(rosie_platform_suffix)"
DEFAULT_LLAMA_BIN="$ROOT/client/src-tauri/binaries/llama-server-${ARCH}-${PLATFORM_SUFFIX}"
DEFAULT_LLAMA_MODEL_PATH="$HOME/Library/Application Support/riverside-os/rosie/models/gemma-4-e4b/google_gemma-4-E4B-it-Q4_K_M.gguf"

load_env_default "RIVERSIDE_LLAMA_UPSTREAM"
load_env_default "RIVERSIDE_DEV_AUTOSTART_ROSIE_HOST"
load_env_default "RIVERSIDE_LLAMA_BIN"
load_env_default "RIVERSIDE_LLAMA_MODEL_PATH"
load_env_default "RIVERSIDE_LLAMA_HOST"
load_env_default "RIVERSIDE_LLAMA_PORT"
load_env_default "RIVERSIDE_LLAMA_EXTRA_ARGS"

LLAMA_BIN="${RIVERSIDE_LLAMA_BIN:-$DEFAULT_LLAMA_BIN}"
LLAMA_HOST="${RIVERSIDE_LLAMA_HOST:-127.0.0.1}"
LLAMA_PORT="${RIVERSIDE_LLAMA_PORT:-8080}"
LOCAL_LLAMA_URL="http://${LLAMA_HOST}:${LLAMA_PORT}"
LLAMA_MODEL_PATH="${RIVERSIDE_LLAMA_MODEL_PATH:-$DEFAULT_LLAMA_MODEL_PATH}"
LLAMA_EXTRA_ARGS="${RIVERSIDE_LLAMA_EXTRA_ARGS:-}"
ROSIE_AUTOSTART="${RIVERSIDE_DEV_AUTOSTART_ROSIE_HOST:-1}"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${ROSIE_LLAMA_PID:-}" ]] && kill -0 "$ROSIE_LLAMA_PID" >/dev/null 2>&1; then
    echo "[rosie] stopping local Gemma Host runtime (pid ${ROSIE_LLAMA_PID})"
    kill "$ROSIE_LLAMA_PID" >/dev/null 2>&1 || true
    wait "$ROSIE_LLAMA_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

if [[ -z "${RIVERSIDE_LLAMA_UPSTREAM:-}" ]]; then
  export RIVERSIDE_LLAMA_UPSTREAM="$LOCAL_LLAMA_URL"
fi

if ! is_falsey "$ROSIE_AUTOSTART"; then
  if [[ "$RIVERSIDE_LLAMA_UPSTREAM" == "$LOCAL_LLAMA_URL" ]]; then
    if curl -fsS "${LOCAL_LLAMA_URL}/health" >/dev/null 2>&1; then
      echo "[rosie] using existing local Gemma Host runtime at ${LOCAL_LLAMA_URL}"
    elif [[ ! -x "$LLAMA_BIN" ]]; then
      echo "[rosie] local ROSIE Host runtime not started: missing llama-server binary at ${LLAMA_BIN}" >&2
    elif [[ ! -f "$LLAMA_MODEL_PATH" ]]; then
      echo "[rosie] local ROSIE Host runtime not started: missing Gemma model at ${LLAMA_MODEL_PATH}" >&2
    else
      echo "[rosie] starting local Gemma Host runtime at ${LOCAL_LLAMA_URL}"
      LLAMA_CMD=(
        "$LLAMA_BIN"
        -m "$LLAMA_MODEL_PATH"
        --host "$LLAMA_HOST"
        --port "$LLAMA_PORT"
      )
      if [[ -n "$LLAMA_EXTRA_ARGS" ]]; then
        # shellcheck disable=SC2206
        EXTRA_ARGS=( $LLAMA_EXTRA_ARGS )
        LLAMA_CMD+=("${EXTRA_ARGS[@]}")
      fi
      "${LLAMA_CMD[@]}" &
      ROSIE_LLAMA_PID="$!"
      if wait_for_rosie_health "$LOCAL_LLAMA_URL"; then
        echo "[rosie] local Gemma Host runtime ready at ${LOCAL_LLAMA_URL}"
      else
        echo "[rosie] local Gemma Host runtime failed to become healthy at ${LOCAL_LLAMA_URL}" >&2
      fi
    fi
  else
    echo "[rosie] respecting explicit RIVERSIDE_LLAMA_UPSTREAM=${RIVERSIDE_LLAMA_UPSTREAM}"
  fi
else
  echo "[rosie] local ROSIE Host autostart disabled (RIVERSIDE_DEV_AUTOSTART_ROSIE_HOST=${ROSIE_AUTOSTART})"
fi

cd "$ROOT/server"
cargo run "$@" &
SERVER_PID="$!"
wait "$SERVER_PID"
