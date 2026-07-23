-- Resolve two historical checkout-recovery rows only after proving that each
-- approved Helcim order payment already exists in the normalized ROS payment
-- ledger and is allocated exactly once to its intended Transaction Record.
-- No payment, allocation, sale, or provider-attempt row is created or changed.
WITH expected (
    client_job_key,
    checkout_client_id,
    register_session_id,
    target_transaction_id,
    target_display_id,
    attempt_id,
    payment_transaction_id,
    provider_transaction_id,
    provider_payment_id,
    amount,
    customer_id,
    manager_staff_id
) AS (
    VALUES
        (
            'checkout:recovery:online_unconfirmed:645307c4-24e3-4b7d-9789-ec04441c1a79',
            '645307c4-24e3-4b7d-9789-ec04441c1a79'::uuid,
            '495984e7-a87c-4cc5-9ea0-5d2491729bea'::uuid,
            '8dac3b9e-45b4-41b6-8d69-c2b49c88c53c'::uuid,
            'TXN-566158',
            'a024aa17-b3e8-404d-8d50-d9389844d1d4'::uuid,
            'beeacd4f-d747-4044-ac69-530315644c2d'::uuid,
            '51944701',
            'ROS-a024aa17b3e8404d8d50d9389844d1d4',
            142.75::numeric,
            '61d9c5fa-d526-455b-b686-555d29cbf4dd'::uuid,
            'bf085089-e50b-4247-ae0f-155d37803d41'::uuid
        ),
        (
            'checkout:recovery:online_unconfirmed:43188d7e-9fad-42d5-9a49-a2cf7b0a6696',
            '43188d7e-9fad-42d5-9a49-a2cf7b0a6696'::uuid,
            '495984e7-a87c-4cc5-9ea0-5d2491729bea'::uuid,
            '80864591-1a96-4319-9225-ed4621d448f9'::uuid,
            'TXN-566367',
            '8f31768a-4a10-4cd5-835b-848bd34427f5'::uuid,
            '130b6e56-e8f5-438c-896a-1f60a5a034e1'::uuid,
            '51947445',
            'cbba24ad3cfe768d65b149',
            174.22::numeric,
            '51d7bddc-9e80-4a3d-b4ef-62075bfa9e61'::uuid,
            'bf085089-e50b-4247-ae0f-155d37803d41'::uuid
        )
),
verified AS (
    SELECT expected.*, job.id AS recovery_job_id
    FROM expected
    INNER JOIN operational_recovery_job job
        ON job.client_job_key = expected.client_job_key
       AND job.kind = 'checkout_unconfirmed'
       AND job.register_session_id = expected.register_session_id
       AND job.checkout_client_id = expected.checkout_client_id
       AND (
            (
                job.status = 'blocked'
                AND job.transaction_id IS NULL
            )
            OR (
                job.status = 'resolved'
                AND job.transaction_id = expected.target_transaction_id
                AND job.resolved_by_staff_id = expected.manager_staff_id
                AND job.resolution_note =
                    'Verified Helcim order payment was already recorded and allocated; stale recovery completed.'
            )
       )
    INNER JOIN payment_provider_attempts attempt
        ON attempt.id = expected.attempt_id
       AND LOWER(BTRIM(attempt.provider)) = 'helcim'
       AND attempt.status IN ('approved', 'captured')
       AND attempt.amount_cents = (expected.amount * 100)::bigint
       AND LOWER(BTRIM(attempt.currency)) = 'usd'
       AND attempt.register_session_id = expected.register_session_id
       AND attempt.checkout_client_id = expected.checkout_client_id
       AND attempt.provider_transaction_id = expected.provider_transaction_id
       AND attempt.provider_payment_id = expected.provider_payment_id
       AND attempt.error_code IS NULL
       AND attempt.completed_at IS NOT NULL
    INNER JOIN payment_transactions payment
        ON payment.id = expected.payment_transaction_id
       AND LOWER(BTRIM(COALESCE(payment.payment_provider, ''))) = 'helcim'
       AND payment.status = 'success'
       AND LOWER(BTRIM(COALESCE(payment.provider_status, ''))) IN ('approved', 'captured')
       AND payment.amount = expected.amount
       AND payment.session_id = expected.register_session_id
       AND payment.payer_id = expected.customer_id
       AND payment.provider_transaction_id = expected.provider_transaction_id
    INNER JOIN payment_allocations allocation
        ON allocation.transaction_id = payment.id
       AND allocation.target_transaction_id = expected.target_transaction_id
       AND allocation.amount_allocated = expected.amount
    INNER JOIN transactions target
        ON target.id = expected.target_transaction_id
       AND target.display_id = expected.target_display_id
       AND target.customer_id = expected.customer_id
       AND target.status::text = 'fulfilled'
       AND target.amount_paid = target.total_price
    WHERE job.last_error ILIKE '%order payment target transaction is not open%'
      AND job.payload->'payload'->>'session_id' = expected.register_session_id::text
      AND job.payload->'payload'->>'checkout_client_id' = expected.checkout_client_id::text
      AND job.payload->'payload'->>'customer_id' = expected.customer_id::text
      AND (job.payload->'payload'->>'total_price')::numeric = 0
      AND (job.payload->'payload'->>'amount_paid')::numeric = expected.amount
      AND jsonb_array_length(COALESCE(job.payload->'payload'->'items', '[]'::jsonb)) = 0
      AND jsonb_array_length(COALESCE(job.payload->'payload'->'order_payments', '[]'::jsonb)) = 1
      AND job.payload->'payload'->'order_payments'->0->>'target_transaction_id' =
          expected.target_transaction_id::text
      AND job.payload->'payload'->'order_payments'->0->>'target_display_id' =
          expected.target_display_id
      AND (job.payload->'payload'->'order_payments'->0->>'amount')::numeric =
          expected.amount
      AND jsonb_array_length(COALESCE(job.payload->'payload'->'payment_splits', '[]'::jsonb)) = 1
      AND (job.payload->'payload'->'payment_splits'->0->>'amount')::numeric =
          expected.amount
      AND job.payload->'payload'->'payment_splits'->0->'metadata'->>'payment_provider' =
          'helcim'
      AND job.payload->'payload'->'payment_splits'->0->'metadata'->>'payment_provider_attempt_id' =
          expected.attempt_id::text
      AND job.payload->'payload'->'payment_splits'->0->'metadata'->>'provider_transaction_id' =
          expected.provider_transaction_id
      AND job.payload->'payload'->'payment_splits'->0->'metadata'->>'provider_payment_id' =
          expected.provider_payment_id
      AND LOWER(
          job.payload->'payload'->'payment_splits'->0->'metadata'->>'provider_status'
      ) IN ('approved', 'captured')
      AND (
          SELECT COUNT(*)
          FROM payment_provider_attempts candidate
          WHERE LOWER(BTRIM(candidate.provider)) = 'helcim'
            AND candidate.provider_transaction_id = expected.provider_transaction_id
      ) = 1
      AND (
          SELECT COUNT(*)
          FROM payment_transactions candidate
          WHERE LOWER(BTRIM(COALESCE(candidate.payment_provider, ''))) = 'helcim'
            AND candidate.provider_transaction_id = expected.provider_transaction_id
      ) = 1
      AND (
          SELECT COUNT(*)
          FROM payment_allocations candidate
          WHERE candidate.transaction_id = expected.payment_transaction_id
      ) = 1
      AND (
          SELECT ROUND(COALESCE(SUM(candidate.amount_allocated), 0), 2)
          FROM payment_allocations candidate
          WHERE candidate.target_transaction_id = expected.target_transaction_id
      ) = ROUND(target.amount_paid, 2)
),
updated AS (
    UPDATE operational_recovery_job job
    SET status = 'resolved',
        transaction_id = verified.target_transaction_id,
        resolved_at = COALESCE(job.resolved_at, now()),
        resolved_by_staff_id = verified.manager_staff_id,
        resolution_note =
            'Verified Helcim order payment was already recorded and allocated; stale recovery completed.',
        last_seen_at = now()
    FROM verified
    WHERE job.id = verified.recovery_job_id
      AND job.status = 'blocked'
    RETURNING job.id
)
INSERT INTO staff_access_log (
    staff_id,
    event_kind,
    metadata,
    idempotency_key
)
SELECT
    verified.manager_staff_id,
    'register_checkout_recovery_order_payment_resolved',
    jsonb_build_object(
        'client_job_key', verified.client_job_key,
        'register_session_id', verified.register_session_id,
        'checkout_client_id', verified.checkout_client_id,
        'transaction_id', verified.target_transaction_id,
        'transaction_display_id', verified.target_display_id,
        'payment_transaction_id', verified.payment_transaction_id,
        'payment_provider_attempt_id', verified.attempt_id,
        'provider_transaction_id', verified.provider_transaction_id,
        'provider_payment_id', verified.provider_payment_id,
        'payment_amount', verified.amount,
        'customer_id', verified.customer_id,
        'resolution_path', 'verified_existing_order_payment',
        'new_payment_created', false,
        'new_allocation_created', false
    ),
    'register-checkout-recovery-order-payment:' ||
        verified.client_job_key || ':' || verified.target_transaction_id::text
