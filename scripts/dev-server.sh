#!/usr/bin/env bash
# Ensure rustc 1.91 is used (ort/fastembed). Homebrew rustc 1.86 on PATH breaks the build even when
# server/rust-toolchain.toml requests 1.91 — build scripts invoke `rustc` from PATH.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUSTC_191="$(rustup which rustc --toolchain 1.91 2>/dev/null || true)"
if [[ -z "$RUSTC_191" ]]; then
  echo "dev-server.sh: no toolchain 1.91. Install: rustup toolchain install 1.91" >&2
  exit 1
fi
export PATH="$(dirname "$RUSTC_191"):$PATH"

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
load_env_default "RIVERSIDE_LLAMA_PROVIDER"
load_env_default "ROSIE_PROVIDER"
load_env_default "ROSIE_PROVIDER_MODE"
load_env_default "ROSIE_REMOTE_LMSTUDIO_BASE_URL"
load_env_default "RIVERSIDE_DEV_AUTOSTART_ROSIE_HOST"
load_env_default "RIVERSIDE_LLAMA_BIN"
load_env_default "RIVERSIDE_LLAMA_MODEL_PATH"
load_env_default "RIVERSIDE_LLAMA_HOST"
load_env_default "RIVERSIDE_LLAMA_PORT"
load_env_default "RIVERSIDE_LLAMA_EXTRA_ARGS"
load_env_default "RIVERSIDE_LLAMA_PERF_PROFILE"
load_env_default "RIVERSIDE_DEV_ROSIE_HOST_LOG_LEVEL"

LLAMA_BIN="${RIVERSIDE_LLAMA_BIN:-$DEFAULT_LLAMA_BIN}"
LLAMA_HOST="${RIVERSIDE_LLAMA_HOST:-127.0.0.1}"
LLAMA_PORT="${RIVERSIDE_LLAMA_PORT:-8080}"
LOCAL_LLAMA_URL="http://${LLAMA_HOST}:${LLAMA_PORT}"
LLAMA_MODEL_PATH="${RIVERSIDE_LLAMA_MODEL_PATH:-$DEFAULT_LLAMA_MODEL_PATH}"
LLAMA_EXTRA_ARGS="${RIVERSIDE_LLAMA_EXTRA_ARGS:---reasoning off}"
ROSIE_HOST_LOG_LEVEL="${RIVERSIDE_DEV_ROSIE_HOST_LOG_LEVEL:-quiet}"
DEFAULT_LLAMA_PERF_PROFILE="intel-i9-12900"
if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]; then
  DEFAULT_LLAMA_PERF_PROFILE="apple-m3-pro"
fi
LLAMA_PERF_PROFILE="${RIVERSIDE_LLAMA_PERF_PROFILE:-$DEFAULT_LLAMA_PERF_PROFILE}"
if [[ "$LLAMA_PERF_PROFILE" == "auto" ]]; then
  LLAMA_PERF_PROFILE="$DEFAULT_LLAMA_PERF_PROFILE"
fi
case "$LLAMA_PERF_PROFILE" in
  intel-i9-12900|i9-12900|12900)
    LLAMA_PERF_PROFILE="intel-i9-12900"
    LLAMA_ENFORCED_ARGS=(--threads 8 --threads-batch 8 --cpu-mask 0xFFFF --cpu-mask-batch 0xFFFF --cpu-strict 1 --cpu-strict-batch 1 --gpu-layers 0 --device none --flash-attn on --mmap --mlock)
    ;;
  minisforum-v3|amd-8840u|ryzen-8840u)
    LLAMA_PERF_PROFILE="minisforum-v3"
    LLAMA_ENFORCED_ARGS=(--threads 8 --threads-batch 8 --cpu-mask 0xFFFF --cpu-mask-batch 0xFFFF --cpu-strict 1 --cpu-strict-batch 1 --gpu-layers 0 --device none --flash-attn on --mmap --mlock)
    ;;
  apple-m3-pro|m3-pro)
    LLAMA_PERF_PROFILE="apple-m3-pro"
    LLAMA_ENFORCED_ARGS=(--threads 6 --threads-batch 6 --gpu-layers 99 --flash-attn on --mmap)
    ;;
  apple-m3-pro-cpu|m3-pro-cpu)
    LLAMA_PERF_PROFILE="apple-m3-pro-cpu"
    LLAMA_ENFORCED_ARGS=(--threads 6 --threads-batch 6 --gpu-layers 0 --device none --flash-attn on --mmap)
    ;;
  portable-cpu|cpu-portable)
    LLAMA_PERF_PROFILE="portable-cpu"
    LLAMA_ENFORCED_ARGS=(--threads 6 --threads-batch 6 --gpu-layers 0 --device none --flash-attn on --mmap)
    ;;
  *)
    echo "[rosie] unknown RIVERSIDE_LLAMA_PERF_PROFILE=${LLAMA_PERF_PROFILE}" >&2
    exit 1
    ;;
