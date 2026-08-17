-- Preserve authoritative Riverside customer names when Podium supplies only a
-- display-name string, and repair the RMS-linked surnames proven to have been
-- truncated by the original display-name reconciliation behavior.

WITH latest_batch AS (
    SELECT id
    FROM public.rms_account_list_import_batches
    WHERE status = 'imported'
    ORDER BY uploaded_at DESC, created_at DESC
    LIMIT 1
),
repair_evidence AS (
    SELECT
        c.id AS customer_id,
        COALESCE(c.first_name, '') AS old_first_name,
        COALESCE(c.last_name, '') AS old_last_name,
        c.customer_created_source,
        c.customer_code,
        c.created_at AS customer_created_at,
        a.created_at AS account_link_created_at,
        s.account_number,
        s.normalized_phone AS rms_phone,
        LEFT(
            NULLIF(BTRIM(s.raw_payload->'rows'->0->'cells'->5->>'value'), ''),
            100
        ) AS rms_first_name,
        LEFT(
            NULLIF(BTRIM(s.raw_payload->'rows'->0->'cells'->3->>'value'), ''),
            100
        ) AS rms_last_name,
        sync.provider_contact_uid,
        sync.last_provider_payload
    FROM public.rms_account_list_snapshots s
    JOIN latest_batch batch ON batch.id = s.batch_id
    JOIN public.customers c ON c.id = s.matched_customer_id
    JOIN public.customer_corecredit_accounts a
      ON a.customer_id = c.id
     AND a.corecredit_account_id = s.account_number
     AND a.verification_source = 'rms_account_list_manual_match'
    JOIN public.podium_contact_sync_state sync
      ON sync.customer_id = c.id
     AND sync.status = 'succeeded'
    WHERE LENGTH(BTRIM(COALESCE(c.last_name, ''))) <= 1
      AND LENGTH(BTRIM(COALESCE(s.raw_payload->'rows'->0->'cells'->3->>'value', ''))) > 1
      AND NULLIF(BTRIM(sync.last_provider_payload->>'lastName'), '') IS NULL
      AND NULLIF(BTRIM(sync.last_provider_payload->>'name'), '') IS NOT NULL
      AND UPPER(BTRIM(COALESCE(c.last_name, ''))) = UPPER(BTRIM(
          REGEXP_REPLACE(
              sync.last_provider_payload->>'name',
              '^[^[:space:]]+[[:space:]]*',
              ''
          )
      ))
      AND (
          (
              c.customer_created_source = 'counterpoint'
              AND REGEXP_REPLACE(c.customer_code, '^C-', '', 'i') = s.account_number
          )
          OR (
              c.customer_created_source = 'store'
              AND c.created_at BETWEEN a.created_at - INTERVAL '5 minutes' AND a.created_at
              AND REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g')
                  IN (s.normalized_phone, '1' || s.normalized_phone)
          )
      )
),
unambiguous_repairs AS (
    SELECT
        customer_id,
        MIN(old_first_name) AS old_first_name,
        MIN(old_last_name) AS old_last_name,
        COALESCE(MIN(rms_first_name), MIN(old_first_name)) AS new_first_name,
        MIN(rms_last_name) AS new_last_name,
        MIN(provider_contact_uid) AS provider_contact_uid,
        MIN(account_number) AS account_number,
        MIN(customer_created_source) AS customer_created_source
    FROM repair_evidence
    GROUP BY customer_id
    HAVING COUNT(DISTINCT UPPER(rms_last_name)) = 1
       AND COUNT(DISTINCT UPPER(rms_first_name)) FILTER (WHERE rms_first_name IS NOT NULL) <= 1
),
repair_audit AS (
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
        'repair_truncated_rms_customer_name',
        'succeeded',
        'Restored a proven RMS account-holder name after Podium display-name reconciliation replaced the surname with one character.',
        jsonb_build_object(
            'old_first_name', repair.old_first_name,
            'old_last_name', repair.old_last_name,
            'new_first_name', repair.new_first_name,
            'new_last_name', repair.new_last_name,
            'rms_account_number', repair.account_number,
            'customer_created_source', repair.customer_created_source,
            'repair_migration', '205_preserve_customer_names_from_podium_display'
        )
    FROM unambiguous_repairs repair
    RETURNING customer_id
),
repaired_customers AS (
    UPDATE public.customers customer
    SET first_name = repair.new_first_name,
        last_name = repair.new_last_name
    FROM unambiguous_repairs repair
    JOIN repair_audit audit ON audit.customer_id = repair.customer_id
    WHERE customer.id = repair.customer_id
      AND (
          customer.first_name IS DISTINCT FROM repair.new_first_name
          OR customer.last_name IS DISTINCT FROM repair.new_last_name
      )
    RETURNING customer.id
)
UPDATE public.podium_contact_sync_state sync
SET status = 'pending',
    pending_reason = 'rms_name_repair',
    attempts = 0,
    next_attempt_at = NOW(),
    claimed_at = NULL,
    last_error = NULL,
    sync_suppressed = FALSE,
    updated_at = NOW()
FROM repaired_customers repaired
WHERE sync.customer_id = repaired.id;