FROM verified
ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM operational_recovery_job
        WHERE client_job_key IN (
            'checkout:recovery:online_unconfirmed:645307c4-24e3-4b7d-9789-ec04441c1a79',
            'checkout:recovery:online_unconfirmed:43188d7e-9fad-42d5-9a49-a2cf7b0a6696'
        )
    ) THEN
        IF (
            SELECT COUNT(*)
            FROM operational_recovery_job
            WHERE (
                (
                    client_job_key =
                        'checkout:recovery:online_unconfirmed:645307c4-24e3-4b7d-9789-ec04441c1a79'
                    AND transaction_id = '8dac3b9e-45b4-41b6-8d69-c2b49c88c53c'::uuid
                ) OR (
                    client_job_key =
                        'checkout:recovery:online_unconfirmed:43188d7e-9fad-42d5-9a49-a2cf7b0a6696'
                    AND transaction_id = '80864591-1a96-4319-9225-ed4621d448f9'::uuid
                )
            )
            AND status = 'resolved'
            AND resolved_by_staff_id = 'bf085089-e50b-4247-ae0f-155d37803d41'::uuid
            AND resolution_note =
                'Verified Helcim order payment was already recorded and allocated; stale recovery completed.'
        ) <> 2 THEN
            RAISE EXCEPTION
                'Expected both verified order-payment recovery jobs to be resolved';
        END IF;

        IF (
            SELECT COUNT(*)
            FROM staff_access_log
            WHERE event_kind = 'register_checkout_recovery_order_payment_resolved'
              AND idempotency_key IN (
                  'register-checkout-recovery-order-payment:checkout:recovery:online_unconfirmed:645307c4-24e3-4b7d-9789-ec04441c1a79:8dac3b9e-45b4-41b6-8d69-c2b49c88c53c',
                  'register-checkout-recovery-order-payment:checkout:recovery:online_unconfirmed:43188d7e-9fad-42d5-9a49-a2cf7b0a6696:80864591-1a96-4319-9225-ed4621d448f9'
              )
        ) <> 2 THEN
            RAISE EXCEPTION
                'Expected both verified order-payment recovery audits to exist';
        END IF;
    END IF;
END
$$;
