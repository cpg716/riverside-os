-- A pending Helcim attempt may reserve a physical terminal only while its
-- Register session is open. Closed or missing sessions remain reviewable, but
-- must never prevent a different checkout from starting a new card request.
UPDATE payment_provider_attempts attempt
SET status = 'expired',
    error_code = COALESCE(
        NULLIF(BTRIM(attempt.error_code), ''),
        'closed_session_pending_isolated'
    ),
    error_message = CONCAT_WS(
        ' ',
        NULLIF(BTRIM(attempt.error_message), ''),
        'Historical pending attempt retained for provider review and isolated from all new sales because its Register session is not open.'
    ),
    completed_at = COALESCE(attempt.completed_at, now())
WHERE attempt.provider = 'helcim'
  AND attempt.status = 'pending'
  AND COALESCE(attempt.terminal_id, attempt.device_id) IS NOT NULL
  AND (
      attempt.register_session_id IS NULL
      OR NOT EXISTS (
          SELECT 1
          FROM register_sessions session
          WHERE session.id = attempt.register_session_id
            AND session.is_open = true
            AND session.lifecycle_status = 'open'
      )
  );
