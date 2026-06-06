-- Retire legacy transaction-level QBO outbox rows.
-- QBO sales posting now flows through reviewed Daily Staging Journal only.

UPDATE qbo_sync_outbox
SET status = 'retired_daily_staging_only',
    last_error = 'Retired: transaction-level QBO outbox no longer posts directly. Use reviewed Daily QBO Staging Journal.',
    updated_at = NOW()
WHERE status IN ('pending', 'processing', 'failed');
