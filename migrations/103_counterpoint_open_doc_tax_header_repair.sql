-- Complete open-document tax repair by syncing transaction headers from taxed lines.
WITH repaired_open_doc_totals AS (
    SELECT
        t.id,
        ROUND(SUM(tl.quantity * (tl.unit_price + tl.state_tax + tl.local_tax))::numeric, 2) AS total_price
    FROM transactions t
    INNER JOIN transaction_lines tl ON tl.transaction_id = t.id
    WHERE t.counterpoint_doc_ref IS NOT NULL
      AND COALESCE(t.is_counterpoint_import, false)
    GROUP BY t.id, t.total_price, t.amount_paid
    HAVING ROUND(SUM(tl.quantity * (tl.state_tax + tl.local_tax))::numeric, 2) > 0
       AND ROUND(SUM(tl.quantity * (tl.unit_price + tl.state_tax + tl.local_tax))::numeric, 2)
           > ROUND(t.total_price::numeric, 2)
       AND ROUND(t.amount_paid::numeric, 2)
           >= ROUND(SUM(tl.quantity * (tl.unit_price + tl.state_tax + tl.local_tax))::numeric, 2) - 0.01
)
UPDATE transactions t
SET
    total_price = repaired_open_doc_totals.total_price,
    balance_due = ROUND((repaired_open_doc_totals.total_price - t.amount_paid)::numeric, 2)
FROM repaired_open_doc_totals
WHERE t.id = repaired_open_doc_totals.id;
