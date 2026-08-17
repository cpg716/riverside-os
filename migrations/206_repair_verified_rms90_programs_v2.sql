-- Supersedes immutable migration 202, whose incident-only branch contains a
-- malformed payment UUID. Current migration runners ledger that exact broken
-- file without executing it when this replacement is present.
--
-- Two verified production RMS Charge sales were explicitly identified as
-- 90 Day charges after every ROS ledger layer had persisted the Standard code.
-- Repair only those exact record/payment/Transaction identities and amounts.
-- No amount, allocation, effective date, customer, session, or status changes.

DO $$
DECLARE
    target_record_ids CONSTANT uuid[] := ARRAY[
        '4dcff1c9-1402-4f5f-8622-2f5fd915938f'::uuid,
        '8e47d056-0bfb-477a-b854-cbfb2d8be227'::uuid
    ];
    present_count integer;
    verified_count integer;
BEGIN
    SELECT COUNT(*)
    INTO present_count
    FROM public.pos_rms_charge_record record
    WHERE record.id = ANY(target_record_ids);

    -- Development, test, and new installations do not contain this incident.
    IF present_count = 0 THEN
        RETURN;
    END IF;

    IF present_count <> 2 THEN
        RAISE EXCEPTION
            'RMS90 repair stopped: only % of 2 expected RMS records exist',
            present_count;
    END IF;

    WITH expected (
        rms_record_id,
        transaction_id,
        transaction_display_id,
        payment_transaction_id,
        register_session_id,
        customer_id,
        amount
    ) AS (
        VALUES
            (
                '4dcff1c9-1402-4f5f-8622-2f5fd915938f'::uuid,
                '8250a5dc-66b3-44bd-a391-717a6f458b8b'::uuid,
                'TXN-624776',
                '6f767441-3e5c-4d07-be02-6c3c55b3cd26'::uuid,
                'e9d04bbb-954e-4ac8-abe7-bccc3d696ed2'::uuid,
                'bdf096f6-cd43-4c8e-9107-55aa304f0a8d'::uuid,
                92.18::numeric
            ),
            (
                '8e47d056-0bfb-477a-b854-cbfb2d8be227'::uuid,
                '3c1e8cc4-c5f6-44d2-8506-9bad12ced932'::uuid,
                'TXN-624734',
                'ff05f632-f43c-4856-813c-c0d41cd1eb4f'::uuid,
                '83b6a543-2817-41ac-a35d-ef23842951fd'::uuid,
                '56bb47fe-b6b1-4cbb-8730-c9504cc7a951'::uuid,
                82.12::numeric
            )
    )
    SELECT COUNT(*)
    INTO verified_count
    FROM expected
    INNER JOIN public.pos_rms_charge_record record
        ON record.id = expected.rms_record_id
       AND record.record_kind = 'charge'
       AND record.transaction_id = expected.transaction_id
       AND record.payment_transaction_id = expected.payment_transaction_id
       AND record.register_session_id = expected.register_session_id
       AND record.customer_id = expected.customer_id
       AND record.amount = expected.amount
       AND record.tender_family = 'rms_charge'
       AND (
            (
                record.payment_method = 'on_account_rms'
                AND LOWER(COALESCE(record.program_code, '')) = 'standard'
                AND LOWER(COALESCE(record.program_label, '')) IN ('standard', 'standard rms')
            )
            OR (
                record.payment_method = 'on_account_rms90'
                AND LOWER(COALESCE(record.program_code, '')) = 'rms90'
                AND LOWER(COALESCE(record.program_label, '')) IN ('rms 90', '90 day')
            )
       )
    INNER JOIN public.payment_transactions payment
        ON payment.id = expected.payment_transaction_id
       AND payment.session_id = expected.register_session_id
       AND payment.payer_id = expected.customer_id
       AND payment.amount = expected.amount
       AND payment.status = 'success'
       AND (
            (
                payment.payment_method = 'on_account_rms'
                AND LOWER(COALESCE(payment.metadata->>'program_code', '')) = 'standard'
                AND LOWER(COALESCE(payment.metadata->>'program_label', '')) IN ('standard', 'standard rms')
            )
            OR (
                payment.payment_method = 'on_account_rms90'
                AND LOWER(COALESCE(payment.metadata->>'program_code', '')) = 'rms90'
                AND LOWER(COALESCE(payment.metadata->>'program_label', '')) IN ('rms 90', '90 day')
            )
       )
    INNER JOIN public.transactions transaction_record
        ON transaction_record.id = expected.transaction_id
       AND transaction_record.display_id = expected.transaction_display_id
       AND transaction_record.customer_id = expected.customer_id
       AND LOWER(COALESCE(
            transaction_record.metadata->'rms_charge'->>'program_code',
            ''
       )) IN ('standard', 'rms90')
    WHERE (
            record.payment_method = 'on_account_rms'
        AND payment.payment_method = 'on_account_rms'
        AND LOWER(transaction_record.metadata->'rms_charge'->>'program_code') = 'standard'
    ) OR (
            record.payment_method = 'on_account_rms90'
        AND payment.payment_method = 'on_account_rms90'
        AND LOWER(transaction_record.metadata->'rms_charge'->>'program_code') = 'rms90'
    );

    IF verified_count <> 2 THEN
        RAISE EXCEPTION
            'RMS90 repair stopped: expected identities or financial invariants do not match';
    END IF;

    WITH expected (rms_record_id, payment_transaction_id, transaction_id) AS (
        VALUES
            (
                '4dcff1c9-1402-4f5f-8622-2f5fd915938f'::uuid,
                '6f767441-3e5c-4d07-be02-6c3c55b3cd26'::uuid,
                '8250a5dc-66b3-44bd-a391-717a6f458b8b'::uuid
            ),
            (
                '8e47d056-0bfb-477a-b854-cbfb2d8be227'::uuid,
                'ff05f632-f43c-4856-813c-c0d41cd1eb4f'::uuid,
                '3c1e8cc4-c5f6-44d2-8506-9bad12ced932'::uuid
            )
    )
    UPDATE public.payment_transactions payment
    SET payment_method = 'on_account_rms90',
        metadata = COALESCE(payment.metadata, '{}'::jsonb) || jsonb_build_object(
            'tender_family', 'rms_charge',
            'program_code', 'rms90',
            'program_label', 'RMS 90',
            'program_selection_repair', COALESCE(
                payment.metadata->'program_selection_repair',
                jsonb_build_object(
                    'migration', '206_repair_verified_rms90_programs_v2',
                    'previous_payment_method', payment.payment_method,
                    'previous_program_code', payment.metadata->>'program_code',
                    'reason', 'Verified staff correction: RMS Charge was 90 Day'
                )
            )
        )
    FROM expected
    WHERE payment.id = expected.payment_transaction_id;

    WITH expected (rms_record_id, payment_transaction_id, transaction_id) AS (
        VALUES
            (
                '4dcff1c9-1402-4f5f-8622-2f5fd915938f'::uuid,
                '6f767441-3e5c-4d07-be02-6c3c55b3cd26'::uuid,
                '8250a5dc-66b3-44bd-a391-717a6f458b8b'::uuid
            ),
            (
                '8e47d056-0bfb-477a-b854-cbfb2d8be227'::uuid,
                'ff05f632-f43c-4856-813c-c0d41cd1eb4f'::uuid,
                '3c1e8cc4-c5f6-44d2-8506-9bad12ced932'::uuid
            )
    )
    UPDATE public.pos_rms_charge_record record
    SET payment_method = 'on_account_rms90',
        tender_family = 'rms_charge',
        program_code = 'rms90',
        program_label = 'RMS 90',
        metadata_json = COALESCE(record.metadata_json, '{}'::jsonb) || jsonb_build_object(
            'tender_family', 'rms_charge',
            'program_code', 'rms90',
            'program_label', 'RMS 90',
            'program_selection_repair', COALESCE(
                record.metadata_json->'program_selection_repair',
                jsonb_build_object(
                    'migration', '206_repair_verified_rms90_programs_v2',
                    'previous_payment_method', record.payment_method,
                    'previous_program_code', record.program_code,
                    'previous_program_label', record.program_label,
                    'reason', 'Verified staff correction: RMS Charge was 90 Day'
                )
            )
        )
    FROM expected
    WHERE record.id = expected.rms_record_id;

    WITH expected (transaction_id) AS (
        VALUES
            ('8250a5dc-66b3-44bd-a391-717a6f458b8b'::uuid),
            ('3c1e8cc4-c5f6-44d2-8506-9bad12ced932'::uuid)
    )
    UPDATE public.transactions transaction_record
    SET metadata = jsonb_set(
        COALESCE(transaction_record.metadata, '{}'::jsonb),
        '{rms_charge}',
        COALESCE(transaction_record.metadata->'rms_charge', '{}'::jsonb) ||
            jsonb_build_object(
                'tender_family', 'rms_charge',
                'program_code', 'rms90',
                'program_label', 'RMS 90',
                'program_selection_repair', COALESCE(
                    transaction_record.metadata->'rms_charge'->'program_selection_repair',
                    jsonb_build_object(
                        'migration', '206_repair_verified_rms90_programs_v2',
                        'previous_program_code', transaction_record.metadata->'rms_charge'->>'program_code',
                        'previous_program_label', transaction_record.metadata->'rms_charge'->>'program_label',
                        'reason', 'Verified staff correction: RMS Charge was 90 Day'
                    )
                )
            ),
        true
    )
    FROM expected
    WHERE transaction_record.id = expected.transaction_id;

    -- Closed Z-Reports retain an immutable tender snapshot on every Register
    -- in the till group. These exact snapshots each contain only the affected
    -- charge in their RMS aggregate, so relabel the method without changing
    -- the stored amount or transaction count.
    WITH expected (session_id, business_date, amount) AS (
        VALUES
            ('83b6a543-2817-41ac-a35d-ef23842951fd'::uuid, '2026-07-24', '82.12'),
            ('88035a04-fbd4-48db-9b4c-df61fdd3809a'::uuid, '2026-07-24', '82.12'),
            ('b2fa5409-5f63-4d4f-ad42-e0d0c99d2e79'::uuid, '2026-07-24', '82.12'),
            ('44e7be8a-056b-48df-8461-f0298fb3fe98'::uuid, '2026-07-24', '82.12'),
            ('e9d04bbb-954e-4ac8-abe7-bccc3d696ed2'::uuid, '2026-07-25', '92.18'),
            ('17424955-d38a-42b5-a4b0-3e1f68b5747b'::uuid, '2026-07-25', '92.18'),
            ('ba5f554a-fb19-414d-8511-57e7475aade4'::uuid, '2026-07-25', '92.18'),
            ('9ca1c8c5-0532-4ebe-a337-a87da012948e'::uuid, '2026-07-25', '92.18')
    )
    SELECT COUNT(*)
    INTO verified_count
    FROM expected
    INNER JOIN public.register_sessions session
        ON session.id = expected.session_id
       AND session.z_report_json->>'business_date' = expected.business_date
    WHERE (
        SELECT COUNT(*)
        FROM jsonb_array_elements(
            COALESCE(session.z_report_json->'tenders', '[]'::jsonb)
        ) tender
        WHERE tender->>'payment_method' IN ('on_account_rms', 'on_account_rms90')
          AND tender->>'total_amount' = expected.amount
          AND tender->>'tx_count' = '1'
    ) = 1
      AND (
        SELECT COUNT(*)
        FROM jsonb_array_elements(
            COALESCE(session.z_report_json->'tenders', '[]'::jsonb)
        ) tender
        WHERE LOWER(COALESCE(tender->>'payment_method', '')) LIKE '%rms%'
    ) = 1
      AND (
        SELECT COUNT(*)
        FROM jsonb_array_elements(
            COALESCE(session.z_report_json->'tenders_by_lane', '[]'::jsonb)
        ) lane
        CROSS JOIN LATERAL jsonb_array_elements(
            COALESCE(lane->'tenders', '[]'::jsonb)
        ) tender
        WHERE lane->>'register_lane' = '1'
          AND tender->>'payment_method' IN ('on_account_rms', 'on_account_rms90')
          AND tender->>'total_amount' = expected.amount
          AND tender->>'tx_count' = '1'
    ) = 1
      AND (
        SELECT COUNT(*)
        FROM jsonb_array_elements(
            COALESCE(session.z_report_json->'tenders_by_lane', '[]'::jsonb)
        ) lane
        CROSS JOIN LATERAL jsonb_array_elements(
            COALESCE(lane->'tenders', '[]'::jsonb)
        ) tender
        WHERE LOWER(COALESCE(tender->>'payment_method', '')) LIKE '%rms%'
    ) = 1;

    IF verified_count <> 8 THEN
        RAISE EXCEPTION
            'RMS90 repair stopped: expected closed Z-Report tender snapshots do not match';
    END IF;

    WITH expected (session_id, amount) AS (
        VALUES
            ('83b6a543-2817-41ac-a35d-ef23842951fd'::uuid, '82.12'),
            ('88035a04-fbd4-48db-9b4c-df61fdd3809a'::uuid, '82.12'),
            ('b2fa5409-5f63-4d4f-ad42-e0d0c99d2e79'::uuid, '82.12'),
            ('44e7be8a-056b-48df-8461-f0298fb3fe98'::uuid, '82.12'),
            ('e9d04bbb-954e-4ac8-abe7-bccc3d696ed2'::uuid, '92.18'),
            ('17424955-d38a-42b5-a4b0-3e1f68b5747b'::uuid, '92.18'),
            ('ba5f554a-fb19-414d-8511-57e7475aade4'::uuid, '92.18'),
            ('9ca1c8c5-0532-4ebe-a337-a87da012948e'::uuid, '92.18')
    ),
    rewritten AS (
        SELECT
            session.id,
            expected.amount,
            jsonb_set(
                jsonb_set(
                    session.z_report_json,
                    '{tenders}',
                    (
                        SELECT jsonb_agg(
                            CASE
                                WHEN tender->>'payment_method' = 'on_account_rms'
                                 AND tender->>'total_amount' = expected.amount
                                 AND tender->>'tx_count' = '1'
                                THEN tender || jsonb_build_object(
                                    'payment_method', 'on_account_rms90'
                                )
                                ELSE tender
                            END
                            ORDER BY tender_ordinal
                        )
                        FROM jsonb_array_elements(session.z_report_json->'tenders')
                            WITH ORDINALITY AS tender_rows(tender, tender_ordinal)
                    ),
                    false
                ),
                '{tenders_by_lane}',
                (
                    SELECT jsonb_agg(
                        lane || jsonb_build_object(
                            'tenders',
                            (
                                SELECT jsonb_agg(
                                    CASE
                                        WHEN tender->>'payment_method' = 'on_account_rms'
                                         AND tender->>'total_amount' = expected.amount
                                         AND tender->>'tx_count' = '1'
                                        THEN tender || jsonb_build_object(
                                            'payment_method', 'on_account_rms90'
                                        )
                                        ELSE tender
                                    END
                                    ORDER BY tender_ordinal
                                )
                                FROM jsonb_array_elements(lane->'tenders')
                                    WITH ORDINALITY AS tender_rows(tender, tender_ordinal)
                            )
                        )
                        ORDER BY lane_ordinal
                    )
                    FROM jsonb_array_elements(session.z_report_json->'tenders_by_lane')
                        WITH ORDINALITY AS lane_rows(lane, lane_ordinal)
                ),
                false
            ) AS corrected_snapshot
        FROM expected
        INNER JOIN public.register_sessions session
            ON session.id = expected.session_id
    )
    UPDATE public.register_sessions session
    SET z_report_json = rewritten.corrected_snapshot || jsonb_build_object(
        'rms_program_repair', COALESCE(
            session.z_report_json->'rms_program_repair',
            jsonb_build_object(
                'migration', '206_repair_verified_rms90_programs_v2',
                'previous_payment_method', 'on_account_rms',
                'corrected_payment_method', 'on_account_rms90',
                'amount', rewritten.amount,
                'transaction_count', 1,
                'reason', 'Verified staff correction: RMS Charge was 90 Day'
            )
        )
    )
    FROM rewritten
    WHERE session.id = rewritten.id;

    SELECT COUNT(*)
    INTO verified_count
    FROM public.pos_rms_charge_record record
    INNER JOIN public.payment_transactions payment
        ON payment.id = record.payment_transaction_id
    INNER JOIN public.transactions transaction_record
        ON transaction_record.id = record.transaction_id
    WHERE record.id = ANY(target_record_ids)
      AND record.payment_method = 'on_account_rms90'
      AND record.tender_family = 'rms_charge'
      AND record.program_code = 'rms90'
      AND record.program_label = 'RMS 90'
      AND payment.payment_method = 'on_account_rms90'
      AND payment.metadata->>'program_code' = 'rms90'
      AND payment.metadata->>'program_label' = 'RMS 90'
      AND transaction_record.metadata->'rms_charge'->>'program_code' = 'rms90'
      AND transaction_record.metadata->'rms_charge'->>'program_label' = 'RMS 90';

    IF verified_count <> 2 THEN
        RAISE EXCEPTION
            'RMS90 repair stopped: corrected program classification did not reconcile across all ledger layers';
    END IF;

    WITH expected (session_id, amount) AS (
        VALUES
            ('83b6a543-2817-41ac-a35d-ef23842951fd'::uuid, '82.12'),
            ('88035a04-fbd4-48db-9b4c-df61fdd3809a'::uuid, '82.12'),
            ('b2fa5409-5f63-4d4f-ad42-e0d0c99d2e79'::uuid, '82.12'),
            ('44e7be8a-056b-48df-8461-f0298fb3fe98'::uuid, '82.12'),
            ('e9d04bbb-954e-4ac8-abe7-bccc3d696ed2'::uuid, '92.18'),
            ('17424955-d38a-42b5-a4b0-3e1f68b5747b'::uuid, '92.18'),
            ('ba5f554a-fb19-414d-8511-57e7475aade4'::uuid, '92.18'),
            ('9ca1c8c5-0532-4ebe-a337-a87da012948e'::uuid, '92.18')
    )
    SELECT COUNT(*)
    INTO verified_count
    FROM expected
    INNER JOIN public.register_sessions session
        ON session.id = expected.session_id
    WHERE (
        SELECT COUNT(*)
        FROM jsonb_array_elements(session.z_report_json->'tenders') tender
        WHERE tender->>'payment_method' = 'on_account_rms90'
          AND tender->>'total_amount' = expected.amount
          AND tender->>'tx_count' = '1'
    ) = 1
      AND (
        SELECT COUNT(*)
        FROM jsonb_array_elements(session.z_report_json->'tenders_by_lane') lane
        CROSS JOIN LATERAL jsonb_array_elements(lane->'tenders') tender
        WHERE tender->>'payment_method' = 'on_account_rms90'
          AND tender->>'total_amount' = expected.amount
          AND tender->>'tx_count' = '1'
    ) = 1
      AND session.z_report_json->'rms_program_repair'->>'migration' =
          '206_repair_verified_rms90_programs_v2';

    IF verified_count <> 8 THEN
        RAISE EXCEPTION
            'RMS90 repair stopped: closed Z-Report tender snapshots did not reconcile';
    END IF;
END
$$;
