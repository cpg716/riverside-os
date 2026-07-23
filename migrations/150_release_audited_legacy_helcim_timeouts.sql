-- Release legacy Helcim terminal reservations only after an authorized manager
-- has recorded an explicit no-charge resolution. The provider attempt and its
-- recovery history remain in place for audit.
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
            AND action.metadata->>'resolution' = 'operator_confirmed_no_charge'
      )
    FOR UPDATE OF ppa
)
UPDATE payment_provider_attempts ppa
SET status = 'canceled',
    error_code = 'operator_confirmed_no_charge',
    error_message = 'Manager confirmed no provider charge; terminal reservation released. Original timeout evidence remains in the recovery audit.',
    completed_at = COALESCE(ppa.completed_at, now())
FROM eligible_attempts eligible
WHERE ppa.id = eligible.id;
