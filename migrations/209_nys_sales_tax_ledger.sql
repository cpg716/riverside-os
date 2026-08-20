-- Auditable completed-sales tax ledger.
--
-- This is the tax-reporting equivalent of Riverside's Completed/Fulfilled basis:
-- paid takeaway sales enter on their sale date, paid pickup/ship transactions enter
-- on their recognition date, and settled returns enter on their settlement date.
-- Every dollar comes from tax and price amounts saved with the financial event.
-- The view never invokes the tax engine, current catalog rules, a source cutoff, or
-- a Z-close snapshot.

\set ON_ERROR_STOP on

DROP VIEW IF EXISTS reporting.nys_sales_tax_ledger;

CREATE VIEW reporting.nys_sales_tax_ledger AS
WITH transaction_completion AS (
    SELECT
        t.id AS transaction_id,
        t.display_id AS transaction_display_id,
        recognition.event_at,
        t.status::text AS status,
        t.balance_due,
        t.fulfillment_method::text AS fulfillment_type,
        t.counterpoint_ticket_ref,
        t.counterpoint_doc_ref,
        COALESCE(t.metadata->>'counterpoint_reconciliation_status', '')
            AS reconciliation_status,
        NULLIF(
            t.metadata #>> '{counterpoint_financial_evidence,source_header_tax_total}',
            ''
        )::numeric(14, 2) AS saved_header_tax_total
    FROM public.transactions t
    CROSS JOIN LATERAL (
        SELECT reporting.order_recognition_at(
            t.id,
            t.fulfillment_method::text,
            t.status::text,
            t.fulfilled_at
        ) AS event_at
    ) recognition
),
completed_transactions AS (
    SELECT
        completion.*,
        (completion.event_at AT TIME ZONE reporting.effective_store_timezone())::date
            AS business_date
    FROM transaction_completion completion
    WHERE completion.status <> 'cancelled'
      AND completion.balance_due IS NOT NULL
      AND ROUND(completion.balance_due, 2) <= 0
      AND completion.event_at IS NOT NULL
),
finalized_days AS MATERIALIZED (
    SELECT DISTINCT business_date
    FROM completed_transactions
    WHERE counterpoint_ticket_ref IS NOT NULL
),
selected_transactions AS (
    SELECT completed.*
    FROM completed_transactions completed
    WHERE completed.counterpoint_ticket_ref IS NOT NULL
       OR (
            NOT EXISTS (
                SELECT 1
                FROM finalized_days finalized
                WHERE finalized.business_date = completed.business_date
            )
            AND completed.counterpoint_ticket_ref IS NULL
            AND completed.counterpoint_doc_ref IS NULL
            AND completed.reconciliation_status <> 'superseded'
       )
),
completed_line_source AS (
    SELECT
        completed.transaction_id,
        completed.transaction_display_id,
        completed.event_at,
        completed.business_date,
        completed.fulfillment_type,
        completed.counterpoint_ticket_ref,
        completed.saved_header_tax_total,
        tl.id AS transaction_line_id,
        tl.fulfillment::text AS line_fulfillment_type,
        tl.quantity,
        tl.unit_price,
        tl.state_tax,
        tl.local_tax,
        CASE
            WHEN tl.unit_price IS NULL THEN 'completed line is missing its saved unit price'
            WHEN tl.state_tax IS NULL OR tl.local_tax IS NULL
                THEN 'completed line is missing a saved tax component'
            ELSE NULL
        END AS line_integrity_error
    FROM selected_transactions completed
    INNER JOIN public.transaction_lines tl
        ON tl.transaction_id = completed.transaction_id
    LEFT JOIN public.products product ON product.id = tl.product_id
    WHERE NOT COALESCE(tl.is_internal, FALSE)
      AND COALESCE(product.pos_line_kind, tl.custom_item_type)
            IS DISTINCT FROM 'rms_charge_payment'
      AND COALESCE(product.pos_line_kind, tl.custom_item_type)
            IS DISTINCT FROM 'pos_gift_card_load'
      AND COALESCE(product.pos_line_kind, tl.custom_item_type)
            IS DISTINCT FROM 'staff_account_payment'
),
completed_rollup AS (
    SELECT
        transaction_id AS event_id,
        transaction_id,
        transaction_display_id,
        event_at,
        business_date,
        CASE
            WHEN COUNT(DISTINCT line_fulfillment_type) = 1
                THEN MIN(line_fulfillment_type)
            ELSE fulfillment_type
        END AS fulfillment_type,
        counterpoint_ticket_ref IS NOT NULL AS uses_finalized_evidence,
        ROUND(SUM(unit_price * quantity), 2)::numeric(14, 2) AS gross_sales,
        ROUND(SUM(state_tax * quantity), 2)::numeric(14, 2) AS saved_state_tax,
        ROUND(SUM(local_tax * quantity), 2)::numeric(14, 2) AS saved_local_tax,
        ROUND(SUM(
            CASE
                WHEN ROUND((state_tax + local_tax) * quantity, 2) <> 0
                    THEN unit_price * quantity
                ELSE 0::numeric
            END
        ), 2)::numeric(14, 2) AS saved_taxable_sales,
        ROUND(SUM(
            CASE
                WHEN quantity < 0
                 AND ROUND((state_tax + local_tax) * quantity, 2) = 0
                    THEN unit_price * quantity
                ELSE 0::numeric
            END
        ), 2)::numeric(14, 2) AS zero_component_return_sales,
        MAX(saved_header_tax_total)::numeric(14, 2) AS saved_header_tax_total,
        MIN(line_integrity_error) FILTER (WHERE line_integrity_error IS NOT NULL)
            AS line_integrity_error
    FROM completed_line_source
    GROUP BY
        transaction_id,
        transaction_display_id,
        event_at,
        business_date,
        fulfillment_type,
        counterpoint_ticket_ref
),
completed_exact_tax AS (
    SELECT
        rollup.*,
        COALESCE(
            saved_header_tax_total,
            ROUND(saved_state_tax + saved_local_tax, 2)
        )::numeric(14, 2) AS exact_total_tax,
        ROUND(
            COALESCE(
                saved_header_tax_total,
                saved_state_tax + saved_local_tax
            ) - (saved_state_tax + saved_local_tax),
            2
        )::numeric(14, 2) AS tax_component_delta
    FROM completed_rollup rollup
),
completed_component_allocation AS (
    SELECT
        exact.*,
        CASE
            -- Preserve saved total tax. Historical negative completed-sale rows
            -- can lack a trustworthy jurisdiction split, so recover no more
            -- than the Erie portion and assign the exact residual to New York.
            WHEN gross_sales < 0 AND exact_total_tax < 0 THEN
                -LEAST(
                    ABS(exact_total_tax),
                    ROUND(ABS(gross_sales) * 0.0475, 2)
                ) - saved_local_tax
            WHEN tax_component_delta = 0 THEN 0::numeric
            ELSE 0::numeric
        END::numeric(14, 2) AS local_tax_delta
    FROM completed_exact_tax exact
),
completed_events AS (
    SELECT
        event_id,
        'completed_sale'::text AS event_kind,
        transaction_id,
        transaction_display_id,
        event_at,
        business_date,
        fulfillment_type,
        CASE
            WHEN uses_finalized_evidence THEN 'stored_finalized_completed_transaction'
            ELSE 'stored_completed_transaction'
        END::text AS amount_basis,
        gross_sales,
        ROUND(
            saved_taxable_sales
            + CASE
                WHEN zero_component_return_sales < 0 AND tax_component_delta < 0
                    THEN zero_component_return_sales
                ELSE 0::numeric
              END,
            2
        )::numeric(14, 2) AS taxable_sales,
        ROUND(
            gross_sales
            - saved_taxable_sales
            - CASE
                WHEN zero_component_return_sales < 0 AND tax_component_delta < 0
                    THEN zero_component_return_sales
                ELSE 0::numeric
              END,
            2
        )::numeric(14, 2) AS nontaxable_sales,
        ROUND(
            saved_state_tax + tax_component_delta - local_tax_delta,
            2
        )::numeric(14, 2) AS total_state_tax,
        ROUND(saved_local_tax + local_tax_delta, 2)::numeric(14, 2)
            AS total_local_tax,
        exact_total_tax::numeric(14, 2) AS total_tax_collected,
        CASE
            WHEN line_integrity_error IS NOT NULL THEN line_integrity_error
            WHEN exact_total_tax <> 0
             AND saved_state_tax = 0
             AND saved_local_tax = 0
             AND NOT (zero_component_return_sales < 0 AND tax_component_delta < 0)
                THEN 'saved total tax cannot be allocated to its state and local components'
            WHEN ROUND(
                    saved_state_tax + tax_component_delta - local_tax_delta
                    + saved_local_tax + local_tax_delta,
                    2
                 ) <> exact_total_tax
                THEN 'saved state and local tax do not reconcile to the saved total tax'
            ELSE NULL
        END AS integrity_error
    FROM completed_component_allocation
),
settled_return_source AS (
    SELECT
        trl.id AS event_id,
        trl.transaction_id,
        t.display_id AS transaction_display_id,
        settlement.event_at,
        (settlement.event_at AT TIME ZONE reporting.effective_store_timezone())::date
            AS business_date,
        tl.fulfillment::text AS fulfillment_type,
        trl.refund_event_id,
        trl.refund_subtotal,
        trl.refund_state_tax,
        trl.refund_local_tax,
        trl.refund_total,
        settlement.settled_amount,
        CASE
            WHEN trl.quantity_returned <= 0 THEN 'return quantity must be positive'
            WHEN trl.refund_subtotal IS NULL
              OR trl.refund_state_tax IS NULL
              OR trl.refund_local_tax IS NULL
              OR trl.refund_total IS NULL
                THEN 'settled return has incomplete saved refund components'
            WHEN ROUND(
                    trl.refund_subtotal
                    + trl.refund_state_tax
                    + trl.refund_local_tax,
                    2
                 ) <> trl.refund_total
                THEN 'settled return components do not reconcile to the saved refund total'
            WHEN ROUND(
                    (
                        SELECT SUM(sibling.refund_total)
                        FROM public.transaction_return_lines sibling
                        WHERE sibling.refund_event_id = trl.refund_event_id
                    ),
                    2
                 ) <> ROUND(settlement.settled_amount, 2)
                THEN 'return rows do not reconcile to the settled refund or exchange amount'
            ELSE NULL
        END AS integrity_error
    FROM public.transaction_return_lines trl
    INNER JOIN public.transaction_lines tl ON tl.id = trl.transaction_line_id
    INNER JOIN public.transactions t ON t.id = trl.transaction_id
    INNER JOIN transaction_completion original_completion
        ON original_completion.transaction_id = trl.transaction_id
    INNER JOIN LATERAL (
        SELECT settled.event_at, settled.settled_amount
        FROM (
            SELECT
                activity.created_at AS event_at,
                CASE activity.event_kind
                    WHEN 'refund_processed' THEN
                        NULLIF(activity.metadata->>'amount', '')::numeric
                    ELSE
                        COALESCE(
                            NULLIF(activity.metadata->>'exchange_credit_amount', '')::numeric,
                            0
                        )
                        + COALESCE(
                            NULLIF(activity.metadata->>'refund_remainder_amount', '')::numeric,
                            0
                        )
                        + COALESCE(
                            NULLIF(activity.metadata->>'deferred_card_refund_amount', '')::numeric,
                            0
                        )
                END::numeric(14, 2) AS settled_amount,
                1 AS authority_order
            FROM public.transaction_activity_log activity
            WHERE activity.transaction_id = trl.transaction_id
              AND activity.event_kind IN ('refund_processed', 'exchange_settled')
              AND activity.metadata->>'refund_event_id' = trl.refund_event_id::text

            UNION ALL

            SELECT
                (
                    MIN(COALESCE(
                        payment.effective_date,
                        (payment.created_at AT TIME ZONE reporting.effective_store_timezone())::date
                    ))::timestamp
                    AT TIME ZONE reporting.effective_store_timezone()
                ) AS event_at,
                COALESCE(
                    MAX(NULLIF(payment.metadata->>'exact_refund_amount', '')::numeric),
                    ABS(SUM(allocation.amount_allocated))
                )::numeric(14, 2) AS settled_amount,
                2 AS authority_order
            FROM public.payment_allocations allocation
            INNER JOIN public.payment_transactions payment
                ON payment.id = allocation.transaction_id
            WHERE allocation.target_transaction_id = trl.transaction_id
              AND allocation.amount_allocated < 0
              AND payment.status::text IN ('success', 'approved', 'captured')
              AND payment.metadata->>'refund_event_id' = trl.refund_event_id::text
            HAVING COUNT(*) > 0
        ) settled
        WHERE settled.event_at IS NOT NULL
          AND settled.settled_amount IS NOT NULL
        ORDER BY settled.authority_order, settled.event_at
        LIMIT 1
    ) settlement ON TRUE
    WHERE original_completion.event_at IS NOT NULL
      AND NOT COALESCE(tl.is_internal, FALSE)
      AND NOT EXISTS (
          SELECT 1
          FROM finalized_days finalized
          WHERE finalized.business_date = (
              settlement.event_at
              AT TIME ZONE reporting.effective_store_timezone()
          )::date
      )
),
settled_return_events AS (
    SELECT
        event_id,
        'settled_return'::text AS event_kind,
        transaction_id,
        transaction_display_id,
        event_at,
        business_date,
        fulfillment_type,
        'stored_settled_refund_event'::text AS amount_basis,
        (-refund_subtotal)::numeric(14, 2) AS gross_sales,
        CASE
            WHEN ROUND(refund_state_tax + refund_local_tax, 2) <> 0
                THEN (-refund_subtotal)::numeric(14, 2)
            ELSE 0::numeric(14, 2)
        END AS taxable_sales,
        CASE
            WHEN ROUND(refund_state_tax + refund_local_tax, 2) = 0
                THEN (-refund_subtotal)::numeric(14, 2)
            ELSE 0::numeric(14, 2)
        END AS nontaxable_sales,
        (-refund_state_tax)::numeric(14, 2) AS total_state_tax,
        (-refund_local_tax)::numeric(14, 2) AS total_local_tax,
        (-refund_total)::numeric(14, 2) AS total_tax_collected,
        integrity_error
    FROM settled_return_source
)
SELECT * FROM completed_events
UNION ALL
SELECT * FROM settled_return_events;

COMMENT ON VIEW reporting.nys_sales_tax_ledger IS
    'Auditable Completed/Fulfilled sales-tax ledger. Paid completed Transactions and settled returns are dated by their store-local financial event; totals use saved transaction/refund evidence, never current tax rules, source cutoffs, or Z-close snapshots; integrity failures block reporting.';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cube_ro') THEN
        GRANT SELECT ON reporting.nys_sales_tax_ledger TO cube_ro;
    END IF;
END$$;

INSERT INTO ros_schema_migrations (version)
VALUES ('209_nys_sales_tax_ledger.sql')
ON CONFLICT (version) DO NOTHING;
