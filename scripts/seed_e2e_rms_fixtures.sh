#!/usr/bin/env bash
set -euo pipefail

API_BASE="${E2E_API_BASE:-http://127.0.0.1:43300}"
STAFF_CODE="${E2E_BO_STAFF_CODE:-1234}"

if ! command -v curl >/dev/null 2>&1; then
  echo "seed_e2e_rms_fixtures.sh: curl is required." >&2
  exit 1
fi

post_fixture() {
  local fixture="$1"
  local label="$2"

  local response
  response="$(
    curl -fsS -X POST "${API_BASE}/api/test-support/rms/seed-fixture" \
      -H "x-riverside-staff-code: ${STAFF_CODE}" \
      -H "x-riverside-staff-pin: ${STAFF_CODE}" \
      -H "Content-Type: application/json" \
      -d "{\"fixture\":\"${fixture}\",\"customer_label\":\"${label}\"}"
  )"

  RESPONSE_JSON="${response}" node <<'EOF'
const body = JSON.parse(process.env.RESPONSE_JSON || "{}");
const customer = body.customer || {};
const accounts = Array.isArray(body.linked_accounts) ? body.linked_accounts : [];
const accountSummary = accounts.length
  ? accounts.map((row) => `${row.masked_account} (${row.status})`).join(", ")
  : "no linked accounts";
console.log(`- ${body.fixture}: ${customer.display_name}`);
console.log(`  Search: ${customer.search_label || customer.display_name || "<unknown>"}`);
console.log(`  Customer code: ${customer.customer_code || "<unknown>"}`);
console.log(`  Linked accounts: ${accountSummary}`);
EOF
}

echo "Seeding local RMS E2E customers against ${API_BASE}"
echo
post_fixture "single_valid" "Local Single"
post_fixture "standard_only" "Local Standard"
post_fixture "rms90_eligible" "Local RMS90"
post_fixture "multi_match" "Local Multi"
post_fixture "restricted" "Local Restricted"
echo
echo "Tip: search the POS customer picker for:"
echo "  Local Single"
echo "  Local Standard"
echo "  Local RMS90"
echo "  Local Multi"
echo "  Local Restricted"
