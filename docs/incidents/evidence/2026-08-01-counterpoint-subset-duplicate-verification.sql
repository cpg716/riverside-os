-- Read-only post-apply verification for migration 176.
-- This query intentionally contains no repair statements.

WITH mapping(imported_display_id, canonical_display_id) AS (
    VALUES
        ('TXN-624275', 'TXN-624103'),
        ('TXN-624276', 'TXN-624104'),
        ('TXN-624281', 'TXN-624115'),
        ('TXN-624283', 'TXN-624118'),
        ('TXN-624290', 'TXN-624137')
), ids AS (
    SELECT
        mapping.*,
        imported.id AS imported_id,
        canonical.id AS canonical_id
    FROM mapping
    INNER JOIN transactions imported
        ON imported.display_id = mapping.imported_display_id
    INNER JOIN transactions canonical
        ON canonical.display_id = mapping.canonical_display_id
)
SELECT row_to_json(result)
FROM (
    SELECT
        ids.imported_display_id,
        ids.canonical_display_id,
        imported.status::text AS imported_status,
        imported.total_price AS imported_total,
        imported.amount_paid AS imported_paid,
        imported.balance_due AS imported_balance,
        imported.metadata->>'counterpoint_reconciliation_status'
            AS imported_reconciliation_status,
        canonical.status::text AS canonical_status,
        canonical.total_price AS canonical_total,
        canonical.amount_paid AS canonical_paid,
        canonical.balance_due AS canonical_balance,
        (
            SELECT ROUND(COALESCE(SUM(pa.amount_allocated), 0), 2)
            FROM payment_allocations pa
            WHERE pa.target_transaction_id = canonical.id
        ) AS canonical_allocated,
        (
            SELECT COUNT(*)
            FROM payment_allocations pa
            WHERE pa.target_transaction_id = imported.id
        ) AS imported_allocation_count,
        payment.status AS imported_payment_status,
        payment.amount AS imported_payment_amount,
        payment.provider_payment_id,
        payment.provider_transaction_id,
        (
            SELECT COUNT(*)
            FROM transaction_activity_log activity
            WHERE activity.transaction_id IN (imported.id, canonical.id)
              AND activity.event_kind = 'counterpoint_reconciliation'
              AND activity.metadata->>'review_manifest_digest' =
                  'c51ee1ff5902d35528a6f75f5c70a3cd978df4394bca379824f211e907427fed'
        ) AS activity_count
    FROM ids
    INNER JOIN transactions imported ON imported.id = ids.imported_id
    INNER JOIN transactions canonical ON canonical.id = ids.canonical_id
    INNER JOIN counterpoint_transaction_reconciliation reconciliation
        ON reconciliation.canonical_transaction_id = canonical.id
       AND imported.id = ANY(reconciliation.superseded_transaction_ids)
    INNER JOIN payment_transactions payment
        ON payment.id = ANY(reconciliation.superseded_payment_ids)
    ORDER BY ids.imported_display_id
) result;

