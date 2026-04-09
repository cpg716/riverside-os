#!/usr/bin/env bash
# Full Meilisearch reindex (POST /api/settings/meilisearch/reindex).
# Rebuilds catalog + customer + order indexes and in-app help (`ros_help` from client markdown).
# See docs/SEARCH_AND_PAGINATION.md (Meilisearch section) and docs/MANUAL_CREATION.md.
# Prerequisites: API up, RIVERSIDE_MEILISEARCH_URL (+ key) on server, staff with settings.admin.
set -euo pipefail

BASE_URL="${ROS_MEILISEARCH_REINDEX_API_BASE:-http://127.0.0.1:3000}"
CODE="${E2E_BO_STAFF_CODE:-1234}"
PIN="${E2E_BO_STAFF_PIN:-1234}"

echo "POST $BASE_URL/api/settings/meilisearch/reindex ..." >&2
curl -sS -X POST "$BASE_URL/api/settings/meilisearch/reindex" \
  -H "x-riverside-staff-code: $CODE" \
  -H "x-riverside-staff-pin: $PIN"
echo >&2