esac
if [[ ! "${LLAMA_ENFORCED_ARGS[*]:-}" ]]; then
  LLAMA_ENFORCED_ARGS=(--threads 8 --threads-batch 8 --cpu-mask 0xFFFF --cpu-mask-batch 0xFFFF --cpu-strict 1 --cpu-strict-batch 1 --gpu-layers 0 --device none --flash-attn on --mmap --mlock)
fi
ROSIE_AUTOSTART="${RIVERSIDE_DEV_AUTOSTART_ROSIE_HOST:-1}"

rosie_selected_provider() {
  local raw="${ROSIE_PROVIDER:-${ROSIE_PROVIDER_MODE:-${RIVERSIDE_LLAMA_PROVIDER:-local_llm}}}"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  case "$raw" in
    local|local-gemma|local_gemma|local-llm|local_llm|llama.cpp)
      printf '%s' "local_llm"
      ;;
    auto)
      printf '%s' "auto"
      ;;
    remote-lmstudio|remote_lmstudio|lmstudio|lmstudio-remote|lmstudio_remote)
      printf '%s' "remote_lmstudio"
      ;;
    openai|openai-api|cloud-openai|cloud_openai)
      printf '%s' "openai"
      ;;
    gemini|gemini-api|gemini_api)
      printf '%s' "gemini"
      ;;
    *)
      printf '%s' "local_llm"
      ;;
  esac
}

ROSIE_SELECTED_PROVIDER="$(rosie_selected_provider)"

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

rosie_log_dir() {
  printf '%s' "${RIVERSIDE_DEV_ROSIE_LOG_DIR:-$ROOT/.tmp/rosie}"
}

start_rosie_host() {
  local log_dir
  log_dir="$(rosie_log_dir)"
  mkdir -p "$log_dir"
  if [[ "$ROSIE_HOST_LOG_LEVEL" == "verbose" ]]; then
    "${LLAMA_CMD[@]}" &
  else
    local stdout_log="$log_dir/llama-server.stdout.log"
    local stderr_log="$log_dir/llama-server.stderr.log"
    : >"$stdout_log"
    : >"$stderr_log"
    echo "[rosie] Gemma Host logs: ${stdout_log} / ${stderr_log}"
    "${LLAMA_CMD[@]}" >"$stdout_log" 2>"$stderr_log" &
  fi
  ROSIE_LLAMA_PID="$!"
}

if [[ -z "${RIVERSIDE_LLAMA_UPSTREAM:-}" && ( "$ROSIE_SELECTED_PROVIDER" == "local_llm" || "$ROSIE_SELECTED_PROVIDER" == "auto" ) ]]; then
  export RIVERSIDE_LLAMA_UPSTREAM="$LOCAL_LLAMA_URL"
fi

# `npm run dev` is a local non-production path. Keep production startup strict,
# but do not make developers discover this flag after a successful compile.
: "${RIVERSIDE_APPLY_PENDING_MIGRATIONS_ON_STARTUP:=true}"
export RIVERSIDE_APPLY_PENDING_MIGRATIONS_ON_STARTUP

if ! is_falsey "$ROSIE_AUTOSTART"; then
  if [[ "$ROSIE_SELECTED_PROVIDER" != "local_llm" && "$ROSIE_SELECTED_PROVIDER" != "auto" ]]; then
    echo "[rosie] local Gemma Host autostart skipped for ROSIE_PROVIDER=${ROSIE_SELECTED_PROVIDER}"
  elif [[ "$RIVERSIDE_LLAMA_UPSTREAM" == "$LOCAL_LLAMA_URL" ]]; then
    if curl -fsS "${LOCAL_LLAMA_URL}/health" >/dev/null 2>&1; then
      echo "[rosie] using existing local Gemma Host runtime at ${LOCAL_LLAMA_URL}"
    elif [[ ! -x "$LLAMA_BIN" ]]; then
      echo "[rosie] local ROSIE Host runtime not started: missing llama-server binary at ${LLAMA_BIN}" >&2
    elif [[ ! -f "$LLAMA_MODEL_PATH" ]]; then
      echo "[rosie] local ROSIE Host runtime not started: missing Gemma model at ${LLAMA_MODEL_PATH}" >&2
    else
      echo "[rosie] starting local Gemma Host runtime at ${LOCAL_LLAMA_URL} (${LLAMA_PERF_PROFILE})"
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
      LLAMA_CMD+=("${LLAMA_ENFORCED_ARGS[@]}")
      start_rosie_host
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
cargo run --bin riverside-server "$@" &
SERVER_PID="$!"
wait "$SERVER_PID"
