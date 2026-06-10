#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

sql_file="$(mktemp)"
trap 'rm -f "$sql_file"' EXIT

cat > "$sql_file" <<'SQL'
\set ON_ERROR_STOP on
WITH expected_tables(schema_name, table_name) AS (
    VALUES
        ('public', 'staff'),
        ('public', 'store_settings'),
        ('public', 'staff_role_permission'),
        ('public', 'staff_permission'),
        ('public', 'podium_message'),
        ('public', 'products'),
        ('public', 'product_variants'),
        ('public', 'inventory_transactions'),
        ('public', 'vendors'),
        ('public', 'customers'),
        ('public', 'customer_relationship_periods'),
        ('public', 'wedding_parties'),
        ('public', 'wedding_members'),
        ('public', 'transactions'),
        ('public', 'transaction_lines'),
        ('public', 'fulfillment_orders'),
        ('public', 'payment_transactions'),
        ('public', 'payment_allocations'),
        ('public', 'payment_provider_attempts'),
        ('public', 'transaction_return_lines'),
        ('public', 'transaction_loyalty_accrual'),
        ('public', 'register_sessions'),
        ('public', 'qbo_mappings'),
        ('public', 'counterpoint_sync_runs'),
        ('public', 'counterpoint_sync_issue'),
        ('public', 'counterpoint_staging_batch'),
        ('public', 'counterpoint_payment_method_map'),
        ('public', 'counterpoint_gift_reason_map'),
        ('public', 'shipment'),
        ('public', 'ros_schema_migrations')
),
expected_columns(schema_name, table_name, column_name) AS (
    VALUES
        ('public', 'staff', 'pin_hash'),
        ('public', 'staff', 'email_signature'),
        ('public', 'staff', 'max_discount_percent'),
        ('public', 'staff', 'podium_user_uid'),
        ('public', 'staff', 'podium_display_name'),
        ('public', 'podium_message', 'podium_sender_uid'),
        ('public', 'store_settings', 'environment_mode'),
        ('public', 'store_settings', 'active_card_provider'),
        ('public', 'store_settings', 'email_config'),
        ('public', 'products', 'tax_category'),
        ('public', 'products', 'tax_category_override'),
        ('public', 'product_variants', 'reserved_stock'),
        ('public', 'transactions', 'display_id'),
        ('public', 'transactions', 'is_tax_exempt'),
        ('public', 'transactions', 'tax_exempt_reason'),
        ('public', 'transaction_lines', 'transaction_id'),
        ('public', 'transaction_lines', 'fulfillment_order_id'),
        ('public', 'transaction_lines', 'fulfilled_at'),
        ('public', 'transaction_loyalty_accrual', 'transaction_id'),
        ('public', 'transaction_loyalty_accrual', 'points_earned'),
        ('public', 'transaction_loyalty_accrual', 'product_subtotal'),
        ('public', 'payment_allocations', 'target_transaction_id'),
        ('public', 'payment_transactions', 'payment_provider'),
        ('public', 'payment_transactions', 'provider_payment_id'),
        ('public', 'payment_provider_attempts', 'provider_client_secret'),
        ('public', 'payment_provider_attempts', 'selected_terminal_key'),
        ('public', 'payment_provider_attempts', 'terminal_route_source'),
        ('public', 'payment_provider_attempts', 'terminal_override_staff_id'),
        ('public', 'payment_provider_attempts', 'terminal_override_reason'),
        ('public', 'fulfillment_orders', 'display_id'),
        ('public', 'gift_cards', 'promo_event_name'),
        ('public', 'counterpoint_staging_batch', 'apply_started_at'),
        ('public', 'counterpoint_staging_batch', 'apply_claimed_by_staff_id'),
        ('public', 'counterpoint_staging_batch', 'replay_count'),
        ('public', 'counterpoint_staging_batch', 'last_replayed_at'),
        ('public', 'counterpoint_staging_batch', 'payload_fingerprint'),
        ('public', 'counterpoint_staging_batch', 'recovered_at'),
        ('public', 'counterpoint_staging_batch', 'recovered_by_staff_id'),
        ('public', 'counterpoint_staging_batch', 'recovery_reason'),
        ('public', 'ros_schema_migrations', 'file_sha256')
),
expected_views(schema_name, view_name) AS (
    VALUES
        ('reporting', 'transactions_core'),
        ('reporting', 'fulfillment_orders_core'),
        ('reporting', 'order_lines'),
        ('reporting', 'payment_ledger'),
        ('reporting', 'merchant_reconciliation'),
        ('reporting', 'transaction_status_integrity')
),
expected_indexes(schema_name, index_name) AS (
    VALUES
        ('public', 'transactions_display_id_key'),
        ('public', 'idx_transaction_lines_transaction'),
        ('public', 'idx_transaction_lines_fulfillment_order'),
        ('public', 'idx_payment_allocations_target_transaction_payment'),
        ('public', 'idx_payment_transactions_provider_payment_id'),
        ('public', 'idx_counterpoint_sync_issue_open_unique'),
        ('public', 'idx_counterpoint_staging_status_created'),
        ('public', 'idx_product_variants_product_id'),
        ('public', 'idx_transactions_booked_status_id'),
        ('public', 'idx_staff_permission_staff'),
        ('public', 'payment_transactions_provider_transaction_uidx'),
        ('public', 'qbo_sync_logs_one_pending_per_date_uidx'),
        ('public', 'store_checkout_payment_attempt_open_session_provider_uidx')
),
expected_functions(schema_name, function_name) AS (
    VALUES
        ('public', 'generate_txn_display_id'),
        ('public', 'generate_ord_display_id'),
        ('reporting', 'order_recognition_at'),
        ('reporting', 'transaction_line_recognition_at')
),
missing AS (
    SELECT 'missing table ' || schema_name || '.' || table_name AS item
    FROM expected_tables e
    WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.tables t
        WHERE t.table_schema = e.schema_name AND t.table_name = e.table_name
    )
    UNION ALL
    SELECT 'missing column ' || schema_name || '.' || table_name || '.' || column_name
    FROM expected_columns e
    WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = e.schema_name AND c.table_name = e.table_name AND c.column_name = e.column_name
    )
    UNION ALL
    SELECT 'missing view ' || schema_name || '.' || view_name
    FROM expected_views e
    WHERE to_regclass(schema_name || '.' || view_name) IS NULL
    UNION ALL
    SELECT 'missing index ' || schema_name || '.' || index_name
    FROM expected_indexes e
    WHERE NOT EXISTS (
        SELECT 1 FROM pg_indexes i
        WHERE i.schemaname = e.schema_name AND i.indexname = e.index_name
    )
    UNION ALL
    SELECT 'missing function ' || schema_name || '.' || function_name
    FROM expected_functions e
    WHERE NOT EXISTS (
        SELECT 1
        FROM pg_proc p
        INNER JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = e.schema_name AND p.proname = e.function_name
    )
)
SELECT item FROM missing ORDER BY item;
SQL

if [ -n "${DATABASE_URL:-}" ]; then
  result="$(psql "$DATABASE_URL" -At -f "$sql_file")"
else
  RIVERSIDE_DB_NAME="${RIVERSIDE_DB_NAME:-riverside_os}"
  docker compose up -d db >/dev/null
  result="$(docker compose exec -T db psql -U postgres -d "$RIVERSIDE_DB_NAME" -At -f - < "$sql_file")"
fi

if [ -n "$result" ]; then
  echo "Schema contract validation failed:" >&2
  printf '%s\n' "$result" >&2
  exit 1
fi

echo "Schema contract OK."
