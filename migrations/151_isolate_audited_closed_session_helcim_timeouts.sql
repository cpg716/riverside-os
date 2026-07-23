-- Preserve unresolved provider evidence from closed Register sessions without
-- allowing those historical attempts to reserve a terminal for a new sale.
WITH eligible_attempts AS (
    SELECT ppa.id
    FROM payment_provider_attempts ppa
    INNER JOIN register_sessions rs ON rs.id = ppa.register_session_id
    WHERE ppa.provider = 'helcim'
      AND ppa.status = 'expired'
      AND ppa.error_code = 'terminal_pending_timeout'
      AND NULLIF(BTRIM(COALESCE(ppa.provider_payment_id, '')), '') IS NULL
      AND NULLIF(BTRIM(COALESCE(ppa.provider_transaction_id, '')), '') IS NULL
      AND rs.is_open = false
      AND EXISTS (
          SELECT 1
          FROM helcim_terminal_recovery_actions action
          WHERE action.source_kind = 'payment_provider_attempt'
            AND action.source_id = ppa.id
            AND action.action = 'resolved_no_action'
            AND action.actor_staff_id IS NOT NULL
            AND action.metadata->>'resolution' = 'closed_session_timeout_isolated_from_new_sales'
      )
    FOR UPDATE OF ppa
)
UPDATE payment_provider_attempts ppa
SET error_code = 'closed_session_timeout_released',
    error_message = 'Historical closed-session timeout retained for audit and isolated from all new sales.'
FROM eligible_attempts eligible
WHERE ppa.id = eligible.id;
