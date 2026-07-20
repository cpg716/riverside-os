#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${RIVERSIDE_EXPLAIN_DATABASE_URL:-}" ]]; then
  echo "Set RIVERSIDE_EXPLAIN_DATABASE_URL to an explicitly approved Main Hub/replica database URL." >&2
  exit 2
fi

if [[ "${RIVERSIDE_EXPLAIN_DATABASE_URL}" =~ localhost|127\.0\.0\.1|0\.0\.0\.0 ]] && [[ "${ALLOW_LOCAL_PERF:-0}" != "1" ]]; then
  echo "Refusing a local database target; use the Main Hub or an approved replica." >&2
  exit 2
fi

psql "${RIVERSIDE_EXPLAIN_DATABASE_URL}" \
  -X \
  -v ON_ERROR_STOP=1 \
  -f "$(cd "$(dirname "$0")" && pwd)/explain-search-paths.sql"
