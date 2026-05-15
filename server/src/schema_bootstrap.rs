//! Runtime schema contract validation.
//!
//! The server must never apply schema DDL at startup. Fresh installs and upgrades
//! are handled by explicit migration scripts; startup only verifies that the
//! connected database matches the minimum contract required by the application.

use anyhow::{bail, Result};
use sqlx::PgPool;

pub async fn ensure_core_schema(pool: &PgPool) -> Result<()> {
    let missing: Vec<String> = sqlx::query_scalar(
        r#"
        WITH expected_tables(schema_name, table_name) AS (
            VALUES
                ('public', 'staff'),
                ('public', 'store_settings'),
                ('public', 'staff_role_permission'),
                ('public', 'staff_permission'),
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
                ('public', 'register_sessions'),
                ('public', 'qbo_mappings'),
                ('public', 'integration_credentials'),
                ('public', 'counterpoint_sync_runs'),
                ('public', 'shipment'),
                ('public', 'ros_schema_migrations')
        ),
        expected_columns(schema_name, table_name, column_name) AS (
            VALUES
                ('public', 'staff', 'pin_hash'),
                ('public', 'staff', 'email_signature'),
                ('public', 'staff', 'max_discount_percent'),
                ('public', 'store_settings', 'environment_mode'),
                ('public', 'store_settings', 'active_card_provider'),
                ('public', 'store_settings', 'email_config'),
                ('public', 'integration_credentials', 'encrypted_value'),
                ('public', 'products', 'tax_category'),
                ('public', 'products', 'tax_category_override'),
                ('public', 'product_variants', 'reserved_stock'),
                ('public', 'transactions', 'display_id'),
                ('public', 'transactions', 'is_tax_exempt'),
                ('public', 'transactions', 'tax_exempt_reason'),
                ('public', 'transaction_lines', 'transaction_id'),
                ('public', 'transaction_lines', 'fulfillment_order_id'),
                ('public', 'payment_allocations', 'target_transaction_id'),
                ('public', 'payment_transactions', 'payment_provider'),
                ('public', 'payment_transactions', 'provider_payment_id'),
                ('public', 'payment_provider_attempts', 'provider_client_secret'),
                ('public', 'payment_provider_attempts', 'selected_terminal_key'),
                ('public', 'payment_provider_attempts', 'terminal_route_source'),
                ('public', 'payment_provider_attempts', 'terminal_override_staff_id'),
                ('public', 'payment_provider_attempts', 'terminal_override_reason'),
                ('public', 'fulfillment_orders', 'display_id')
        ),
        expected_views(schema_name, view_name) AS (
            VALUES
                ('reporting', 'transactions_core'),
                ('reporting', 'fulfillment_orders_core'),
                ('reporting', 'order_lines'),
                ('reporting', 'payment_ledger'),
                ('reporting', 'merchant_reconciliation')
        ),
        expected_functions(schema_name, function_name) AS (
            VALUES
                ('public', 'generate_txn_display_id'),
                ('public', 'generate_ord_display_id'),
                ('reporting', 'order_recognition_at'),
                ('reporting', 'transaction_line_recognition_at')
        ),
        missing_tables AS (
            SELECT 'missing table ' || schema_name || '.' || table_name AS item
            FROM expected_tables e
            WHERE NOT EXISTS (
                SELECT 1
                FROM information_schema.tables t
                WHERE t.table_schema = e.schema_name
                  AND t.table_name = e.table_name
            )
        ),
        missing_columns AS (
            SELECT 'missing column ' || schema_name || '.' || table_name || '.' || column_name AS item
            FROM expected_columns e
            WHERE NOT EXISTS (
                SELECT 1
                FROM information_schema.columns c
                WHERE c.table_schema = e.schema_name
                  AND c.table_name = e.table_name
                  AND c.column_name = e.column_name
            )
        ),
        missing_views AS (
            SELECT 'missing reporting view ' || schema_name || '.' || view_name AS item
            FROM expected_views e
            WHERE to_regclass(schema_name || '.' || view_name) IS NULL
        ),
        missing_functions AS (
            SELECT 'missing function ' || schema_name || '.' || function_name AS item
            FROM expected_functions e
            WHERE NOT EXISTS (
                SELECT 1
                FROM pg_proc p
                INNER JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = e.schema_name
                  AND p.proname = e.function_name
            )
        )
        SELECT item
        FROM missing_tables
        UNION ALL SELECT item FROM missing_columns
        UNION ALL SELECT item FROM missing_views
        UNION ALL SELECT item FROM missing_functions
        ORDER BY item
        "#,
    )
    .fetch_all(pool)
    .await?;

    if !missing.is_empty() {
        bail!(
            "database schema contract mismatch; apply migrations before startup: {}",
            missing.join("; ")
        );
    }

    Ok(())
}
