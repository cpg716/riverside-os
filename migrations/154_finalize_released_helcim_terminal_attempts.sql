-- Finalize attempts that ROS already explicitly marked as released after the
-- physical terminal returned to ready or staff canceled it. Their evidence
-- remains intact; only the contradictory blocking status is corrected.
UPDATE payment_provider_attempts attempt
SET status = 'canceled',
    completed_at = COALESCE(attempt.completed_at, now())
WHERE attempt.provider = 'helcim'
  AND attempt.status = 'expired'
  AND attempt.error_code IN (
      'terminal_released_no_provider_reference',
      'closed_session_timeout_released'
  )
  AND NULLIF(BTRIM(COALESCE(attempt.provider_payment_id, '')), '') IS NULL
  AND NULLIF(BTRIM(COALESCE(attempt.provider_transaction_id, '')), '') IS NULL
  AND (
      attempt.register_session_id IS NULL
      OR EXISTS (
          SELECT 1
          FROM register_sessions session
          WHERE session.id = attempt.register_session_id
            AND session.is_open = false
            AND session.lifecycle_status = 'closed'
      )
  )
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
  );
