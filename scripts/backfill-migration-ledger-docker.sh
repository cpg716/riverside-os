#!/usr/bin/env bash
# Historical ledger backfill is intentionally retired after the pre-launch
# schema-contract baseline reset. Rebuild the database from baseline migrations
# or explicitly migrate ledger rows as part of a reviewed reset procedure.
set -euo pipefail

echo "Ledger backfill is retired for the schema-contract baseline." >&2
echo "Use scripts/apply-migrations-docker.sh on a clean database, then scripts/migration-status-docker.sh." >&2
exit 1
