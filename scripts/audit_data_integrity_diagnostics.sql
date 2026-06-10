-- Riverside OS data integrity diagnostics.
-- Read-only probes for operator-reviewed remediation before applying hardening migrations.

\echo '1. Helcim recovered payment rows missing provider columns'
SELECT id, amount, status, metadata
FROM payment_transactions
WHERE payment_method = 'card_terminal'
  AND payment_provider IS NULL
  AND metadata ? 'helcim_transaction_id'
ORDER BY created_at DESC;

\echo '2. Duplicate provider transaction ledger keys'
SELECT payment_provider, provider_transaction_id, COUNT(*) AS row_count
FROM payment_transactions
WHERE payment_provider IS NOT NULL
  AND provider_transaction_id IS NOT NULL
  AND btrim(provider_transaction_id) <> ''
GROUP BY payment_provider, provider_transaction_id
HAVING COUNT(*) > 1
ORDER BY row_count DESC, payment_provider, provider_transaction_id;

\echo '3. Duplicate checkout idempotency keys'
SELECT checkout_client_id, COUNT(*) AS row_count
FROM transactions
WHERE checkout_client_id IS NOT NULL
GROUP BY checkout_client_id
HAVING COUNT(*) > 1
ORDER BY row_count DESC, checkout_client_id;

\echo '4. Duplicate pending QBO daily staging rows'
SELECT sync_date, COUNT(*) AS pending_count
FROM qbo_sync_logs
WHERE status = 'pending'
GROUP BY sync_date
HAVING COUNT(*) > 1
ORDER BY sync_date DESC;

\echo '5. Open online checkout payment attempts per session/provider'
SELECT checkout_session_id, provider, COUNT(*) AS open_attempt_count
FROM store_checkout_payment_attempt
WHERE status IN ('pending', 'requires_action')
GROUP BY checkout_session_id, provider
HAVING COUNT(*) > 1
ORDER BY open_attempt_count DESC, checkout_session_id;

\echo '6. Migration ledger rows missing checksums'
SELECT version, applied_at
FROM ros_schema_migrations
WHERE file_sha256 IS NULL OR btrim(file_sha256) = ''
ORDER BY version;

\echo '7. Void gift cards with balance/event mismatch'
SELECT gc.id,
       gc.code,
       gc.card_status,
       gc.current_balance,
       latest_void.amount AS latest_void_amount,
       latest_void.balance_after AS latest_void_balance_after,
       latest_void.created_at AS latest_void_at
FROM gift_cards gc
LEFT JOIN LATERAL (
    SELECT amount, balance_after, created_at
    FROM gift_card_events
    WHERE gift_card_id = gc.id
      AND event_kind = 'voided'
    ORDER BY created_at DESC
    LIMIT 1
) latest_void ON TRUE
WHERE gc.card_status = 'void'
  AND (
      gc.current_balance <> 0
      OR latest_void.balance_after IS DISTINCT FROM 0
      OR latest_void.created_at IS NULL
  )
ORDER BY gc.code;

\echo '8. Backup health overdue or missing local success'
SELECT *
FROM store_backup_health
WHERE last_local_success_at IS NULL
   OR last_local_success_at < now() - interval '30 hours';
