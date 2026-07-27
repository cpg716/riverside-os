UPDATE transactions AS t
SET balance_due = 0
WHERE COALESCE(t.amount_paid, 0) = 0
  AND COALESCE(t.balance_due, 0) <> 0
  AND EXISTS (
      SELECT 1
      FROM transaction_refund_queue AS q
      WHERE q.transaction_id = t.id
        AND q.is_open = FALSE
        AND q.amount_due > 0
        AND q.amount_refunded >= q.amount_due
  );
