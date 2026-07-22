-- Register checkout replay fingerprints, durable exchange recovery, and
-- workstation acknowledgements for safe till-group close.

ALTER TABLE public.transactions
    ADD COLUMN IF NOT EXISTS checkout_request_fingerprint text,
    ADD COLUMN IF NOT EXISTS checkout_payment_fingerprint text,
    ADD COLUMN IF NOT EXISTS checkout_processing_intent_fingerprint text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'transactions_checkout_request_fingerprint_chk'
          AND conrelid = 'public.transactions'::regclass
    ) THEN
        ALTER TABLE public.transactions
            ADD CONSTRAINT transactions_checkout_request_fingerprint_chk
            CHECK (
                checkout_request_fingerprint IS NULL
                OR checkout_request_fingerprint ~ '^[0-9a-f]{64}$'
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'transactions_checkout_payment_fingerprint_chk'
          AND conrelid = 'public.transactions'::regclass
    ) THEN
        ALTER TABLE public.transactions
            ADD CONSTRAINT transactions_checkout_payment_fingerprint_chk
            CHECK (
                checkout_payment_fingerprint IS NULL
                OR checkout_payment_fingerprint ~ '^[0-9a-f]{64}$'
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'transactions_checkout_processing_intent_fingerprint_chk'
          AND conrelid = 'public.transactions'::regclass
    ) THEN
        ALTER TABLE public.transactions
            ADD CONSTRAINT transactions_checkout_processing_intent_fingerprint_chk
            CHECK (
                checkout_processing_intent_fingerprint IS NULL
                OR checkout_processing_intent_fingerprint ~ '^[0-9a-f]{64}$'
            );
    END IF;
END
$$;

COMMENT ON COLUMN public.transactions.checkout_request_fingerprint IS
    'SHA-256 of the complete client checkout request used to reject checkout_client_id reuse with different sale details.';
COMMENT ON COLUMN public.transactions.checkout_payment_fingerprint IS
    'SHA-256 of the register, checkout identity, amount, and tender payload used to validate payment-safe idempotent replay.';
COMMENT ON COLUMN public.transactions.checkout_processing_intent_fingerprint IS
    'SHA-256 of immutable sale intent fields used to bind processing-to-complete checkout transitions without including tender completion details.';

ALTER TABLE public.register_sessions
    ADD COLUMN IF NOT EXISTS reconcile_started_at timestamptz;

CREATE TABLE IF NOT EXISTS public.register_station_close_acknowledgement (
    register_session_id uuid NOT NULL REFERENCES public.register_sessions(id) ON DELETE CASCADE,
    station_key text NOT NULL,
    pending_checkout_count integer NOT NULL DEFAULT 0,
    blocked_checkout_count integer NOT NULL DEFAULT 0,
    acknowledged_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (register_session_id, station_key),
    CONSTRAINT register_station_close_ack_station_key_chk
        CHECK (length(btrim(station_key)) BETWEEN 8 AND 128),
    CONSTRAINT register_station_close_ack_counts_chk
        CHECK (pending_checkout_count >= 0 AND blocked_checkout_count >= 0)
);

CREATE INDEX IF NOT EXISTS register_station_close_ack_session_idx
    ON public.register_station_close_acknowledgement
        (register_session_id, acknowledged_at DESC);

COMMENT ON TABLE public.register_station_close_acknowledgement IS
    'Fresh, per-workstation confirmation that the local checkout recovery queue is empty after a till group enters reconciliation.';

ALTER TABLE public.operational_recovery_job
    DROP CONSTRAINT IF EXISTS operational_recovery_job_kind_chk;
ALTER TABLE public.operational_recovery_job
    ADD CONSTRAINT operational_recovery_job_kind_chk
    CHECK (
        kind IN (
            'checkout_offline',
            'checkout_unconfirmed',
            'pickup_after_payment',
            'receipt_print',
            'exchange_settlement'
        )
    );

CREATE TABLE IF NOT EXISTS public.register_post_close_checkout_recovery (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    recovery_client_job_key text NOT NULL,
    register_session_id uuid NOT NULL REFERENCES public.register_sessions(id),
    transaction_id uuid NOT NULL REFERENCES public.transactions(id),
    recovered_by_staff_id uuid NOT NULL REFERENCES public.staff(id),
    manager_reason text NOT NULL,
    recovered_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT register_post_close_checkout_recovery_reason_chk
        CHECK (length(btrim(manager_reason)) >= 12)
);

CREATE UNIQUE INDEX IF NOT EXISTS register_post_close_checkout_recovery_job_uidx
    ON public.register_post_close_checkout_recovery (recovery_client_job_key);

CREATE INDEX IF NOT EXISTS register_post_close_checkout_recovery_session_idx
    ON public.register_post_close_checkout_recovery
        (register_session_id, recovered_at DESC);

COMMENT ON TABLE public.register_post_close_checkout_recovery IS
    'Audited supplement for a checkout recovered against its original session after a manager forced that till group closed.';

