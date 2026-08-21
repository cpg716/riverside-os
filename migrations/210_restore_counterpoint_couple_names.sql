-- Restore the complete Counterpoint couple names that the 2026-08-13 Podium
-- reconciliation replaced with shortened display names such as "SHEILA &".
--
-- The repair is deliberately source-locked. It requires the current Riverside
-- value, the latest completed Counterpoint raw row, and the last successful
-- Podium payload to agree on the exact truncation. Fresh databases and an
-- already-repaired production database safely no-op.

DO $migration$
DECLARE
    candidate_count BIGINT;
    audit_count BIGINT;
    updated_count BIGINT;
    queued_count BIGINT;
BEGIN
    CREATE TEMP TABLE migration_210_customer_name_repair
    ON COMMIT DROP
    AS
    WITH latest_counterpoint_row AS (
        SELECT DISTINCT ON (raw.source_key)
            raw.source_key,
            raw.source_row_hash,
            raw.import_run_id,
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
    repair_evidence AS (
        SELECT
            customer.id AS customer_id,
            customer.customer_code,
            customer.first_name AS old_first_name,
            customer.last_name AS old_last_name,
            LEFT(BTRIM(source.payload->>'first_name'), 100) AS new_first_name,
            LEFT(BTRIM(source.payload->>'last_name'), 100) AS new_last_name,
            sync.provider_contact_uid,
            COALESCE(
                NULLIF(BTRIM(sync.last_provider_payload->>'name'), ''),
                NULLIF(BTRIM(sync.last_provider_payload->>'displayName'), '')
            ) AS provider_display_name,
            source.import_run_id,
            source.source_row_hash
        FROM public.customers customer
        INNER JOIN latest_counterpoint_row source
            ON source.source_key = customer.customer_code
        INNER JOIN public.podium_contact_sync_state sync
            ON sync.customer_id = customer.id
           AND sync.status = 'succeeded'
        WHERE customer.is_active = TRUE
          AND customer.customer_created_source = 'counterpoint'
          AND BTRIM(customer.last_name) = '&'
          AND NULLIF(BTRIM(source.payload->>'first_name'), '') IS NOT NULL
          AND NULLIF(BTRIM(source.payload->>'last_name'), '') IS NOT NULL
          AND LENGTH(
                REGEXP_REPLACE(source.payload->>'last_name', '[^[:alpha:]]', '', 'g')
              ) >= 2
          AND UPPER(LEFT(
                BTRIM(source.payload->>'first_name'),
                LENGTH(BTRIM(customer.first_name)) + 3
              )) = UPPER(BTRIM(customer.first_name) || ' & ')
          AND LENGTH(BTRIM(source.payload->>'first_name'))
                > LENGTH(BTRIM(customer.first_name)) + 3
          AND UPPER(BTRIM(COALESCE(source.payload->>'full_name', '')))
                = UPPER(BTRIM(CONCAT_WS(
                    ' ',
                    NULLIF(BTRIM(source.payload->>'first_name'), ''),
                    NULLIF(BTRIM(source.payload->>'last_name'), '')
                )))
          AND NULLIF(BTRIM(sync.last_provider_payload->>'firstName'), '') IS NULL
          AND NULLIF(BTRIM(sync.last_provider_payload->>'lastName'), '') IS NULL
          AND UPPER(COALESCE(
                NULLIF(BTRIM(sync.last_provider_payload->>'name'), ''),
                NULLIF(BTRIM(sync.last_provider_payload->>'displayName'), '')
              )) = UPPER(BTRIM(customer.first_name) || ' &')
          AND (
              customer.first_name IS DISTINCT FROM LEFT(BTRIM(source.payload->>'first_name'), 100)
              OR customer.last_name IS DISTINCT FROM LEFT(BTRIM(source.payload->>'last_name'), 100)
          )
    )
    SELECT *
    FROM repair_evidence;

    SELECT COUNT(*) INTO candidate_count
    FROM migration_210_customer_name_repair;

    IF candidate_count = 0 THEN
        RETURN;
    END IF;

    IF candidate_count <> 72 THEN
        RAISE EXCEPTION
            'Migration 210 refused customer-name repair: expected exactly 72 proven rows, found %',
            candidate_count;
    END IF;

    INSERT INTO public.podium_contact_sync_event (
        customer_id,
        provider_contact_uid,
        direction,
        action,
        status,
        reason,
        payload
    )
    SELECT
        repair.customer_id,
        repair.provider_contact_uid,
        'podium_to_ros',
        'restore_counterpoint_couple_name',
        'succeeded',
        'Restored the complete Counterpoint couple name after Podium display-name reconciliation retained only the first name and ampersand.',
        jsonb_build_object(
            'old_first_name', repair.old_first_name,
            'old_last_name', repair.old_last_name,
            'new_first_name', repair.new_first_name,
            'new_last_name', repair.new_last_name,
            'provider_display_name', repair.provider_display_name,
            'counterpoint_customer_code', repair.customer_code,
            'counterpoint_import_run_id', repair.import_run_id,
            'counterpoint_source_row_hash', repair.source_row_hash,
            'repair_migration', '210_restore_counterpoint_couple_names.sql'
        )
    FROM migration_210_customer_name_repair repair;

    GET DIAGNOSTICS audit_count = ROW_COUNT;
    IF audit_count <> candidate_count THEN
        RAISE EXCEPTION
            'Migration 210 wrote % of % required customer-name audit events',
            audit_count,
            candidate_count;
    END IF;

    UPDATE public.customers customer
    SET first_name = repair.new_first_name,
        last_name = repair.new_last_name
    FROM migration_210_customer_name_repair repair
    WHERE customer.id = repair.customer_id
      AND (
          customer.first_name IS DISTINCT FROM repair.new_first_name
          OR customer.last_name IS DISTINCT FROM repair.new_last_name
      );

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    IF updated_count <> candidate_count THEN
        RAISE EXCEPTION
            'Migration 210 restored % of % proven customer names',
            updated_count,
            candidate_count;
    END IF;

    UPDATE public.podium_contact_sync_state sync
    SET status = 'pending',
        pending_reason = 'counterpoint_couple_name_repair',
        attempts = 0,
        next_attempt_at = NOW(),
        claimed_at = NULL,
        last_error = NULL,
        sync_suppressed = FALSE,
        updated_at = NOW()
    FROM migration_210_customer_name_repair repair
    WHERE sync.customer_id = repair.customer_id;

    GET DIAGNOSTICS queued_count = ROW_COUNT;
    IF queued_count <> candidate_count THEN
        RAISE EXCEPTION
            'Migration 210 queued % of % corrected customers for Podium synchronization',
            queued_count,
            candidate_count;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM migration_210_customer_name_repair repair
        INNER JOIN public.customers customer ON customer.id = repair.customer_id
        WHERE customer.first_name IS DISTINCT FROM repair.new_first_name
           OR customer.last_name IS DISTINCT FROM repair.new_last_name
    ) THEN
        RAISE EXCEPTION
            'Migration 210 post-state verification found an unrestored customer name';
    END IF;
END
$migration$;