SELECT row_to_json(result)
FROM (
    SELECT
        (
            SELECT COUNT(*)
            FROM ops_action_audit
            WHERE action_key = 'counterpoint-subset-duplicate-reconciliation-2026-08-01'
              AND payload_hash_sha256 =
                  'c51ee1ff5902d35528a6f75f5c70a3cd978df4394bca379824f211e907427fed'
              AND result_ok
        ) AS ops_audit_count,
        (
            SELECT COUNT(*)
            FROM transactions
            WHERE display_id IN (
                'TXN-624275', 'TXN-624276', 'TXN-624281',
                'TXN-624283', 'TXN-624290'
            )
              AND status = 'cancelled'
              AND total_price = 0
              AND amount_paid = 0
              AND balance_due = 0
        ) AS superseded_shell_count,
        (
            SELECT COUNT(*)
            FROM payment_transactions
            WHERE id IN (
                '94e3f1c8-3cf5-4c60-9408-7720a77fc385',
                '415019a5-66d0-4de1-90b8-d8106a5981eb',
                '58eaf5b2-8082-46bc-b90e-070ad8fc521c',
                '77ae51da-81e9-4b1e-a003-cfd327c7c94b',
                '0fcb06f1-08b8-4fd1-b693-e7d6e83185c8'
            )
              AND status = 'superseded'
              AND amount = 0
              AND provider_payment_id IS NULL
              AND provider_transaction_id IS NULL
        ) AS superseded_payment_count,
        (
            SELECT COUNT(*)
            FROM payment_allocations
            WHERE transaction_id IN (
                '94e3f1c8-3cf5-4c60-9408-7720a77fc385',
                '415019a5-66d0-4de1-90b8-d8106a5981eb',
                '58eaf5b2-8082-46bc-b90e-070ad8fc521c',
                '77ae51da-81e9-4b1e-a003-cfd327c7c94b',
                '0fcb06f1-08b8-4fd1-b693-e7d6e83185c8'
            )
        ) AS remaining_imported_allocations,
        (
            SELECT COUNT(*)
            FROM transaction_lines
            WHERE transaction_id IN (
                SELECT id FROM transactions
                WHERE display_id IN (
                    'TXN-624275', 'TXN-624276', 'TXN-624281',
                    'TXN-624283', 'TXN-624290'
                )
            )
        ) AS preserved_imported_lines,
        (
            SELECT COUNT(*)
            FROM transaction_return_lines
            WHERE transaction_id IN (
                SELECT id FROM transactions
                WHERE display_id IN (
                    'TXN-624103', 'TXN-624104', 'TXN-624115', 'TXN-624118',
                    'TXN-624137', 'TXN-624275', 'TXN-624276', 'TXN-624281',
                    'TXN-624283', 'TXN-624290'
                )
            )
        ) AS return_rows,
        (
            SELECT COUNT(*)
            FROM transaction_line_booking_events
            WHERE transaction_id IN (
                SELECT id FROM transactions
                WHERE display_id IN (
                    'TXN-624103', 'TXN-624104', 'TXN-624115', 'TXN-624118',
                    'TXN-624137', 'TXN-624275', 'TXN-624276', 'TXN-624281',
                    'TXN-624283', 'TXN-624290'
                )
            )
              AND created_at >= (
                  SELECT created_at
                  FROM ops_action_audit
                  WHERE action_key =
                      'counterpoint-subset-duplicate-reconciliation-2026-08-01'
                  ORDER BY created_at DESC
                  LIMIT 1
              )
        ) AS new_booking_events,
        (
            SELECT COUNT(*)
            FROM reporting.transaction_status_integrity
            WHERE transaction_id IN (
                SELECT id FROM transactions
                WHERE display_id IN (
                    'TXN-624103', 'TXN-624104', 'TXN-624115', 'TXN-624118',
                    'TXN-624137', 'TXN-624275', 'TXN-624276', 'TXN-624281',
                    'TXN-624283', 'TXN-624290'
                )
            )
              AND integrity_status <> 'ok'
        ) AS status_integrity_exceptions
) result;

SELECT row_to_json(result)
FROM (
    SELECT
        CONCAT_WS(' ', customer.first_name, customer.last_name) AS customer,
        ROUND(SUM(transaction.balance_due)
            FILTER (WHERE transaction.status <> 'cancelled'), 2) AS active_balance
    FROM customers customer
    INNER JOIN transactions transaction ON transaction.customer_id = customer.id
    WHERE customer.id IN (
        SELECT customer_id
        FROM transactions
        WHERE display_id IN (
            'TXN-624275', 'TXN-624276', 'TXN-624281',
            'TXN-624283', 'TXN-624290'
        )
    )
    GROUP BY customer.id, customer.first_name, customer.last_name
    ORDER BY customer
) result;
