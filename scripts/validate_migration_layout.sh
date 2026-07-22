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
  "019_takeaway_completed_recognition.sql"
  "020_order_lifecycle_needs_measurements.sql"
  "021_wedding_cutover_review.sql"
  "022_email_mailbox.sql"
  "023_shippo_returns_manifests_pickups.sql"
  "024_register_drawer_open_events.sql"
  "025_qbo_bridge_mapping_hardening.sql"
  "026_counterpoint_go_live_hardening.sql"
  "027_repair_promo_gift_card_schema.sql"
  "028_podium_communications_hardening.sql"
  "029_metabase_ro_reporting_only.sql"
  "030_podium_staff_identity_mapping.sql"
  "031_checkout_takeaway_loyalty_backfill.sql"
  "032_transaction_status_integrity.sql"
  "033_qbo_inventory_receiving_clearing.sql"
  "034_transaction_void_records.sql"
  "035_backup_resilience_settings.sql"
  "036_financial_date_and_counterpoint_integrity.sql"
  "037_backfill_missing_columns.sql"
  "038_web_listing_and_categories.sql"
  "039_wal_archiving_configuration.sql"
  "040_ops_audit_probes.sql"
  "041_staff_avatar_photo.sql"
  "042_seed_admin_account.sql"
  "043_fal_visual_sidecar.sql"
  "044_customer_review_opt_out.sql"
  "045_qbo_webhook_events_and_hardening.sql"
  "046_alteration_pickup_tracking.sql"
  "047_phase4_resiliency.sql"
  "048_constant_contact_integration.sql"
  "049_constant_contact_permissions.sql"
  "050_inventory_migration_workbench.sql"
  "051_receiving_freight_ledger_keys.sql"
  "052_daily_financial_reports.sql"
  "053_customer_notification_queue.sql"
  "054_customer_opt_in_defaults.sql"
  "055_alteration_ticket_number.sql"
  "056_alteration_verify_completed_status.sql"
  "057_transaction_lines_alteration_ready.sql"
  "058_pos_station_config.sql"
  "060_rosie_token_telemetry.sql"
  "061_ops_connectivity_logs.sql"
  "062_rename_qbo_inventory_adjustment_revenue.sql"
  "063_notification_search_and_fatigue.sql"
  "064_staff_schedule_admin_effective_days.sql"
  "065_procurement_imports.sql"
  "066_ops_readiness_signoffs.sql"
  "067_customer_notification_center.sql"
  "068_transaction_lines_discount_amount.sql"
  "069_retire_qbo_transaction_outbox.sql"
  "070_task_assignment_ownership.sql"
  "071_physical_inventory_readiness_controls.sql"
  "072_physical_inventory_scan_idempotency.sql"
  "073_product_secondary_vendors.sql"
  "074_discount_events_full_inventory_scope.sql"
  "075_daily_sales_weather_reporting.sql"
  "076_commission_combo_variant_targets.sql"
  "077_register_cash_deposit.sql"
  "078_data_integrity_hardening.sql"
  "079_counterpoint_transition_review_packs.sql"
  "080_counterpoint_payment_method_aliases.sql"
  "081_counterpoint_import_first_proof.sql"
  "082_loyalty_reward_threshold_floor.sql"
  "083_staff_schedule_requests_and_appointment_identity.sql"
  "084_staff_birthdays_notifications.sql"
  "085_rosie_read_tool_audit.sql"
  "086_rosie_tool_gap_log.sql"
  "087_open_deposit_ledger_sources.sql"
  "088_drop_counterpoint_review_pack_tables.sql"
  "089_restore_custom_order_catalog_skus.sql"
  "090_counterpoint_import_run_kind_modes.sql"
  "091_counterpoint_2024_history_floor.sql"
  "092_counterpoint_live_tender_aliases.sql"
  "093_counterpoint_square_tender_alias.sql"
  "094_counterpoint_closed_ticket_balance_presentation.sql"
  "095_register_session_station_tokens.sql"
  "096_counterpoint_category_tax_defaults.sql"
  "097_manager_approval_permission.sql"
  "098_transaction_line_booked_at.sql"
  "099_transaction_line_shipping_release.sql"
  "100_allow_wedding_import_customer_source.sql"
  "101_register_open_lane_uniqueness_guard.sql"
  "102_counterpoint_open_doc_tax_repair.sql"
  "103_counterpoint_open_doc_tax_header_repair.sql"
  "104_wedding_import_customer_identity_repair.sql"
  "105_wedding_import_duplicate_customer_repair.sql"
  "106_counterpoint_variation_label_cleanup.sql"
  "107_counterpoint_variation_all_star_cleanup.sql"
  "108_inventory_hide_stale_zero_stock.sql"
  "109_wedding_party_numbers.sql"
  "110_donation_tender_reporting.sql"
  "111_helcim_event_payment_match_backfill.sql"
  "112_weather_vc_request_cache.sql"
  "113_system_staff_admin_salesperson.sql"
  "114_counterpoint_inventory_and_return_audit_backfill.sql"
  "115_qbo_blocking_warning_review_status.sql"
  "116_payment_allocation_transaction_index.sql"
  "117_retire_counterpoint_stale_notifications.sql"
  "118_repair_joe_webb_failed_exchange_return.sql"
  "119_backfill_open_deferred_payment_deposit_metadata.sql"
  "120_resolve_browser_station_offline_alerts.sql"
  "121_pos_shipping_charge_links.sql"
  "122_unhide_inventory_variants.sql"
  "123_staff_accounts.sql"
  "124_operational_recovery_and_telemetry.sql"
  "125_staff_access_sessions.sql"
  "126_register_business_day_z_reports.sql"
  "127_counterpoint_transaction_reconciliation.sql"
  "128_helcim_paid_parked_sale_recovery.sql"
  "129_backfill_checkout_payment_payers.sql"
  "130_archive_duplicate_shipping_alteration_fee_products.sql"
  "131_repair_counterpoint_historical_paid_amounts.sql"
  "132_reliability_read_path_indexes.sql"
  "133_qbo_backdated_sale_clearing.sql"
  "134_customer_merge_history_pointer.sql"
  "135_reconcile_picked_up_order_status.sql"
  "136_restore_counterpoint_line_paid_prices.sql"
  "137_payment_dashboard_read_path_indexes.sql"
  "138_register_payment_read_path_indexes.sql"
  "139_transaction_return_financial_events.sql"
  "140_search_trigram_read_path_indexes.sql"
  "141_transaction_line_booking_events.sql"
  "142_counterpoint_repair_reporting_guard.sql"
  "143_register_financial_recovery_integrity.sql"
  "144_transaction_line_booking_event_delete_integrity.sql"
  "145_notification_queue_partial_conflict_inference.sql"
  "146_counterpoint_financial_integrity_manifest.sql"
  "147_verified_backup_evidence.sql"
  "148_receiving_identifier_lookup_indexes.sql"
  "149_verified_backup_artifact_identity.sql"
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

if rg -n "INSERT INTO (public\\.)?(staff\\b|staff_permission|store_settings|products|product_variants|meilisearch_sync_status)" migrations/ \
  --max-depth 1 \
  --glob '*.sql' \
  --glob '!*042_seed_admin_account.sql' \
  --glob '!*049_constant_contact_permissions.sql' \
  --glob '!*089_restore_custom_order_catalog_skus.sql' \
  --glob '!*097_manager_approval_permission.sql' \
  --glob '!*113_system_staff_admin_salesperson.sql' \
  --glob '!*123_staff_accounts.sql' \
  >/tmp/ros_migration_seed_hits.$$; then
  echo "Seed-like data is not allowed in active schema migrations:" >&2
  cat /tmp/ros_migration_seed_hits.$$ >&2
  rm -f /tmp/ros_migration_seed_hits.$$
  exit 1
fi
rm -f /tmp/ros_migration_seed_hits.$$

echo "Migration layout OK: active baseline through 149."
