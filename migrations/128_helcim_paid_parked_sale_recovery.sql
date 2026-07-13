-- Permit audited conversion of an approved Helcim charge and retained parked cart
-- into the normal transaction/payment ledger without charging the card again.

ALTER TABLE public.helcim_terminal_recovery_actions
    DROP CONSTRAINT IF EXISTS helcim_terminal_recovery_actions_action_chk;

ALTER TABLE public.helcim_terminal_recovery_actions
    ADD CONSTRAINT helcim_terminal_recovery_actions_action_chk CHECK (
        action = ANY (
            ARRAY[
                'reviewed'::text,
                'noted'::text,
                'resolved_no_action'::text,
                'provider_charge_confirmed'::text,
                'duplicate_suspected'::text,
                'refund_required'::text,
                'replayed_webhook'::text,
                'recovered_transaction'::text
            ]
        )
    );

COMMENT ON TABLE public.helcim_terminal_recovery_actions IS
    'Append-only staff audit for Helcim review and guarded paid parked-sale recovery actions.';

-- Helcim returns timezone-free Card Transaction timestamps in Mountain Time.
-- Correct only rows that exactly match the former UTC interpretation so explicit-zone
-- timestamps and manually corrected records remain untouched. This is idempotent.
WITH raw_times AS (
    SELECT
        id,
        COALESCE(
            raw_payload->>'dateCreated',
            raw_payload->>'createdAt',
            raw_payload->>'occurredAt',
            raw_payload->'data'->>'dateCreated',
            raw_payload->'data'->>'createdAt',
            raw_payload->'data'->>'occurredAt'
        ) AS raw_time
    FROM public.payment_provider_batch_transactions
    WHERE provider = 'helcim'
)
UPDATE public.payment_provider_batch_transactions transaction
SET occurred_at = raw_times.raw_time::timestamp AT TIME ZONE 'America/Edmonton',
    updated_at = now()
FROM raw_times
WHERE transaction.id = raw_times.id
  AND raw_times.raw_time ~ '^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$'
  AND transaction.occurred_at = raw_times.raw_time::timestamp AT TIME ZONE 'UTC';
