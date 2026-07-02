-- Repair Counterpoint open documents where PS_DOC_HDR_TOT.TOT landed as merchandise
-- subtotal while tenders included tax, causing ROS to show tax as an overpayment.
WITH eligible_open_docs AS (
    SELECT
        t.id,
        ROUND(SUM(tl.quantity * tl.unit_price)::numeric, 2) AS subtotal,
        ROUND((t.amount_paid - SUM(tl.quantity * tl.unit_price))::numeric, 2) AS inferred_tax
    FROM transactions t
    INNER JOIN transaction_lines tl ON tl.transaction_id = t.id
    WHERE t.counterpoint_doc_ref IS NOT NULL
      AND COALESCE(t.is_counterpoint_import, false)
    GROUP BY t.id, t.total_price, t.amount_paid
    HAVING ROUND(SUM(tl.quantity * (tl.state_tax + tl.local_tax))::numeric, 2) = 0
       AND ROUND(SUM(tl.quantity * tl.unit_price)::numeric, 2) > 0
       AND ROUND(t.amount_paid::numeric, 2) > ROUND(t.total_price::numeric, 2)
       AND ROUND(t.total_price::numeric, 2) <= ROUND(SUM(tl.quantity * tl.unit_price)::numeric, 2) + 0.01
       AND (
           ROUND((t.amount_paid - SUM(tl.quantity * tl.unit_price))::numeric, 2)
           / NULLIF(ROUND(SUM(tl.quantity * tl.unit_price)::numeric, 2), 0)
       ) BETWEEN 0.03 AND 0.12
),
line_tax_targets AS (
    SELECT
        tl.id,
        e.inferred_tax,
        tl.quantity,
        ROUND((tl.quantity * tl.unit_price)::numeric, 2) AS line_subtotal,
        e.subtotal
    FROM transaction_lines tl
    INNER JOIN eligible_open_docs e ON e.id = tl.transaction_id
    WHERE tl.quantity > 0
),
line_tax_updates AS (
    UPDATE transaction_lines tl
    SET
        state_tax = ROUND(
            (
                LEAST(
                    ROUND((target.line_subtotal * 0.04)::numeric, 2),
                    ROUND((target.inferred_tax * target.line_subtotal / target.subtotal)::numeric, 2)
                ) / target.quantity
            )::numeric,
            2
        ),
        local_tax = ROUND(
            (
                (
                    ROUND((target.inferred_tax * target.line_subtotal / target.subtotal)::numeric, 2)
                    - LEAST(
                        ROUND((target.line_subtotal * 0.04)::numeric, 2),
                        ROUND((target.inferred_tax * target.line_subtotal / target.subtotal)::numeric, 2)
                    )
                ) / target.quantity
            )::numeric,
            2
        )
    FROM line_tax_targets target
    WHERE tl.id = target.id
    RETURNING tl.transaction_id
),
repaired_totals AS (
    SELECT
        t.id,
        ROUND(SUM(tl.quantity * (tl.unit_price + tl.state_tax + tl.local_tax))::numeric, 2) AS total_price
    FROM transactions t
    INNER JOIN transaction_lines tl ON tl.transaction_id = t.id
    WHERE t.id IN (SELECT DISTINCT transaction_id FROM line_tax_updates)
    GROUP BY t.id
)
UPDATE transactions t
SET
    total_price = repaired_totals.total_price,
    balance_due = ROUND((repaired_totals.total_price - t.amount_paid)::numeric, 2)
FROM repaired_totals
WHERE t.id = repaired_totals.id;
