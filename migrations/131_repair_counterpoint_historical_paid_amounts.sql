-- Counterpoint closed-ticket presentation must use the amount actually tendered.
-- Migration 094 replaced imported paid amounts with retail totals, which causes
-- returns and exchanges to credit the customer for money they did not pay.
WITH paid AS (
    SELECT
        t.id,
        ROUND(COALESCE(SUM(pa.amount_allocated), 0)::numeric, 2) AS paid_amount
    FROM public.transactions t
    INNER JOIN public.payment_allocations pa
        ON pa.target_transaction_id = t.id
    WHERE t.is_counterpoint_import
      AND t.counterpoint_ticket_ref IS NOT NULL
    GROUP BY t.id
), line_totals AS (
    SELECT
        t.id,
        paid.paid_amount,
        ROUND(SUM(tl.quantity * tl.unit_price)::numeric, 2) AS merchandise_subtotal,
        ROUND(SUM(tl.quantity * (COALESCE(tl.state_tax, 0) + COALESCE(tl.local_tax, 0)))::numeric, 2) AS line_tax,
        ROUND(COALESCE(t.total_price, 0)::numeric, 2) AS recorded_total
    FROM public.transactions t
    INNER JOIN paid ON paid.id = t.id
    INNER JOIN public.transaction_lines tl ON tl.transaction_id = t.id
    WHERE paid.paid_amount > 0
    GROUP BY t.id, paid.paid_amount, t.total_price
)
UPDATE public.transaction_lines tl
SET unit_price = ROUND(
    tl.unit_price * (line_totals.paid_amount - line_totals.line_tax)
        / NULLIF(line_totals.merchandise_subtotal, 0),
    2
)
FROM line_totals
WHERE tl.transaction_id = line_totals.id
  AND line_totals.paid_amount < line_totals.recorded_total - 0.01
  AND line_totals.paid_amount > line_totals.line_tax
  AND line_totals.merchandise_subtotal > 0
  AND tl.unit_price > 0;

WITH paid AS (
    SELECT
        t.id,
        ROUND(COALESCE(SUM(pa.amount_allocated), 0)::numeric, 2) AS paid_amount
    FROM public.transactions t
    INNER JOIN public.payment_allocations pa
        ON pa.target_transaction_id = t.id
    WHERE t.is_counterpoint_import
      AND t.counterpoint_ticket_ref IS NOT NULL
    GROUP BY t.id
)
UPDATE public.transactions t
SET total_price = paid.paid_amount,
    amount_paid = paid.paid_amount,
    balance_due = 0
FROM paid
WHERE t.id = paid.id
  AND paid.paid_amount > 0
  AND t.amount_paid >= t.total_price - 0.01
  AND paid.paid_amount < t.total_price - 0.01;

-- Rows without imported payment allocations are intentionally left unchanged;
-- their source tender total must be recovered from Counterpoint and re-imported.

UPDATE public.transactions t
SET metadata = jsonb_set(
    COALESCE(t.metadata, '{}'::jsonb),
    '{counterpoint_customer_code}',
    to_jsonb(c.customer_code::text),
    true
)
FROM public.customers c
WHERE t.customer_id = c.id
  AND t.is_counterpoint_import
  AND t.counterpoint_ticket_ref IS NOT NULL
  AND NULLIF(BTRIM(c.customer_code), '') IS NOT NULL
  AND NULLIF(BTRIM(t.metadata->>'counterpoint_customer_code'), '') IS NULL;
