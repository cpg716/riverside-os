-- Backfill deposit metadata for existing open deferred-fulfillment transactions.
-- Scope is intentionally narrow: open/pending transactions with only deferred
-- lines (Special, Custom, Wedding, Layaway), positive real tender allocations,
-- and no existing applied_deposit_amount marker.

WITH pure_open_deferred_targets AS (
    SELECT
        t.id AS transaction_id
    FROM public.transactions t
    INNER JOIN public.transaction_lines tl ON tl.transaction_id = t.id
    WHERE t.status::text IN ('open', 'pending_measurement')
    GROUP BY t.id
    HAVING COUNT(*) FILTER (
        WHERE tl.fulfillment::text IN ('special_order', 'custom', 'wedding_order', 'layaway')
    ) > 0
       AND COUNT(*) FILTER (
        WHERE tl.fulfillment::text = 'takeaway'
    ) = 0
),
candidate_allocations AS (
    SELECT
        pa.id,
        pa.amount_allocated
    FROM public.payment_allocations pa
    INNER JOIN pure_open_deferred_targets target
        ON target.transaction_id = pa.target_transaction_id
    INNER JOIN public.payment_transactions pt
        ON pt.id = pa.transaction_id
    WHERE pa.amount_allocated > 0::numeric
      AND LOWER(TRIM(pt.payment_method)) NOT IN ('deposit_ledger', 'open_deposit')
      AND NULLIF(TRIM(COALESCE(pa.metadata->>'applied_deposit_amount', '')), '') IS NULL
)
UPDATE public.payment_allocations pa
SET metadata = COALESCE(pa.metadata, '{}'::jsonb) || jsonb_build_object(
    'applied_deposit_amount', ROUND(candidate.amount_allocated, 2)::text,
    'deposit_backfill_migration', '119_backfill_open_deferred_payment_deposit_metadata.sql',
    'deposit_classification', 'deferred_payment_before_fulfillment'
)
FROM candidate_allocations candidate
WHERE pa.id = candidate.id;
