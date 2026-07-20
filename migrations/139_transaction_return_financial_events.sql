ALTER TABLE transaction_return_lines
    ADD COLUMN IF NOT EXISTS refund_event_id UUID,
    ADD COLUMN IF NOT EXISTS register_session_id UUID,
    ADD COLUMN IF NOT EXISTS refund_subtotal NUMERIC(14,2),
    ADD COLUMN IF NOT EXISTS refund_state_tax NUMERIC(14,2),
    ADD COLUMN IF NOT EXISTS refund_local_tax NUMERIC(14,2),
    ADD COLUMN IF NOT EXISTS refund_total NUMERIC(14,2);

UPDATE transaction_return_lines
SET refund_event_id = gen_random_uuid()
WHERE refund_event_id IS NULL;

ALTER TABLE transaction_return_lines
    ALTER COLUMN refund_event_id SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'transaction_return_lines_refund_components_nonnegative'
    ) THEN
        ALTER TABLE transaction_return_lines
            ADD CONSTRAINT transaction_return_lines_refund_components_nonnegative
            CHECK (
                (refund_subtotal IS NULL OR refund_subtotal >= 0)
                AND (refund_state_tax IS NULL OR refund_state_tax >= 0)
                AND (refund_local_tax IS NULL OR refund_local_tax >= 0)
                AND (refund_total IS NULL OR refund_total >= 0)
            );
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'transaction_return_lines_refund_components_balance'
    ) THEN
        ALTER TABLE transaction_return_lines
            ADD CONSTRAINT transaction_return_lines_refund_components_balance
            CHECK (
                refund_total IS NULL
                OR (
                    refund_subtotal IS NOT NULL
                    AND refund_state_tax IS NOT NULL
                    AND refund_local_tax IS NOT NULL
                    AND ROUND(refund_subtotal + refund_state_tax + refund_local_tax, 2) = refund_total
                )
            );
    END IF;
END $$;

-- Backfill only unambiguous legacy events: one return row and one negative refund
-- allocation for the same transaction and store-local day. The payment ledger is
-- the source for the refund total; the original line is used only to split tax.
WITH safe_events AS (
    SELECT
        trl.id AS return_line_id,
        trl.refund_event_id,
        pt.id AS payment_id,
        pt.session_id,
        ABS(pa.amount_allocated)::numeric(14,2) AS refund_total,
        tl.unit_price,
        tl.state_tax,
        tl.local_tax,
        COUNT(*) OVER (PARTITION BY trl.transaction_id, (trl.created_at AT TIME ZONE reporting.effective_store_timezone())::date) AS return_count,
        COUNT(*) OVER (PARTITION BY pa.target_transaction_id, COALESCE(pt.effective_date, (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date)) AS payment_count
    FROM transaction_return_lines trl
    INNER JOIN transaction_lines tl ON tl.id = trl.transaction_line_id
    INNER JOIN payment_allocations pa ON pa.target_transaction_id = trl.transaction_id
    INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
    WHERE pa.amount_allocated < 0
      AND COALESCE(pt.metadata->>'kind', '') IN ('order_refund', 'exchange_refund_remainder')
      AND (trl.created_at AT TIME ZONE reporting.effective_store_timezone())::date
          = COALESCE(pt.effective_date, (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date)
), eligible AS (
    SELECT *,
        ROUND(
            refund_total * COALESCE(state_tax, 0)
            / NULLIF(COALESCE(unit_price, 0) + COALESCE(state_tax, 0) + COALESCE(local_tax, 0), 0),
            2
        ) AS allocated_state_tax,
        ROUND(
            refund_total * COALESCE(local_tax, 0)
            / NULLIF(COALESCE(unit_price, 0) + COALESCE(state_tax, 0) + COALESCE(local_tax, 0), 0),
            2
        ) AS allocated_local_tax
    FROM safe_events
    WHERE return_count = 1 AND payment_count = 1
)
UPDATE transaction_return_lines trl
SET register_session_id = eligible.session_id,
    refund_state_tax = COALESCE(eligible.allocated_state_tax, 0),
    refund_local_tax = COALESCE(eligible.allocated_local_tax, 0),
    refund_subtotal = eligible.refund_total
        - COALESCE(eligible.allocated_state_tax, 0)
        - COALESCE(eligible.allocated_local_tax, 0),
    refund_total = eligible.refund_total
FROM eligible
WHERE trl.id = eligible.return_line_id
  AND trl.refund_total IS NULL;

WITH event_payments AS (
    SELECT DISTINCT ON (trl.refund_event_id)
        trl.refund_event_id,
        pt.id AS payment_id
    FROM transaction_return_lines trl
    INNER JOIN payment_allocations pa ON pa.target_transaction_id = trl.transaction_id
    INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
    WHERE trl.refund_total IS NOT NULL
      AND pa.amount_allocated < 0
      AND trl.register_session_id = pt.session_id
      AND (trl.created_at AT TIME ZONE reporting.effective_store_timezone())::date
          = COALESCE(pt.effective_date, (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date)
    ORDER BY trl.refund_event_id, pt.created_at, pt.id
)
UPDATE payment_transactions pt
SET metadata = COALESCE(pt.metadata, '{}'::jsonb)
    || jsonb_build_object('refund_event_id', event_payments.refund_event_id::text)
FROM event_payments
WHERE pt.id = event_payments.payment_id
  AND COALESCE(pt.metadata->>'refund_event_id', '') = '';

CREATE INDEX IF NOT EXISTS idx_transaction_return_lines_refund_event
    ON transaction_return_lines (refund_event_id);

CREATE INDEX IF NOT EXISTS idx_transaction_return_lines_session_created
    ON transaction_return_lines (register_session_id, created_at);
