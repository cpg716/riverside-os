-- Repair legacy custom-order SKU collisions before replaying migration 089.
--
-- Use when an existing database has pre-089 custom rows owning SKUs/item keys
-- 100, 105, 110, or 200, causing 089_restore_custom_order_catalog_skus.sql to
-- fail on product_variants_sku_key. The script preserves the legacy rows under
-- namespaced SKUs, clears their stale Counterpoint item keys, and clears orphaned
-- reserved_stock only when no transaction line references the variant.
--
-- Example:
--   docker compose exec -T db psql -U postgres -d riverside_os \
--     -v ON_ERROR_STOP=1 -f scripts/repair-migration-089-custom-sku-collisions.sql

\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
    IF EXISTS (
        WITH candidate AS (
            SELECT
                pv.id,
                CASE pv.sku
                    WHEN '100' THEN 'ROS-LEGACY-CUSTOM-100'
                    WHEN '105' THEN 'ROS-LEGACY-CUSTOM-105'
                    WHEN '110' THEN 'ROS-LEGACY-CUSTOM-110'
                    WHEN '200' THEN 'ROS-LEGACY-CUSTOM-200'
                    ELSE NULL
                END AS repair_sku
            FROM public.product_variants pv
            WHERE pv.sku IN ('100', '105', '110', '200')
              AND pv.id NOT IN (
                  'b7c0a015-0015-4015-8015-000000000015'::uuid,
                  'b7c0a016-0016-4016-8016-000000000016'::uuid,
                  'b7c0a017-0017-4017-8017-000000000017'::uuid,
                  'b7c0a018-0018-4018-8018-000000000018'::uuid
              )
        )
        SELECT 1
        FROM candidate c
        JOIN public.product_variants existing
          ON existing.sku = c.repair_sku
         AND existing.id <> c.id
    ) THEN
        RAISE EXCEPTION 'Cannot repair migration 089 SKU collisions: a ROS-LEGACY-CUSTOM-* repair SKU is already owned by another variant.';
    END IF;
END $$;

WITH candidates AS (
    SELECT
        pv.id AS variant_id,
        pv.product_id,
        pv.sku AS old_sku,
        pv.counterpoint_item_key AS old_counterpoint_item_key,
        pv.reserved_stock AS old_reserved_stock,
        pv.stock_on_hand AS old_stock_on_hand,
        pv.on_layaway AS old_on_layaway,
        p.name AS product_name,
        CASE pv.sku
            WHEN '100' THEN 'ROS-LEGACY-CUSTOM-100'
            WHEN '105' THEN 'ROS-LEGACY-CUSTOM-105'
            WHEN '110' THEN 'ROS-LEGACY-CUSTOM-110'
            WHEN '200' THEN 'ROS-LEGACY-CUSTOM-200'
        END AS repair_sku,
        (
            SELECT COUNT(*)::int
            FROM public.transaction_lines tl
            WHERE tl.variant_id = pv.id
        ) AS linked_transaction_lines
    FROM public.product_variants pv
    JOIN public.products p ON p.id = pv.product_id
    WHERE pv.sku IN ('100', '105', '110', '200')
      AND pv.id NOT IN (
          'b7c0a015-0015-4015-8015-000000000015'::uuid,
          'b7c0a016-0016-4016-8016-000000000016'::uuid,
          'b7c0a017-0017-4017-8017-000000000017'::uuid,
          'b7c0a018-0018-4018-8018-000000000018'::uuid
      )
),
updated AS (
    UPDATE public.product_variants pv
    SET
        sku = c.repair_sku,
        counterpoint_item_key = CASE
            WHEN pv.counterpoint_item_key IN ('100', '105', '110', '200') THEN NULL
            ELSE pv.counterpoint_item_key
        END,
        reserved_stock = CASE
            WHEN c.linked_transaction_lines = 0 THEN 0
            ELSE pv.reserved_stock
        END
    FROM candidates c
    WHERE pv.id = c.variant_id
    RETURNING
        pv.id AS variant_id,
        pv.product_id,
        c.product_name,
        c.old_sku,
        pv.sku AS new_sku,
        c.old_counterpoint_item_key,
        pv.counterpoint_item_key AS new_counterpoint_item_key,
        c.old_reserved_stock,
        pv.reserved_stock AS new_reserved_stock,
        c.old_stock_on_hand,
        c.old_on_layaway,
        c.linked_transaction_lines
),
audit AS (
    INSERT INTO public.product_catalog_audit_log (
        product_id,
        changed_by,
        change_source,
        before_values,
        after_values,
        change_note,
        suggestion_confidence
    )
    SELECT
        product_id,
        NULL,
        'migration_089_collision_repair',
        jsonb_build_object(
            'variant_id', variant_id,
            'product_name', product_name,
            'sku', old_sku,
            'counterpoint_item_key', old_counterpoint_item_key,
            'reserved_stock', old_reserved_stock,
            'stock_on_hand', old_stock_on_hand,
            'on_layaway', old_on_layaway,
            'linked_transaction_lines', linked_transaction_lines
        ),
        jsonb_build_object(
            'variant_id', variant_id,
            'sku', new_sku,
            'counterpoint_item_key', new_counterpoint_item_key,
            'reserved_stock', new_reserved_stock
        ),
        'Renamed legacy custom SKU to unblock migration 089 canonical custom-order seed rows.',
        1.0
    FROM updated
    RETURNING 1
)
SELECT
    COUNT(*) AS repaired_variants,
    COUNT(*) FILTER (WHERE old_reserved_stock <> new_reserved_stock) AS orphaned_reservations_cleared
FROM updated;

COMMIT;
