#!/usr/bin/env bash
# sync-integration-credentials.sh
#
# One-shot export + import of integration_credentials between two databases.
# Both environments must share the same RIVERSIDE_CREDENTIALS_KEY.
#
# Usage:
#   bash scripts/sync-integration-credentials.sh \
#     "postgres://user:pass@dev:5432/riverside_os" \
#     "postgres://user:pass@prod:5432/riverside_os"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_URL="${1:-}"
DST_URL="${2:-}"

if [[ -z "$SRC_URL" ]] || [[ -z "$DST_URL" ]]; then
  echo "Usage: $0 <source-database-url> <target-database-url>" >&2
  exit 1
fi

TMP_DUMP=$(mktemp /tmp/riverside-credentials-XXXXXX.pgsql)
trap 'rm -f "$TMP_DUMP"' EXIT

echo "==> Exporting integration_credentials from source..." >&2
bash "$SCRIPT_DIR/export-integration-credentials.sh" "$SRC_URL" > "$TMP_DUMP"

echo "==> Importing into target..." >&2
DATABASE_URL="$DST_URL" bash "$SCRIPT_DIR/import-integration-credentials.sh" "$TMP_DUMP"

echo "==> Sync complete." >&2
