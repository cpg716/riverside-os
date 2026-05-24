//! Runtime schema contract validation.
//!
//! The server must never apply schema DDL at startup. Fresh installs and upgrades
//! are handled by explicit migration scripts; startup only verifies that the
//! connected database matches the minimum contract required by the application.

use anyhow::{bail, Result};
use sqlx::PgPool;
use uuid::Uuid;

pub async fn ensure_core_schema(pool: &PgPool) -> Result<()> {
    let missing: Vec<String> = sqlx::query_scalar(
        r#"
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
                ('public', 'integration_credentials'),
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
                ('public', 'integration_credentials', 'encrypted_value'),
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
                ('public', 'counterpoint_staging_batch', 'recovery_reason')
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

/// Upsert the three required POS layout products (RMS Charge Payment, Gift Card Load,
/// Alteration Service) so the register toolbar buttons never fail because a seed
/// script was skipped.  This is data, not schema DDL.
pub async fn ensure_core_pos_products(pool: &PgPool) -> Result<()> {
    let category_id: Uuid = "b7c0a001-0001-4001-8001-000000000001".parse()?;

    sqlx::query(
        r#"
        INSERT INTO public.categories (id, name, is_clothing_footwear, parent_id, created_at, matrix_row_axis_key, matrix_col_axis_key, tax_rules, variation_axis_presets)
        VALUES ($1, 'Internal / POS', false, NULL, NOW(), NULL, NULL, NULL, '{}')
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(category_id)
    .execute(pool)
    .await?;

    let products = vec![
        (
            "b7c0a002-0002-4002-8002-000000000002",
            "ros-rms-charge-payment",
            "RMS CHARGE PAYMENT",
            "R2S payment collection — add via Register search PAYMENT; enter amount on keypad.",
            "rms_charge_payment",
            "b7c0a003-0003-4003-8003-000000000003",
            "ROS-RMS-CHARGE-PAYMENT",
        ),
        (
            "b7c0a004-0004-4004-8004-000000000004",
            "ros-pos-gift-card-load",
            "POS GIFT CARD LOAD",
            "Register gift card value — add from Gift Card button; credit applies when the sale is fully paid.",
            "pos_gift_card_load",
            "b7c0a005-0005-4005-8005-000000000005",
            "ROS-POS-GIFT-CARD-LOAD",
        ),
        (
            "b7c0a006-0006-4006-8006-000000000006",
            "ros-alteration-service",
            "ALTERATION SERVICE",
            "Register alteration work-order service line. The source garment is tracked separately and is not sold again.",
            "alteration_service",
            "b7c0a007-0007-4007-8007-000000000007",
            "ROS-ALTERATION-SERVICE",
        ),
    ];

    for (pid, handle, name, description, kind, vid, sku) in products {
        let product_id: Uuid = pid.parse()?;
        let variant_id: Uuid = vid.parse()?;

        sqlx::query(
            r#"
            INSERT INTO public.products (
                id, category_id, catalog_handle, name, brand, description,
                base_retail_price, base_cost, spiff_amount, variation_axes, images,
                is_active, created_at, primary_vendor_id, excludes_from_loyalty,
                is_bundle, track_low_stock, pos_line_kind, data_source, tax_category,
                employee_markup_percent, employee_extra_amount
            ) VALUES (
                $1, $2, $3, $4, 'Riverside OS', $5,
                0.00, 0.00, 0.00, '{}', '{}',
                true, NOW(), NULL, true,
                false, false, $6, NULL, 'clothing',
                0.00, NULL
            )
            ON CONFLICT (id) DO NOTHING
            "#,
        )
        .bind(product_id)
        .bind(category_id)
        .bind(handle)
        .bind(name)
        .bind(description)
        .bind(kind)
        .execute(pool)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO public.product_variants (
                id, product_id, sku, variation_values, variation_label,
                stock_on_hand, reorder_point, images, retail_price_override,
                cost_override, created_at, shelf_labeled_at, barcode,
                reserved_stock, vendor_upc, counterpoint_item_key,
                track_low_stock, web_published, web_price_override,
                web_gallery_order, on_layaway, default_location_id
            ) VALUES (
                $1, $2, $3, '{}', NULL,
                0, 0, '{}', NULL,
                NULL, NOW(), NULL, NULL,
                0, NULL, NULL,
                false, false, NULL,
                0, 0, NULL
            )
            ON CONFLICT (id) DO NOTHING
            "#,
        )
        .bind(variant_id)
        .bind(product_id)
        .bind(sku)
        .execute(pool)
        .await?;
    }

    tracing::info!("Unified Engine: Core POS layout products verified/inserted.");
    Ok(())
}
