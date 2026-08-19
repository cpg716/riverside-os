\set ON_ERROR_STOP on

\if :{?expected_lines}
\else
  \echo 'expected_lines is required'
  \quit 2
\endif
\if :{?actor_staff_id}
\else
  \echo 'actor_staff_id is required'
  \quit 2
\endif
\if :{?catalog_manifest_sha256}
\else
  \echo 'catalog_manifest_sha256 is required'
  \quit 2
\endif
\if :{?cost_event_manifest_sha256}
\else
  \echo 'cost_event_manifest_sha256 is required'
  \quit 2
\endif
\if :{?line_manifest_sha256}
\else
  \echo 'line_manifest_sha256 is required'
  \quit 2
\endif

BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '15min';
SELECT pg_advisory_xact_lock(hashtext('ros-only-counterpoint-average-cost-line-repair'));

\i migrations/207_inventory_average_and_last_cost.sql

CREATE TEMP TABLE cp_average_cost_line_repair (
    transaction_line_id uuid PRIMARY KEY,
    transaction_id uuid NOT NULL,
    product_id uuid NOT NULL,
    variant_id uuid,
    catalog_handle text NOT NULL,
    prior_unit_cost numeric(12, 2) NOT NULL CHECK (prior_unit_cost >= 0),
    corrected_unit_cost numeric(12, 2) NOT NULL CHECK (corrected_unit_cost >= 0),
    quantity integer NOT NULL CHECK (quantity > 0),
    fulfillment text NOT NULL,
    booked_at timestamptz NOT NULL,
    recognition_at timestamptz,
    cost_basis text NOT NULL,
    basis_event_date date,
    returned_quantity integer NOT NULL CHECK (returned_quantity >= 0),
    effective_quantity integer NOT NULL CHECK (
        effective_quantity >= 0 AND effective_quantity <= quantity
    )
) ON COMMIT DROP;

CREATE TEMP TABLE cp_average_cost_line_control (
    expected_lines bigint NOT NULL
) ON COMMIT DROP;

INSERT INTO cp_average_cost_line_control (expected_lines)
VALUES (:expected_lines::bigint);

-- The caller replaces this placeholder with the client-local reviewed manifest.
\copy cp_average_cost_line_repair FROM '__LINE_MANIFEST_CSV__' WITH (FORMAT CSV, HEADER TRUE)

DO $$
DECLARE
    actual_lines bigint;
BEGIN
    SELECT COUNT(*) INTO actual_lines FROM cp_average_cost_line_repair;
    IF actual_lines <> (SELECT expected_lines FROM cp_average_cost_line_control) THEN
        RAISE EXCEPTION 'historical line manifest count mismatch: %', actual_lines;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM cp_average_cost_line_repair r
        LEFT JOIN transaction_lines tl ON tl.id = r.transaction_line_id
        LEFT JOIN transactions t ON t.id = r.transaction_id
        LEFT JOIN products p ON p.id = r.product_id
        WHERE tl.id IS NULL
           OR t.id IS NULL
           OR p.id IS NULL
           OR tl.transaction_id IS DISTINCT FROM r.transaction_id
           OR tl.product_id IS DISTINCT FROM r.product_id
           OR tl.variant_id IS DISTINCT FROM r.variant_id
           OR tl.quantity IS DISTINCT FROM r.quantity
           OR tl.unit_cost IS DISTINCT FROM r.prior_unit_cost
           OR t.booked_at IS DISTINCT FROM r.booked_at
           OR COALESCE(t.is_counterpoint_import, false)
           OR t.status::text = 'cancelled'
           OR COALESCE(tl.is_internal, false)
           OR lower(trim(p.catalog_handle)) <> lower(trim(r.catalog_handle))
           OR p.data_source <> 'counterpoint'
           OR r.prior_unit_cost = r.corrected_unit_cost
    ) THEN
        RAISE EXCEPTION 'transaction-line identity or expected-cost precondition failed';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM cp_average_cost_line_repair r
        JOIN suit_component_swap_events s ON s.order_item_id = r.transaction_line_id
    ) THEN
        RAISE EXCEPTION 'historical line manifest includes a suit/component swap';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM cp_average_cost_line_repair r
        LEFT JOIN LATERAL (
            SELECT COALESCE(SUM(trl.quantity_returned), 0)::integer AS returned_quantity
            FROM transaction_return_lines trl
            WHERE trl.transaction_line_id = r.transaction_line_id
        ) returns ON true
        WHERE returns.returned_quantity IS DISTINCT FROM r.returned_quantity
           OR GREATEST(r.quantity - returns.returned_quantity, 0)
                IS DISTINCT FROM r.effective_quantity
    ) THEN
        RAISE EXCEPTION 'return quantity changed after historical line manifest review';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM cp_average_cost_line_repair r
        JOIN transaction_return_lines trl
          ON trl.transaction_line_id = r.transaction_line_id
        JOIN inventory_transactions it
          ON it.reference_table = 'transaction_return_lines'
         AND it.reference_id = trl.id
        WHERE it.unit_cost IS NOT NULL
          AND it.unit_cost IS DISTINCT FROM r.prior_unit_cost
    ) THEN
        RAISE EXCEPTION 'return inventory ledger cost does not match reviewed prior cost';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM qbo_sync_logs q
        JOIN (
            SELECT DISTINCT
                (recognition_at AT TIME ZONE reporting.effective_store_timezone())::date AS recognition_date
            FROM cp_average_cost_line_repair
            WHERE recognition_at IS NOT NULL AND effective_quantity > 0
        ) dates ON dates.recognition_date = q.sync_date
        WHERE q.journal_entry_id IS NOT NULL
           OR q.status IN ('approved', 'synced', 'voided')
    ) THEN
        RAISE EXCEPTION 'affected recognition date has locked or externally posted QBO staging';
    END IF;
