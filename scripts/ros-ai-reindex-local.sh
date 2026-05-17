#!/usr/bin/env bash
# Rebuild current Help search (`ros_help`) through the Help admin API.
# Operator guide: docs/ROS_AI_HELP_CORPUS.md
# Prerequisites:
#   - API listening (e.g. npm run dev or cargo run) with DATABASE_URL pointing at this DB
#   - Docker DB: postgresql://postgres:password@localhost:5433/riverside_os
#   - Staff with help.manage/admin access (default E2E bootstrap: staff code 1234, PIN 1234)
#   - Meilisearch configured when reindexing only the Help search index.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE_URL="${ROS_REINDEX_API_BASE:-http://127.0.0.1:3000}"
CODE="${E2E_BO_STAFF_CODE:-1234}"
PIN="${E2E_BO_STAFF_PIN:-1234}"

if [[ ! -f "$ROOT/server/src/logic/help_corpus_manuals.generated.rs" ]]; then
  echo "error: missing generated Help corpus file; run npm run generate:help first" >&2
  exit 1
fi

echo "POST $BASE_URL/api/help/admin/ops/reindex-search ..." >&2
curl -sS -X POST "$BASE_URL/api/help/admin/ops/reindex-search" \
  -H "Content-Type: application/json" \
  -H "x-riverside-staff-code: $CODE" \
  -H "x-riverside-staff-pin: $PIN" \
  -d '{"full_reindex_fallback":true}'
echo >&2
