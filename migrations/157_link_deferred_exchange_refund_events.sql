-- Link deferred provider refunds to the return/exchange event that created
-- them. The original implementation issued a second refund_event_id when the
-- provider movement followed exchange settlement, which hid returned items
-- from Daily Sales and event receipt reprints.
--
-- This backfill is intentionally narrow: one exchange audit, one return event,
-- and one negative refund payment must reconcile exactly within ten minutes.
-- Ambiguous or financially mismatched rows are left untouched for review.
DROP TABLE IF EXISTS pg_temp.tmp_deferred_exchange_refund_event_backfill;

CREATE TEMP TABLE tmp_deferred_exchange_refund_event_backfill AS
WITH exchange_logs AS (
    SELECT
        activity.id AS activity_id,
        activity.transaction_id AS original_transaction_id,
        activity.created_at AS activity_created_at,
        NULLIF(activity.metadata->>'replacement_transaction_id', '')::uuid
            AS replacement_transaction_id,
        NULLIF(activity.metadata->>'exchange_group_id', '')::uuid
            AS exchange_group_id,
        COALESCE(NULLIF(activity.metadata->>'exchange_credit_amount', '')::numeric, 0)
            ::numeric(14,2) AS exchange_credit_amount,
        COALESCE(NULLIF(activity.metadata->>'refund_remainder_amount', '')::numeric, 0)
            ::numeric(14,2) AS recorded_refund_remainder_amount
    FROM transaction_activity_log activity
    WHERE activity.event_kind = 'exchange_settled'
      AND NULLIF(activity.metadata->>'replacement_transaction_id', '') IS NOT NULL
      AND NULLIF(activity.metadata->>'exchange_group_id', '') IS NOT NULL
      AND NULLIF(activity.metadata->>'refund_event_id', '') IS NULL
),
return_events AS (
    SELECT
        exchange.activity_id,
        exchange.original_transaction_id,
        exchange.replacement_transaction_id,
        exchange.exchange_group_id,
        exchange.exchange_credit_amount,
        exchange.recorded_refund_remainder_amount,
        exchange.activity_created_at,
        returned.refund_event_id,
        ROUND(SUM(returned.refund_total), 2)::numeric(14,2) AS return_total
    FROM exchange_logs exchange
    INNER JOIN transaction_return_lines returned
        ON returned.transaction_id = exchange.original_transaction_id
       AND returned.created_at BETWEEN exchange.activity_created_at - INTERVAL '10 minutes'
                                   AND exchange.activity_created_at + INTERVAL '10 minutes'
       AND returned.refund_total IS NOT NULL
    GROUP BY
        exchange.activity_id,
        exchange.original_transaction_id,
        exchange.replacement_transaction_id,
        exchange.exchange_group_id,
        exchange.exchange_credit_amount,
        exchange.recorded_refund_remainder_amount,
        exchange.activity_created_at,
        returned.refund_event_id
),
candidates AS (
    SELECT
        returned.*,
        payment.id AS payment_id,
        allocation.id AS payment_allocation_id,
        ABS(allocation.amount_allocated)::numeric(14,2) AS deferred_card_refund_amount,
        COUNT(*) OVER (PARTITION BY returned.activity_id) AS activity_candidate_count,
        COUNT(*) OVER (PARTITION BY payment.id) AS payment_candidate_count,
        COUNT(*) OVER (PARTITION BY returned.refund_event_id) AS return_candidate_count
    FROM return_events returned
    INNER JOIN payment_allocations allocation
        ON allocation.target_transaction_id = returned.original_transaction_id
       AND allocation.amount_allocated < 0
    INNER JOIN payment_transactions payment
        ON payment.id = allocation.transaction_id
       AND payment.created_at BETWEEN returned.activity_created_at - INTERVAL '10 minutes'
                                  AND returned.activity_created_at + INTERVAL '10 minutes'
       AND payment.status IN ('success', 'approved', 'captured')
       AND COALESCE(payment.metadata->>'kind', '') = 'order_refund'
       AND COALESCE(payment.metadata->>'refund_event_id', '') <> returned.refund_event_id::text
    WHERE NOT EXISTS (
        SELECT 1
        FROM transaction_return_lines already_linked
        WHERE already_linked.refund_event_id::text = payment.metadata->>'refund_event_id'
    )
      AND returned.return_total = ROUND(
          returned.exchange_credit_amount
          + returned.recorded_refund_remainder_amount
          + ABS(allocation.amount_allocated),
          2
      )
)
SELECT
    activity_id,
    original_transaction_id,
    replacement_transaction_id,
    exchange_group_id,
    exchange_credit_amount,
    recorded_refund_remainder_amount,
    activity_created_at,
    refund_event_id,
    return_total,
    payment_id,
    payment_allocation_id,
    deferred_card_refund_amount
