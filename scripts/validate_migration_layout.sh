#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

expected=(
  "001_core_identity_staff.sql"
  "002_catalog_inventory.sql"
  "003_customers_weddings_relationships.sql"
  "004_pos_transactions_payments.sql"
  "005_operations_workflows.sql"
  "006_integrations.sql"
  "007_reporting_views.sql"
  "008_indexes_constraints_triggers.sql"
  "009_promo_gift_cards.sql"
  "010_counterpoint_ingest_quarantine.sql"
  "011_product_variant_barcode_aliases.sql"
  "012_lightspeed_normalization_reference.sql"
  "013_financial_effective_dates.sql"
  "014_helcim_terminal_recovery_actions.sql"
  "015_counterpoint_staging_applying_status.sql"
  "016_counterpoint_staging_apply_claim_metadata.sql"
  "017_counterpoint_staging_observability.sql"
  "018_order_item_lifecycle.sql"
)

active=()
while IFS= read -r file; do
  active+=("$file")
done < <(find "$ROOT/migrations" -maxdepth 1 -type f -name '[0-9][0-9]*_*.sql' -exec basename {} \; | sort -V)

if [ "${#active[@]}" -ne "${#expected[@]}" ]; then
  echo "Expected ${#expected[@]} active baseline migrations; found ${#active[@]}." >&2
  printf 'Active files:\n' >&2
  printf '  %s\n' "${active[@]}" >&2
  exit 1
fi

for i in "${!expected[@]}"; do
  if [ "${active[$i]}" != "${expected[$i]}" ]; then
    echo "Migration layout mismatch at position $((i + 1)): expected ${expected[$i]}, found ${active[$i]}." >&2
    exit 1
  fi
done

duplicate_prefixes="$(
  printf '%s\n' "${active[@]}" \
    | sed -E 's/^([0-9]+).*/\1/' \
    | sort \
    | uniq -d
)"
if [ -n "$duplicate_prefixes" ]; then
  echo "Duplicate migration numeric prefixes are not allowed:" >&2
  printf '  %s\n' $duplicate_prefixes >&2
  exit 1
fi

legacy_root_files="$(
  find "$ROOT/migrations" -maxdepth 1 -type f -name '*.sql' \
    ! -name '[0-9][0-9][0-9]_*' \
    -exec basename {} \; \
    | sort
)"
if [ -n "$legacy_root_files" ]; then
  echo "Legacy or non-baseline SQL files found in active migrations folder:" >&2
  printf '  %s\n' $legacy_root_files >&2
  exit 1
fi

if rg -n "INSERT INTO (public\\.)?(staff\\b|staff_permission|store_settings|products|product_variants|meilisearch_sync_status)" migrations/*.sql >/tmp/ros_migration_seed_hits.$$; then
  echo "Seed-like data is not allowed in active schema migrations:" >&2
  cat /tmp/ros_migration_seed_hits.$$ >&2
  rm -f /tmp/ros_migration_seed_hits.$$
  exit 1
fi
rm -f /tmp/ros_migration_seed_hits.$$

echo "Migration layout OK: active baseline 001-018 only."
