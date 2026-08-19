\set ON_ERROR_STOP on

\if :{?expected_products}
\else
  \echo 'expected_products is required'
  \quit 2
\endif
\if :{?expected_variants}
\else
  \echo 'expected_variants is required'
  \quit 2
\endif
\if :{?actor_staff_id}
\else
  \echo 'actor_staff_id is required'
  \quit 2
\endif
\if :{?manifest_sha256}
\else
  \echo 'manifest_sha256 is required'
  \quit 2
\endif

BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '15min';
SELECT pg_advisory_xact_lock(hashtext('ros-only-counterpoint-average-cost-repair'));

\i migrations/207_inventory_average_and_last_cost.sql

CREATE TEMP TABLE cp_average_cost_repair (
    product_id UUID PRIMARY KEY,
    catalog_handle TEXT NOT NULL,
    expected_base_cost NUMERIC(12, 2) NOT NULL,
    average_cost NUMERIC(12, 2) NOT NULL CHECK (average_cost >= 0),
    last_cost NUMERIC(12, 2) NOT NULL CHECK (last_cost >= 0),
    variant_count BIGINT NOT NULL CHECK (variant_count >= 0)
) ON COMMIT DROP;

CREATE TEMP TABLE cp_average_cost_control (
    expected_products BIGINT NOT NULL,
    expected_variants BIGINT NOT NULL
) ON COMMIT DROP;

INSERT INTO cp_average_cost_control (expected_products, expected_variants)
VALUES (:expected_products::BIGINT, :expected_variants::BIGINT);

-- The caller replaces this placeholder with the client-local reviewed manifest.
\copy cp_average_cost_repair FROM '__MANIFEST_CSV__' WITH (FORMAT CSV, HEADER TRUE)

DO $$
DECLARE
    actual_products BIGINT;
    actual_variants BIGINT;
BEGIN
    SELECT COUNT(*) INTO actual_products FROM cp_average_cost_repair;
    IF actual_products <> (SELECT expected_products FROM cp_average_cost_control) THEN
        RAISE EXCEPTION 'manifest product count mismatch: %', actual_products;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM cp_average_cost_repair r
        LEFT JOIN products p ON p.id = r.product_id
        WHERE p.id IS NULL
           OR lower(trim(p.catalog_handle)) <> lower(trim(r.catalog_handle))
           OR p.base_cost IS DISTINCT FROM r.expected_base_cost
           OR p.data_source <> 'counterpoint'
    ) THEN
        RAISE EXCEPTION 'product identity or expected-cost precondition failed';
    END IF;

    SELECT COUNT(*)
    INTO actual_variants
    FROM product_variants pv
    JOIN cp_average_cost_repair r ON r.product_id = pv.product_id;

    IF actual_variants <> (SELECT expected_variants FROM cp_average_cost_control)
       OR actual_variants <> (SELECT SUM(variant_count) FROM cp_average_cost_repair)
    THEN
        RAISE EXCEPTION 'variant count mismatch: %', actual_variants;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM inventory_transactions it
        JOIN product_variants pv ON pv.id = it.variant_id
        JOIN cp_average_cost_repair r ON r.product_id = pv.product_id
        WHERE it.tx_type = 'po_receipt'
    ) THEN
        RAISE EXCEPTION 'matched variation has an ROS PO receipt; WAC replay required';
    END IF;
END
$$;

WITH inserted AS (
    INSERT INTO product_catalog_audit_log (
        product_id,
        changed_by,
        change_source,
        before_values,
        after_values,
        change_note
    )
    SELECT
        p.id,
        :'actor_staff_id'::UUID,
        'counterpoint_avg_cost_ros_only_repair',
        jsonb_build_object(
            'base_cost', p.base_cost,
            'matched_variant_count', r.variant_count
        ),
        jsonb_build_object(
            'base_average_cost', r.average_cost,
            'base_last_cost', r.last_cost,
            'matched_variant_count', r.variant_count,
            'manifest_sha256', :'manifest_sha256'
        ),
        'Exact ROS-only repair from Counterpoint IM_INV MAIN AVG_COST and LST_COST; no Bridge and no inventory reimport.'
    FROM cp_average_cost_repair r
    JOIN products p ON p.id = r.product_id
    RETURNING 1
)
SELECT json_build_object('audit_rows', COUNT(*)) FROM inserted;

WITH updated AS (
    UPDATE products p
    SET
        base_cost = r.average_cost,
        last_cost = r.last_cost
    FROM cp_average_cost_repair r
    WHERE p.id = r.product_id
    RETURNING 1
)
SELECT json_build_object('products_updated', COUNT(*)) FROM updated;

WITH updated AS (
    UPDATE product_variants pv
    SET
        cost_override = r.average_cost,
        last_cost_override = r.last_cost
    FROM cp_average_cost_repair r
    WHERE pv.product_id = r.product_id
    RETURNING 1
)
SELECT json_build_object('variants_updated', COUNT(*)) FROM updated;

WITH updated AS (
    UPDATE inventory_transactions it
    SET unit_cost = r.average_cost
    FROM product_variants pv
    JOIN cp_average_cost_repair r ON r.product_id = pv.product_id
    WHERE it.variant_id = pv.id
      AND it.reference_table = 'counterpoint_inventory_baseline'
    RETURNING 1
)
SELECT json_build_object('baseline_rows_updated', COUNT(*)) FROM updated;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM cp_average_cost_repair r
        JOIN products p ON p.id = r.product_id
        WHERE p.base_cost IS DISTINCT FROM r.average_cost
           OR p.last_cost IS DISTINCT FROM r.last_cost
    ) THEN
        RAISE EXCEPTION 'post-update product cost verification failed';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM cp_average_cost_repair r
        JOIN product_variants pv ON pv.product_id = r.product_id
        WHERE pv.cost_override IS DISTINCT FROM r.average_cost
           OR pv.last_cost_override IS DISTINCT FROM r.last_cost
    ) THEN
        RAISE EXCEPTION 'post-update variant cost verification failed';
    END IF;
END
$$;

SELECT json_build_object(
    'matched_products', (SELECT COUNT(*) FROM cp_average_cost_repair),
    'matched_variants', (
        SELECT COUNT(*)
        FROM product_variants pv
        JOIN cp_average_cost_repair r ON r.product_id = pv.product_id
    ),
    'on_hand_units', (
        SELECT COALESCE(SUM(pv.stock_on_hand), 0)
        FROM product_variants pv
        JOIN cp_average_cost_repair r ON r.product_id = pv.product_id
    ),
    'corrected_inventory_asset', (
        SELECT ROUND(COALESCE(SUM(pv.stock_on_hand::NUMERIC * pv.cost_override), 0), 2)
        FROM product_variants pv
        JOIN cp_average_cost_repair r ON r.product_id = pv.product_id
    ),
    'manifest_sha256', :'manifest_sha256'
);

COMMIT;
