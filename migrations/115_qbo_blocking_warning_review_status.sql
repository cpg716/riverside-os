-- Keep non-postable or mapping-blocked QBO proposals out of the normal approval
-- queue. They remain visible for accounting review, but cannot be treated as
-- ready-to-approve pending journals.

WITH review_rows AS (
    SELECT
        q.id,
        COALESCE(
            (
                SELECT warning
                FROM jsonb_array_elements_text(COALESCE(q.payload->'warnings', '[]'::jsonb)) AS warning
                WHERE lower(warning) LIKE '% omitted%'
                   OR lower(warning) LIKE '% skipped in journal%'
                   OR lower(warning) LIKE '%mapping is missing%'
                   OR lower(warning) LIKE '%mapping missing%'
                   OR lower(warning) LIKE '%missing cogs/inventory mapping%'
                   OR lower(warning) LIKE '%missing/unknown card classification%'
                   OR lower(warning) LIKE '%has no ledger_mapping%'
                   OR (lower(warning) LIKE '%no `%mapping%')
                   OR lower(warning) LIKE 'no qbo tender mapping%'
                   OR lower(warning) LIKE 'no revenue mapping%'
                LIMIT 1
            ),
            'QBO staging proposal has no postable journal lines.'
        ) AS review_reason
    FROM public.qbo_sync_logs q
    WHERE q.status = 'pending'
      AND (
        NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(q.payload->'lines', '[]'::jsonb)) AS line
            WHERE NULLIF(TRIM(COALESCE(line->>'qbo_account_id', '')), '') IS NOT NULL
              AND (
                COALESCE(NULLIF(line->>'debit', '')::numeric, 0) <> 0
                OR COALESCE(NULLIF(line->>'credit', '')::numeric, 0) <> 0
              )
        )
        OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(COALESCE(q.payload->'warnings', '[]'::jsonb)) AS warning
            WHERE lower(warning) LIKE '% omitted%'
               OR lower(warning) LIKE '% skipped in journal%'
               OR lower(warning) LIKE '%mapping is missing%'
               OR lower(warning) LIKE '%mapping missing%'
               OR lower(warning) LIKE '%missing cogs/inventory mapping%'
               OR lower(warning) LIKE '%missing/unknown card classification%'
               OR lower(warning) LIKE '%has no ledger_mapping%'
               OR (lower(warning) LIKE '%no `%mapping%')
               OR lower(warning) LIKE 'no qbo tender mapping%'
               OR lower(warning) LIKE 'no revenue mapping%'
        )
      )
),
prepared AS (
    SELECT
        q.id,
        r.review_reason,
        jsonb_set(
            jsonb_set(
                jsonb_set(
                    q.payload,
                    '{qbo_stage}',
                    COALESCE(q.payload->'qbo_stage', '{}'::jsonb),
                    true
                ),
                '{qbo_stage,review_status}',
                to_jsonb('needs_review'::text),
                true
            ),
            '{qbo_stage,review_blockers}',
            to_jsonb(ARRAY[r.review_reason]::text[]),
            true
        ) AS next_payload
    FROM public.qbo_sync_logs q
    JOIN review_rows r ON r.id = q.id
)
UPDATE public.qbo_sync_logs q
SET
    status = 'needs_review',
    payload = p.next_payload,
    error_message = COALESCE(NULLIF(TRIM(q.error_message), ''), p.review_reason),
    updated_at = CURRENT_TIMESTAMP
FROM prepared p
WHERE q.id = p.id;
