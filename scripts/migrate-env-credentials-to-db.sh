#!/usr/bin/env bash
# migrate-env-credentials-to-db.sh
#
# One-shot migration: reads credentials from .env and saves them into the
# integration_credentials table via the /api/settings/credentials endpoint.
#
# Run from repo root with the server already running:
#   bash scripts/migrate-env-credentials-to-db.sh <admin-token>
#
# Or set TOKEN env var:
#   TOKEN=xxx bash scripts/migrate-env-credentials-to-db.sh

set -euo pipefail

BASE_URL="${RIVERSIDE_API_BASE:-http://localhost:3000}"
TOKEN="${1:-${TOKEN:-}}"

if [[ -z "$TOKEN" ]]; then
  echo "Usage: $0 <admin-backoffice-token>"
  echo "   or: TOKEN=xxx $0"
  exit 1
fi

post_credential() {
  local integration="$1"
  local key="$2"
  local value="$3"

  if [[ -z "$value" ]]; then
    echo "  SKIP  [$integration/$key] (empty)"
    return
  fi

  local payload
  payload=$(printf '{"credentials":{"%s":"%s"}}' "$key" "$value")

  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "$payload" \
    "${BASE_URL}/api/settings/credentials/${integration}")

  if [[ "$http_code" == "200" || "$http_code" == "204" ]]; then
    echo "  OK    [$integration/$key]"
  else
    echo "  FAIL  [$integration/$key] HTTP $http_code"
  fi
}

echo "==> Migrating Metabase credentials to insights integration..."
# Source values from .env if present
ENV_FILE="$(dirname "$0")/../server/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -o allexport
  # shellcheck disable=SC1090
  source "$ENV_FILE" || true
  set +o allexport
fi

post_credential "insights" "metabase_admin_email"    "${RIVERSIDE_METABASE_ADMIN_EMAIL:-}"
post_credential "insights" "metabase_admin_password" "${RIVERSIDE_METABASE_ADMIN_PASSWORD:-}"
post_credential "insights" "metabase_staff_email"    "${RIVERSIDE_METABASE_STAFF_EMAIL:-}"
post_credential "insights" "metabase_staff_password" "${RIVERSIDE_METABASE_STAFF_PASSWORD:-}"

echo ""
echo "==> Done. You can now remove the RIVERSIDE_METABASE_ADMIN_* and"
echo "    RIVERSIDE_METABASE_STAFF_* lines from server/.env."
echo "    Credentials are now encrypted in the integration_credentials table."