-- Remove legacy low-entropy Access PIN material that older Register clients could
-- place inside tender/recovery JSON. Preserve all non-secret audit fields.
CREATE OR REPLACE FUNCTION public.ros_143_scrub_sensitive_pin_keys(input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    output jsonb;
    item record;
    normalized_key text;
    encoded_text text;
    encoded_value jsonb;
    scrubbed_encoded_value jsonb;
BEGIN
    IF input IS NULL THEN
        RETURN NULL;
    END IF;
    CASE jsonb_typeof(input)
        WHEN 'object' THEN
            output := '{}'::jsonb;
            FOR item IN SELECT key, value FROM jsonb_each(input)
            LOOP
                normalized_key := regexp_replace(lower(item.key), '[^a-z0-9]', '', 'g');
                IF normalized_key = 'pin'
                   OR normalized_key LIKE '%accesspin'
                   OR normalized_key LIKE '%managerpin'
                   OR normalized_key LIKE '%staffpin' THEN
                    CONTINUE;
                END IF;
                output := output || jsonb_build_object(
                    item.key,
                    public.ros_143_scrub_sensitive_pin_keys(item.value)
                );
            END LOOP;
            RETURN output;
        WHEN 'array' THEN
            SELECT COALESCE(
                jsonb_agg(public.ros_143_scrub_sensitive_pin_keys(value) ORDER BY ordinality),
                '[]'::jsonb
            )
            INTO output
            FROM jsonb_array_elements(input) WITH ORDINALITY;
            RETURN output;
        WHEN 'string' THEN
            encoded_text := input #>> '{}';
            IF (left(ltrim(encoded_text), 1) = '{' AND right(rtrim(encoded_text), 1) = '}')
               OR (left(ltrim(encoded_text), 1) = '[' AND right(rtrim(encoded_text), 1) = ']') THEN
                BEGIN
                    encoded_value := encoded_text::jsonb;
                    scrubbed_encoded_value := public.ros_143_scrub_sensitive_pin_keys(encoded_value);
                    IF scrubbed_encoded_value IS DISTINCT FROM encoded_value THEN
                        RETURN to_jsonb(scrubbed_encoded_value::text);
                    END IF;
                EXCEPTION WHEN invalid_text_representation THEN
                    RETURN input;
                END;
            END IF;
            RETURN input;
        ELSE
            RETURN input;
    END CASE;
END
$$;

DROP TABLE IF EXISTS pg_temp.ros_143_pin_exposed_transactions;
CREATE TEMP TABLE ros_143_pin_exposed_transactions AS
SELECT DISTINCT pa.target_transaction_id AS transaction_id
FROM public.payment_transactions pt
JOIN public.payment_allocations pa ON pa.transaction_id = pt.id
WHERE public.ros_143_scrub_sensitive_pin_keys(pt.metadata) IS DISTINCT FROM pt.metadata
   OR public.ros_143_scrub_sensitive_pin_keys(pa.metadata) IS DISTINCT FROM pa.metadata
UNION
SELECT DISTINCT COALESCE(job.transaction_id, transaction_by_checkout.id)
FROM public.operational_recovery_job job
LEFT JOIN public.transactions transaction_by_checkout
  ON transaction_by_checkout.checkout_client_id = job.checkout_client_id
WHERE public.ros_143_scrub_sensitive_pin_keys(job.payload) IS DISTINCT FROM job.payload
  AND COALESCE(job.transaction_id, transaction_by_checkout.id) IS NOT NULL;

-- A fingerprint created from a four-digit PIN remains guessable even after the raw
-- JSON is scrubbed. Mark only affected historical checkouts as legacy/unfingerprinted;
-- recovery then uses exact committed-record verification without replay.
UPDATE public.transactions transaction
SET checkout_request_fingerprint = NULL,
    checkout_payment_fingerprint = NULL,
    checkout_processing_intent_fingerprint = NULL
WHERE transaction.id IN (
    SELECT exposed.transaction_id FROM ros_143_pin_exposed_transactions exposed
);

UPDATE public.payment_transactions
SET metadata = public.ros_143_scrub_sensitive_pin_keys(metadata)
WHERE public.ros_143_scrub_sensitive_pin_keys(metadata) IS DISTINCT FROM metadata;

UPDATE public.payment_allocations
SET metadata = public.ros_143_scrub_sensitive_pin_keys(metadata)
WHERE public.ros_143_scrub_sensitive_pin_keys(metadata) IS DISTINCT FROM metadata;

UPDATE public.operational_recovery_job
SET payload = public.ros_143_scrub_sensitive_pin_keys(payload)
WHERE public.ros_143_scrub_sensitive_pin_keys(payload) IS DISTINCT FROM payload;

UPDATE public.operational_outbox
SET payload = public.ros_143_scrub_sensitive_pin_keys(payload)
WHERE public.ros_143_scrub_sensitive_pin_keys(payload) IS DISTINCT FROM payload;

UPDATE public.staff_access_log
SET metadata = public.ros_143_scrub_sensitive_pin_keys(metadata)
WHERE public.ros_143_scrub_sensitive_pin_keys(metadata) IS DISTINCT FROM metadata;

DROP TABLE ros_143_pin_exposed_transactions;
DROP FUNCTION public.ros_143_scrub_sensitive_pin_keys(jsonb);
