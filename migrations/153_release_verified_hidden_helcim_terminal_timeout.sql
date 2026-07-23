-- Release one hidden legacy Terminal 1 reservation after a current authorized
-- provider refresh found no exact Helcim transaction. Preserve the original
-- attempt and both recovery actions for audit; create no payment movement.
WITH eligible_attempt AS (
    SELECT attempt.id
    FROM payment_provider_attempts attempt
    WHERE attempt.id = 'ceafe1e2-b45b-4153-80e0-8d8260bda649'::uuid
      AND attempt.provider = 'helcim'
      AND attempt.status = 'expired'
      AND attempt.error_code = 'terminal_pending_timeout'
      AND attempt.amount_cents = 23065
      AND LOWER(BTRIM(attempt.currency)) = 'usd'
      AND attempt.register_session_id IS NULL
      AND attempt.checkout_client_id IS NULL
      AND attempt.staff_id IS NULL
      AND attempt.terminal_id = 'JFHP'
      AND attempt.device_id = 'JFHP'
      AND attempt.selected_terminal_key = 'terminal_1'
      AND NULLIF(BTRIM(COALESCE(attempt.provider_payment_id, '')), '') IS NULL
      AND NULLIF(BTRIM(COALESCE(attempt.provider_transaction_id, '')), '') IS NULL
      AND attempt.raw_audit_reference = 'accepted'
      AND attempt.created_at = '2026-06-30T15:41:12.307936Z'::timestamptz
      AND NOT EXISTS (
          SELECT 1
          FROM payment_transactions payment
          WHERE payment.metadata->>'payment_provider_attempt_id' = attempt.id::text
             OR payment.metadata->>'provider_attempt_id' = attempt.id::text
             OR payment.metadata::text ILIKE '%' || attempt.id::text || '%'
      )
      AND NOT EXISTS (
          SELECT 1
          FROM helcim_event_log event
          WHERE event.payment_provider_attempt_id = attempt.id
             OR event.payload_json::text ILIKE '%' || attempt.id::text || '%'
      )
      AND EXISTS (
          SELECT 1
          FROM helcim_terminal_recovery_actions action
          WHERE action.source_kind = 'payment_provider_attempt'
            AND action.source_id = attempt.id
            AND action.action = 'resolved_no_action'
            AND action.actor_staff_id = 'bf085089-e50b-4247-ae0f-155d37803d41'::uuid
            AND action.metadata->>'resolution' =
                'provider_refresh_no_exact_match_hidden_legacy_timeout'
      )
    FOR UPDATE OF attempt
)
UPDATE payment_provider_attempts attempt
SET status = 'canceled',
    error_code = 'operator_confirmed_no_provider_match',
    error_message =
        'Current provider refresh found no exact Helcim transaction; hidden legacy Terminal 1 reservation released with audit retained.',
    completed_at = COALESCE(attempt.completed_at, now())
FROM eligible_attempt
WHERE attempt.id = eligible_attempt.id;