FROM candidates
WHERE activity_candidate_count = 1
  AND payment_candidate_count = 1
  AND return_candidate_count = 1;

UPDATE payment_transactions payment
SET metadata = COALESCE(payment.metadata, '{}'::jsonb)
    || jsonb_build_object(
        'kind', 'exchange_refund_remainder',
        'refund_event_id', link.refund_event_id::text,
        'original_transaction_id', link.original_transaction_id::text,
        'replacement_transaction_id', link.replacement_transaction_id::text,
        'exchange_group_id', link.exchange_group_id::text
    )
FROM tmp_deferred_exchange_refund_event_backfill link
WHERE payment.id = link.payment_id;

UPDATE payment_allocations allocation
SET metadata = COALESCE(allocation.metadata, '{}'::jsonb)
    || jsonb_build_object(
        'kind', 'exchange_refund_remainder',
        'refund_event_id', link.refund_event_id::text,
        'original_transaction_id', link.original_transaction_id::text,
        'replacement_transaction_id', link.replacement_transaction_id::text,
        'exchange_group_id', link.exchange_group_id::text
    )
FROM tmp_deferred_exchange_refund_event_backfill link
WHERE allocation.id = link.payment_allocation_id;

UPDATE payment_transactions relief
SET metadata = COALESCE(relief.metadata, '{}'::jsonb)
    || jsonb_build_object(
        'refund_event_id', link.refund_event_id::text,
        'exchange_group_id', link.exchange_group_id::text
    )
FROM tmp_deferred_exchange_refund_event_backfill link
WHERE COALESCE(relief.metadata->>'kind', '') = 'exchange_credit_relief'
  AND relief.metadata->>'original_transaction_id' = link.original_transaction_id::text
  AND relief.metadata->>'replacement_transaction_id' = link.replacement_transaction_id::text
  AND relief.created_at BETWEEN link.activity_created_at - INTERVAL '10 minutes'
                            AND link.activity_created_at + INTERVAL '10 minutes'
  AND ABS(relief.amount) = link.exchange_credit_amount;

UPDATE payment_allocations relief_allocation
SET metadata = COALESCE(relief_allocation.metadata, '{}'::jsonb)
    || jsonb_build_object(
        'refund_event_id', link.refund_event_id::text,
        'original_transaction_id', link.original_transaction_id::text,
        'replacement_transaction_id', link.replacement_transaction_id::text,
        'exchange_group_id', link.exchange_group_id::text
    )
FROM payment_transactions relief,
     tmp_deferred_exchange_refund_event_backfill link
WHERE relief_allocation.transaction_id = relief.id
  AND COALESCE(relief.metadata->>'kind', '') = 'exchange_credit_relief'
  AND relief.metadata->>'original_transaction_id' = link.original_transaction_id::text
  AND relief.metadata->>'replacement_transaction_id' = link.replacement_transaction_id::text
  AND relief.created_at BETWEEN link.activity_created_at - INTERVAL '10 minutes'
                            AND link.activity_created_at + INTERVAL '10 minutes'
  AND ABS(relief.amount) = link.exchange_credit_amount;

UPDATE transaction_activity_log activity
SET metadata = COALESCE(activity.metadata, '{}'::jsonb)
    || jsonb_build_object(
        'refund_event_id', link.refund_event_id::text,
        'deferred_card_refund_amount', link.deferred_card_refund_amount
    )
FROM tmp_deferred_exchange_refund_event_backfill link
WHERE activity.id = link.activity_id
   OR (
       activity.transaction_id = link.replacement_transaction_id
       AND activity.event_kind = 'exchange_settled'
       AND activity.metadata->>'exchange_group_id' = link.exchange_group_id::text
       AND activity.metadata->>'original_transaction_id' = link.original_transaction_id::text
   );

DROP TABLE tmp_deferred_exchange_refund_event_backfill;
