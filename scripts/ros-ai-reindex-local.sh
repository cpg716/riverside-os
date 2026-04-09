#!/usr/bin/env bash
# Rebuild staff help chunks + optional dense embeddings (POST /api/ai/admin/reindex-docs).
# Operator guide: docs/ROS_AI_HELP_CORPUS.md
# Prerequisites:
#   - API listening (e.g. npm run dev or cargo run) with DATABASE_URL pointing at this DB
#   - Docker DB: postgresql://postgres:password@localhost:5433/riverside_os
#   - Staff with settings.admin (default bootstrap: cashier code 1234, PIN 1234)
#   - Free disk: full server debug builds need several GB; ONNX model cache may download on first embed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE_URL="${ROS_REINDEX_API_BASE:-http://127.0.0.1:3000}"
CODE="${E2E_BO_STAFF_CODE:-1234}"
PIN="${E2E_BO_STAFF_PIN:-1234}"
REPO="${RIVERSIDE_REPO_ROOT:-$ROOT}"

if [[ ! -f "$REPO/docs/staff/CORPUS.manifest.json" ]]; then
  echo "error: missing $REPO/docs/staff/CORPUS.manifest.json — set RIVERSIDE_REPO_ROOT to repo root" >&2
  exit 1
fi

JSON_REPO="${REPO//\\/\\\\}"
JSON_REPO="${JSON_REPO//\"/\\\"}"

echo "POST $BASE_URL/api/ai/admin/reindex-docs (repo_root=$REPO) ..." >&2
curl -sS -X POST "$BASE_URL/api/ai/admin/reindex-docs" \
  -H "Content-Type: application/json" \
  -H "x-riverside-staff-code: $CODE" \
  -H "x-riverside-staff-pin: $PIN" \
  -d "{\"repo_root\":\"$JSON_REPO\"}"
echo >&2
