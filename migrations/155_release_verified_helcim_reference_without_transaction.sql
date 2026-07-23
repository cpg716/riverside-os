-- Release one closed-session Terminal 1 reservation whose signed Helcim
-- terminalCancel event names the exact ROS payment reference. Preserve the
-- attempt, event, and recovery actions; create no payment movement.
WITH eligible_attempt AS (
    SELECT attempt.id
    FROM payment_provider_attempts attempt
    INNER JOIN register_sessions session
        ON session.id = attempt.register_session_id
    WHERE attempt.id = '0f4ff8e6-d3f8-4e64-90dd-e5a3bf880cd2'::uuid
      AND attempt.provider = 'helcim'
      AND attempt.status IN ('expired', 'canceled')
      AND attempt.error_code = 'terminal_released_no_provider_reference'
      AND attempt.amount_cents = 2500
      AND LOWER(BTRIM(attempt.currency)) = 'usd'
      AND attempt.register_session_id = '495984e7-a87c-4cc5-9ea0-5d2491729bea'::uuid
      AND attempt.checkout_client_id = 'd8b552fd-b639-4453-acce-009a7d1c38f7'::uuid
      AND attempt.staff_id = 'b43e32fb-45f9-4978-905d-7871252c9229'::uuid
      AND attempt.terminal_id = 'JFHP'
      AND attempt.device_id = 'JFHP'
      AND attempt.selected_terminal_key = 'terminal_1'
      AND attempt.provider_payment_id = 'ROS-0f4ff8e6d3f84e6490dde5a3bf880cd2'
      AND NULLIF(BTRIM(COALESCE(attempt.provider_transaction_id, '')), '') IS NULL
      AND attempt.raw_audit_reference = 'accepted'
      AND attempt.created_at = '2026-07-22T20:19:52.065251Z'::timestamptz
      AND session.is_open = false
      AND session.lifecycle_status = 'closed'
      AND NOT EXISTS (
          SELECT 1
          FROM payment_transactions payment
          WHERE payment.provider_payment_id = attempt.provider_payment_id
             OR payment.metadata->>'payment_provider_attempt_id' = attempt.id::text
             OR payment.metadata->>'provider_attempt_id' = attempt.id::text
             OR payment.metadata::text ILIKE '%' || attempt.id::text || '%'
      )
      AND EXISTS (
          SELECT 1
          FROM helcim_event_log event
          WHERE event.id = '2539a331-1e33-4722-85f1-077174998fc5'::uuid
            AND event.provider = 'helcim'
            AND event.event_type = 'terminalCancel'
            AND event.signature_valid = true
            AND event.processing_status = 'processed'
            AND event.provider_transaction_id IS NULL
            AND event.payment_transaction_id IS NULL
            AND event.payload_json->'data'->>'invoiceNumber' =
                attempt.provider_payment_id
            AND event.payload_json->'data'->>'deviceCode' = attempt.device_id
            AND UPPER(event.payload_json->'data'->>'currency') = 'USD'
            AND (event.payload_json->'data'->>'transactionAmount')::numeric =
                attempt.amount_cents::numeric / 100
      )
      AND EXISTS (
          SELECT 1
          FROM helcim_terminal_recovery_actions action
          WHERE action.source_kind = 'payment_provider_attempt'
            AND action.source_id = attempt.id
            AND action.action = 'resolved_no_action'
            AND action.actor_staff_id = 'bf085089-e50b-4247-ae0f-155d37803d41'::uuid
            AND action.metadata->>'resolution' =
                'provider_terminal_cancel_event_confirmed'
            AND action.metadata->>'helcim_event_id' =
                '2539a331-1e33-4722-85f1-077174998fc5'
            AND action.metadata->>'new_payment_created' = 'false'
            AND action.metadata->>'new_allocation_created' = 'false'
      )
    FOR UPDATE OF attempt
)
UPDATE payment_provider_attempts attempt
SET status = 'canceled',
    error_code = 'provider_terminal_cancel_confirmed',
    error_message =
        'Signed Helcim terminalCancel event confirmed cancellation; historical closed-session terminal reservation released with audit retained.',
    completed_at = COALESCE(attempt.completed_at, now())
FROM eligible_attempt
WHERE attempt.id = eligible_attempt.id;
