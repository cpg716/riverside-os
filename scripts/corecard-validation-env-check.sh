#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-sandbox}"
ENV_FILE="${2:-}"

if [[ "$MODE" != "sandbox" && "$MODE" != "live" && "$MODE" != "fake" ]]; then
  echo "Usage: $0 [sandbox|live|fake] [optional-env-file]"
  exit 2
fi

if [[ -n "$ENV_FILE" ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "Env file not found: $ENV_FILE"
    exit 2
  fi
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

mask_value() {
  local value="${1:-}"
  if [[ -z "$value" ]]; then
    printf "<missing>"
    return
  fi
  local len="${#value}"
  if (( len <= 4 )); then
    printf "****"
    return
  fi
  printf "%s****%s" "${value:0:2}" "${value:len-2:2}"
}

require_var() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "${value// }" ]]; then
    echo "MISSING  $name"
    return 1
  fi
  echo "OK       $name=$(mask_value "$value")"
  return 0
}

show_var() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "${value// }" ]]; then
    echo "OPTIONAL $name=<unset>"
  else
    echo "OPTIONAL $name=$(mask_value "$value")"
  fi
}

failures=0

echo "CoreCard validation env check"
echo "Mode: $MODE"
if [[ -n "$ENV_FILE" ]]; then
  echo "Loaded env file: $ENV_FILE"
fi
echo

echo "Required CoreCard variables"
for key in \
  RIVERSIDE_CORECARD_BASE_URL \
  RIVERSIDE_CORECARD_CLIENT_ID \
  RIVERSIDE_CORECARD_CLIENT_SECRET \
  RIVERSIDE_CORECARD_REGION \
  RIVERSIDE_CORECARD_ENVIRONMENT
do
  if ! require_var "$key"; then
    failures=$((failures + 1))
  fi
done

echo
echo "Recommended validation variables"
show_var RIVERSIDE_CORECARD_TIMEOUT_SECS
show_var RIVERSIDE_CORECARD_REDACTION
show_var RIVERSIDE_CORECARD_LOG_PAYLOADS
show_var RIVERSIDE_CORECARD_WEBHOOK_SECRET
show_var RIVERSIDE_CORECARD_WEBHOOK_ALLOW_UNSIGNED
show_var RIVERSIDE_CORECARD_REPAIR_POLL_SECS
show_var RIVERSIDE_CORECARD_SNAPSHOT_RETENTION_DAYS

echo
if [[ "$MODE" == "live" ]]; then
  echo "Live-mode safety checks"
  if [[ "${RIVERSIDE_CORECARD_ENVIRONMENT:-}" != "live" ]]; then
    echo "WARN     RIVERSIDE_CORECARD_ENVIRONMENT should be 'live' for live validation."
  fi
  if [[ -n "${RIVERSIDE_CORECARD_WEBHOOK_ALLOW_UNSIGNED:-}" && "${RIVERSIDE_CORECARD_WEBHOOK_ALLOW_UNSIGNED,,}" =~ ^(1|true|yes|on)$ ]]; then
    echo "WARN     RIVERSIDE_CORECARD_WEBHOOK_ALLOW_UNSIGNED should stay disabled for live validation."
  fi
  if [[ "${RIVERSIDE_CORECARD_LOG_PAYLOADS:-}" =~ ^(1|true|yes|on)$ ]]; then
    echo "WARN     RIVERSIDE_CORECARD_LOG_PAYLOADS is enabled. Confirm this is intentional and redaction is set appropriately."
  fi
fi

if [[ "$MODE" == "sandbox" ]]; then
  echo "Sandbox-mode checks"
  if [[ "${RIVERSIDE_CORECARD_ENVIRONMENT:-}" != "sandbox" ]]; then
    echo "WARN     RIVERSIDE_CORECARD_ENVIRONMENT should normally be 'sandbox' for sandbox validation."
  fi
fi

if [[ "$MODE" == "fake" ]]; then
  echo "Fake-host checks"
  if [[ "${RIVERSIDE_ENABLE_E2E_TEST_SUPPORT:-}" != "1" && "${RIVERSIDE_ENABLE_E2E_TEST_SUPPORT:-}" != "true" ]]; then
    echo "WARN     RIVERSIDE_ENABLE_E2E_TEST_SUPPORT is not enabled."
  fi
fi

echo
if (( failures > 0 )); then
  echo "CoreCard validation preflight failed with $failures missing required variable(s)."
  exit 1
fi

echo "CoreCard validation preflight passed."