END
$$;

INSERT INTO inventory_average_cost_line_repair_audit (
    transaction_line_id,
    transaction_id,
    product_id,
    variant_id,
    catalog_handle,
    prior_unit_cost,
    corrected_unit_cost,
    quantity,
    returned_quantity,
    effective_quantity,
    booked_at,
    recognition_date,
    cost_basis,
    basis_event_date,
    catalog_manifest_sha256,
    cost_event_manifest_sha256,
    line_manifest_sha256,
    repaired_by_staff_id
)
SELECT
    r.transaction_line_id,
    r.transaction_id,
    r.product_id,
    r.variant_id,
    r.catalog_handle,
    r.prior_unit_cost,
    r.corrected_unit_cost,
    r.quantity,
    r.returned_quantity,
    r.effective_quantity,
    r.booked_at,
    (r.recognition_at AT TIME ZONE reporting.effective_store_timezone())::date,
    r.cost_basis,
    r.basis_event_date,
    :'catalog_manifest_sha256',
    :'cost_event_manifest_sha256',
    :'line_manifest_sha256',
    :'actor_staff_id'::uuid
FROM cp_average_cost_line_repair r;

WITH updated AS (
    UPDATE transaction_lines tl
    SET unit_cost = r.corrected_unit_cost
    FROM cp_average_cost_line_repair r
    WHERE tl.id = r.transaction_line_id
      AND tl.unit_cost = r.prior_unit_cost
    RETURNING 1
)
SELECT json_build_object('transaction_lines_updated', COUNT(*)) FROM updated;

WITH updated AS (
    UPDATE inventory_transactions it
    SET unit_cost = r.corrected_unit_cost
    FROM transaction_return_lines trl
    JOIN cp_average_cost_line_repair r
      ON r.transaction_line_id = trl.transaction_line_id
    WHERE it.reference_table = 'transaction_return_lines'
      AND it.reference_id = trl.id
      AND (it.unit_cost = r.prior_unit_cost OR it.unit_cost IS NULL)
    RETURNING 1
)
SELECT json_build_object('return_ledger_rows_updated', COUNT(*)) FROM updated;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM cp_average_cost_line_repair r
        JOIN transaction_lines tl ON tl.id = r.transaction_line_id
        WHERE tl.unit_cost IS DISTINCT FROM r.corrected_unit_cost
    ) THEN
        RAISE EXCEPTION 'historical line post-update verification failed';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM cp_average_cost_line_repair r
        JOIN transaction_return_lines trl
          ON trl.transaction_line_id = r.transaction_line_id
        JOIN inventory_transactions it
          ON it.reference_table = 'transaction_return_lines'
         AND it.reference_id = trl.id
        WHERE it.unit_cost IS DISTINCT FROM r.corrected_unit_cost
    ) THEN
        RAISE EXCEPTION 'return inventory ledger post-update verification failed';
    END IF;
END
$$;

SELECT json_build_object(
    'audited_lines', (SELECT COUNT(*) FROM cp_average_cost_line_repair),
    'transactions', (SELECT COUNT(DISTINCT transaction_id) FROM cp_average_cost_line_repair),
    'gross_line_cost_delta', (
        SELECT ROUND(SUM((corrected_unit_cost - prior_unit_cost) * quantity), 2)
        FROM cp_average_cost_line_repair
    ),
    'recognized_effective_cogs_delta', (
        SELECT ROUND(SUM((corrected_unit_cost - prior_unit_cost) * effective_quantity), 2)
        FROM cp_average_cost_line_repair
        WHERE recognition_at IS NOT NULL
    ),
    'line_manifest_sha256', :'line_manifest_sha256'
);

COMMIT;
