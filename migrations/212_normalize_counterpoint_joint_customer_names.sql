-- Normalize source-proven Counterpoint household names such as
-- first_name = 'Sam', last_name = '& Renee Smith' into the ROS customer shape
-- first_name = 'Sam & Renee', last_name = 'Smith'. These remain one household
-- customer record; this migration does not link, merge, add, or delete profiles.

CREATE TABLE IF NOT EXISTS public.counterpoint_customer_name_repair_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES public.customers(id),
    customer_code TEXT NOT NULL,
    old_first_name TEXT NOT NULL,
    old_last_name TEXT NOT NULL,
    new_first_name TEXT NOT NULL,
    new_last_name TEXT NOT NULL,
    source_import_run_id UUID NOT NULL,
    source_row_hash TEXT NOT NULL,
    repair_kind TEXT NOT NULL,
    migration_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_id, migration_name)
);

COMMENT ON TABLE public.counterpoint_customer_name_repair_audit IS
    'Append-only before/after evidence for source-proven Counterpoint customer-name normalization.';

DO $migration$
DECLARE
    candidate_count BIGINT;
    audit_count BIGINT;
    updated_count BIGINT;
BEGIN
    CREATE TEMP TABLE migration_212_customer_name_repair
    ON COMMIT DROP
    AS
    WITH latest_counterpoint_row AS (
        SELECT DISTINCT ON (raw.source_key)
            raw.source_key,
            raw.source_row_hash,
            raw.import_run_id,
            raw.landed_table,
            raw.landed_id,
            raw.payload
        FROM public.counterpoint_import_raw_records raw
        INNER JOIN public.counterpoint_import_runs import_run
            ON import_run.id = raw.import_run_id
           AND import_run.status = 'completed'
        WHERE raw.entity_key = 'customers'
          AND raw.landed = TRUE
        ORDER BY
            raw.source_key,
            raw.extracted_at DESC,
            raw.created_at DESC,
            raw.id DESC
    ),
    source_evidence AS (
        SELECT
            customer.id AS customer_id,
            customer.customer_code,
            BTRIM(customer.first_name) AS old_first_name,
            BTRIM(customer.last_name) AS old_last_name,
            REGEXP_REPLACE(
                BTRIM(REGEXP_REPLACE(customer.last_name, '^&[[:space:]]+', '')),
                '[[:space:]]+',
                ' ',
                'g'
            ) AS partner_and_last,
            REGEXP_REPLACE(
                BTRIM(CONCAT_WS(' ', customer.first_name, customer.last_name)),
                '[[:space:]]+',
                ' ',
                'g'
            ) AS current_display_name,
            NULLIF(REGEXP_REPLACE(
                BTRIM(COALESCE(source.payload->>'full_name', '')),
                '[[:space:]]+',
                ' ',
                'g'
            ), '') AS source_full_name,
            NULLIF(REGEXP_REPLACE(
                BTRIM(CONCAT_WS(
                    ' ',
                    NULLIF(BTRIM(source.payload->>'first_name'), ''),
                    NULLIF(BTRIM(source.payload->>'last_name'), '')
                )),
                '[[:space:]]+',
                ' ',
                'g'
            ), '') AS source_explicit_name,
            source.import_run_id,
            source.source_row_hash
        FROM public.customers customer
        INNER JOIN latest_counterpoint_row source
            ON source.source_key = customer.customer_code
           AND source.landed_table = 'customers'
           AND source.landed_id = customer.id
        WHERE customer.is_active = TRUE
          AND customer.customer_created_source = 'counterpoint'
          AND NULLIF(BTRIM(customer.first_name), '') IS NOT NULL
          AND BTRIM(customer.first_name) NOT LIKE '%&%'
          AND BTRIM(customer.last_name)
                ~ '^&[[:space:]]+[^[:space:]]+[[:space:]]+.+$'
    ),
    repair_evidence AS (
        SELECT
            customer_id,
            customer_code,
            old_first_name,
            old_last_name,
            LEFT(
                old_first_name || ' & ' || SPLIT_PART(partner_and_last, ' ', 1),
                100
            ) AS new_first_name,
            LEFT(
                SUBSTRING(
                    partner_and_last
                    FROM LENGTH(SPLIT_PART(partner_and_last, ' ', 1)) + 2
                ),
                100
            ) AS new_last_name,
            import_run_id,
            source_row_hash
        FROM source_evidence
        WHERE (
              UPPER(current_display_name) = UPPER(source_full_name)
              OR UPPER(current_display_name) = UPPER(source_explicit_name)
          )
          AND LENGTH(
                REGEXP_REPLACE(
                    SUBSTRING(
                        partner_and_last
                        FROM LENGTH(SPLIT_PART(partner_and_last, ' ', 1)) + 2
                    ),
                    '[^[:alpha:]]',
                    '',
                    'g'
                )
              ) >= 2
    )
    SELECT *
    FROM repair_evidence;

    SELECT COUNT(*) INTO candidate_count
    FROM migration_212_customer_name_repair;

    IF candidate_count = 0 THEN
        RETURN;
    END IF;

    INSERT INTO public.counterpoint_customer_name_repair_audit (
        customer_id,
        customer_code,
        old_first_name,
        old_last_name,
        new_first_name,
        new_last_name,
        source_import_run_id,
        source_row_hash,
        repair_kind,
        migration_name
    )
    SELECT
        repair.customer_id,
        repair.customer_code,
        repair.old_first_name,
        repair.old_last_name,
        repair.new_first_name,
        repair.new_last_name,
        repair.import_run_id,
        repair.source_row_hash,
        'normalize_joint_household_name',
        '212_normalize_counterpoint_joint_customer_names.sql'
    FROM migration_212_customer_name_repair repair;

    GET DIAGNOSTICS audit_count = ROW_COUNT;
    IF audit_count <> candidate_count THEN
        RAISE EXCEPTION
            'Migration 212 wrote % of % required customer-name audit rows',
            audit_count,
            candidate_count;
    END IF;

    UPDATE public.customers customer
    SET first_name = repair.new_first_name,
        last_name = repair.new_last_name
    FROM migration_212_customer_name_repair repair
    WHERE customer.id = repair.customer_id
      AND BTRIM(customer.first_name) = repair.old_first_name
      AND BTRIM(customer.last_name) = repair.old_last_name;

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    IF updated_count <> candidate_count THEN
        RAISE EXCEPTION
            'Migration 212 normalized % of % source-proven customer names',
            updated_count,
            candidate_count;
    END IF;

    UPDATE public.podium_contact_sync_state sync
    SET status = 'pending',
        pending_reason = 'counterpoint_joint_name_normalization',
        attempts = 0,
        next_attempt_at = NOW(),
        claimed_at = NULL,
        last_error = NULL,
        sync_suppressed = FALSE,
        updated_at = NOW()
    FROM migration_212_customer_name_repair repair
    WHERE sync.customer_id = repair.customer_id
      AND sync.status = 'succeeded';

    UPDATE public.meilisearch_sync_status
    SET source_revision = source_revision + 1,
        verified_revision = NULL,
        last_verified_at = NULL,
        verification_state = 'pending',
        verification_detail = 'Counterpoint joint customer names changed; customer index revalidation is required.',
        verified_source_count = NULL,
        verified_document_count = NULL,
        updated_at = NOW()
    WHERE index_name = 'customers';

    IF EXISTS (
        SELECT 1
        FROM migration_212_customer_name_repair repair
        INNER JOIN public.customers customer ON customer.id = repair.customer_id
        WHERE BTRIM(customer.first_name) IS DISTINCT FROM repair.new_first_name
           OR BTRIM(customer.last_name) IS DISTINCT FROM repair.new_last_name
    ) THEN
        RAISE EXCEPTION
            'Migration 212 post-state verification found an unnormalized customer name';
    END IF;
END
$migration$;
