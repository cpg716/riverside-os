-- Supersede five exact Counterpoint open-document subset copies that duplicate
-- merchandise already booked in ROS transactions. The retained ROS transaction,
-- provider-backed payments, inventory, and fulfillment evidence are read-only.
-- Reviewed evidence:
-- docs/incidents/evidence/2026-08-01-counterpoint-subset-duplicate-reconciliation.json

BEGIN;
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SELECT pg_advisory_xact_lock(hashtext('counterpoint_subset_duplicate_reconciliation_2026_08_01'));

CREATE TEMP TABLE ros_176_targets (
    canonical_id uuid PRIMARY KEY,
    canonical_display_id text NOT NULL UNIQUE,
    canonical_status text NOT NULL,
    canonical_total numeric(14,2) NOT NULL,
    canonical_paid numeric(14,2) NOT NULL,
    canonical_balance numeric(14,2) NOT NULL,
    canonical_line_count integer NOT NULL,
    imported_id uuid NOT NULL UNIQUE,
    imported_display_id text NOT NULL UNIQUE,
    customer_id uuid NOT NULL,
    counterpoint_doc_ref text NOT NULL,
    imported_total numeric(14,2) NOT NULL,
    imported_paid numeric(14,2) NOT NULL,
    imported_balance numeric(14,2) NOT NULL,
    imported_line_count integer NOT NULL,
    allocation_id uuid NOT NULL UNIQUE,
    payment_id uuid NOT NULL UNIQUE,
    allocation_amount numeric(14,2) NOT NULL,
    reconciliation_id uuid NOT NULL DEFAULT gen_random_uuid()
) ON COMMIT DROP;

INSERT INTO ros_176_targets (
    canonical_id, canonical_display_id, canonical_status,
    canonical_total, canonical_paid, canonical_balance, canonical_line_count,
    imported_id, imported_display_id, customer_id, counterpoint_doc_ref,
    imported_total, imported_paid, imported_balance, imported_line_count,
    allocation_id, payment_id, allocation_amount
)
VALUES
    (
        'f7df7f83-12bb-4351-a213-c6c676439ba5', 'TXN-624103', 'open',
        380.72, 380.72, 0.00, 2,
        'cb691e69-8c21-4974-bdb6-6fe27de6ee65', 'TXN-624275',
        'd71907a8-5b6a-4d08-9ffd-baf12f7a0dd7',
        'MAIN|1|1|2026-07-06T12:12:56|101187507785|O-118243',
        326.25, 326.25, 0.00, 1,
        'bba39d8a-42c3-4cac-a17f-c526271d2ea3',
        '94e3f1c8-3cf5-4c60-9408-7720a77fc385', 326.25
    ),
    (
        'a8f0a383-2743-4ccb-9ce5-770767b22472', 'TXN-624104', 'open',
        406.85, 406.85, 0.00, 4,
        '8cfc65be-d2e1-448f-b23d-fcba1611076c', 'TXN-624276',
        '6f8f0145-422e-43bf-8820-ee4586128151',
        'MAIN|1|1|2026-07-06T12:28:50|101187516570|O-118244',
        306.29, 102.87, 203.42, 2,
        '506c0600-647a-4be4-935f-fd821ab68c8a',
        '415019a5-66d0-4de1-90b8-d8106a5981eb', 102.87
    ),
    (
        'f979db9f-b38f-4641-a31f-8569cb00462d', 'TXN-624115', 'open',
        544.13, 544.13, 0.00, 5,
        'c6ad7fa9-f050-4e59-a608-5c57ccf9124b', 'TXN-624281',
        '480218cb-86b2-40b2-b39d-d36fda620770',
        'MAIN|1|1|2026-07-06T16:13:05|101187640721|O-118249',
        326.25, 326.25, 0.00, 1,
        '62dae887-44d3-40e6-85b0-d472765fac59',
        '58eaf5b2-8082-46bc-b90e-070ad8fc521c', 326.25
    ),
    (
        '588a3db6-f540-4589-97db-276e0d7d49b3', 'TXN-624118', 'open',
        430.65, 215.33, 215.32, 2,
        '59e95868-339e-4306-a3ac-3bb352d9005e', 'TXN-624283',
        '5b551d00-358b-4754-b632-e7f01e433675',
        'MAIN|1|1|2026-07-06T16:22:20|101187680650|O-118251',
        282.75, 67.43, 215.32, 1,
        '751dc66e-8701-4fc1-9b26-b3896c4b4748',
        '77ae51da-81e9-4b1e-a003-cfd327c7c94b', 67.43
    ),
    (
        'bb29ffcb-1d99-4a0f-a72f-6be0356004c7', 'TXN-624137', 'fulfilled',
        485.12, 485.12, 0.00, 3,
        'e368caf8-5062-43b7-9695-8cf869deb083', 'TXN-624290',
        'b5229c7a-ab90-4b6e-9d41-14dbbc6cefa7',
        'MAIN|1|1|2026-07-07T17:58:36|101188744117|O-118258',
        282.75, 282.75, 0.00, 1,
        '71f78fd0-3a7d-4577-9a39-12dc18cd3861',
        '0fcb06f1-08b8-4fd1-b693-e7d6e83185c8', 282.75
    );

CREATE TEMP TABLE ros_176_line_matches (
    imported_id uuid NOT NULL,
    imported_line_id uuid PRIMARY KEY,
    canonical_id uuid NOT NULL,
    canonical_line_id uuid NOT NULL UNIQUE,
    variant_id uuid NOT NULL,
    quantity integer NOT NULL,
    unit_price numeric(14,2) NOT NULL,
    state_tax numeric(14,2) NOT NULL,
    local_tax numeric(14,2) NOT NULL
) ON COMMIT DROP;

INSERT INTO ros_176_line_matches (
    imported_id, imported_line_id, canonical_id, canonical_line_id,
    variant_id, quantity, unit_price, state_tax, local_tax
)
VALUES
    (
        'cb691e69-8c21-4974-bdb6-6fe27de6ee65',
        '1a51d2b0-0e84-47ba-a202-4a524aeea4dc',
        'f7df7f83-12bb-4351-a213-c6c676439ba5',
        '6fe3b5e2-a411-4af9-ba51-b06a3d14baa2',
        '6e9d0804-309d-452d-abe3-db5a00c0d68d', 1, 300.00, 12.00, 14.25
    ),
    (
        '8cfc65be-d2e1-448f-b23d-fcba1611076c',
        '4fa93588-9684-44b3-a250-e15a27afbd62',
        'a8f0a383-2743-4ccb-9ce5-770767b22472',
        '91c27b91-d2c4-479e-a0b5-ff962188945b',
        '064d82a3-1cd2-4217-af8b-39090e6a3dd9', 1, 64.00, 0.00, 3.04
    ),
    (
        '8cfc65be-d2e1-448f-b23d-fcba1611076c',
        '662d5359-393b-40d1-aaf2-c3e6b0936a1a',
        'a8f0a383-2743-4ccb-9ce5-770767b22472',
        '1ecdf0bf-34b3-4e66-ad13-32b679906c7b',
        '80658378-18dd-40e1-8cd9-d6e1dcdd68e8', 1, 220.00, 8.80, 10.45
    ),
    (
        'c6ad7fa9-f050-4e59-a608-5c57ccf9124b',
        'e7310d90-2fff-45e1-b516-1074748443f3',
        'f979db9f-b38f-4641-a31f-8569cb00462d',
        'e6dc02d7-0572-4d08-9698-3a9900a44c2b',
        'f4f8b2c6-441a-4433-8e9b-22b289944bfe', 1, 300.00, 12.00, 14.25
    ),
    (
        '59e95868-339e-4306-a3ac-3bb352d9005e',
        'ba3fd421-f776-4766-b097-4e6ca42b207d',
        '588a3db6-f540-4589-97db-276e0d7d49b3',
        'c8ace261-853f-4659-94e4-91831e95380f',
        '9a9009c9-e4c7-4153-bcee-2c3547a708d2', 1, 260.00, 10.40, 12.35
    ),
    (
        'e368caf8-5062-43b7-9695-8cf869deb083',
        '40348b5b-1f4a-459d-84da-4be00cf71062',
        'bb29ffcb-1d99-4a0f-a72f-6be0356004c7',
        'da71fcbf-c81b-4935-bd3d-0b33427c02c2',
        '92888799-3a0e-4c3e-92d6-05661209e0a7', 1, 260.00, 10.40, 12.35
    );

DO $repair$
DECLARE
    repair_actor uuid := 'bf085089-e50b-4247-ae0f-155d37803d41';
    repair_key text := 'counterpoint-subset-duplicate-reconciliation-2026-08-01';
    evidence_sha256 text := 'c51ee1ff5902d35528a6f75f5c70a3cd978df4394bca379824f211e907427fed';
    affected integer;
    target_rows integer;
    canonical_payment_before text;
    canonical_payment_after text;
    line_before text;
    line_after text;
    inventory_before text;
    inventory_after text;
BEGIN
    SELECT COUNT(*) INTO target_rows
    FROM public.transactions t
    WHERE t.id IN (
        SELECT canonical_id FROM ros_176_targets
        UNION ALL
        SELECT imported_id FROM ros_176_targets
    );

    -- Fresh databases do not contain this production-only incident cohort.
    IF target_rows = 0 THEN
        RETURN;
    END IF;
    IF target_rows <> 10 THEN
        RAISE EXCEPTION 'Migration 176 found only % of 10 reviewed transaction rows; no changes committed', target_rows;
    END IF;

    PERFORM 1
    FROM public.transactions t
    WHERE t.id IN (
        SELECT canonical_id FROM ros_176_targets
        UNION ALL
        SELECT imported_id FROM ros_176_targets
    )
    ORDER BY t.id
    FOR UPDATE;

    PERFORM 1
    FROM public.transaction_lines tl
    WHERE tl.transaction_id IN (
        SELECT canonical_id FROM ros_176_targets
        UNION ALL
        SELECT imported_id FROM ros_176_targets
    )
    ORDER BY tl.id
    FOR UPDATE;

    PERFORM 1
    FROM public.payment_allocations pa
    INNER JOIN public.payment_transactions pt ON pt.id = pa.transaction_id
    WHERE pa.target_transaction_id IN (
        SELECT canonical_id FROM ros_176_targets
        UNION ALL
        SELECT imported_id FROM ros_176_targets
    )
    ORDER BY pa.id
    FOR UPDATE OF pa, pt;

    PERFORM 1
    FROM public.product_variants pv
    WHERE pv.id IN (SELECT DISTINCT variant_id FROM ros_176_line_matches)
    ORDER BY pv.id
    FOR UPDATE;

    IF EXISTS (
        SELECT 1
        FROM public.ops_action_audit a
        WHERE a.action_key = repair_key
          AND a.payload_hash_sha256 = evidence_sha256
          AND a.result_ok
    ) THEN
        IF EXISTS (
            SELECT 1
            FROM ros_176_targets target
            LEFT JOIN public.transactions imported ON imported.id = target.imported_id
            LEFT JOIN public.payment_transactions pt ON pt.id = target.payment_id
            WHERE imported.status::text <> 'cancelled'
               OR ROUND(imported.total_price, 2) <> 0
               OR ROUND(imported.amount_paid, 2) <> 0
               OR ROUND(imported.balance_due, 2) <> 0
               OR imported.metadata->>'counterpoint_reconciliation_status' <> 'superseded'
               OR pt.status <> 'superseded'
               OR ROUND(pt.amount, 2) <> 0
               OR EXISTS (
                    SELECT 1 FROM public.payment_allocations pa
                    WHERE pa.id = target.allocation_id
               )
        ) THEN
            RAISE EXCEPTION 'Migration 176 audit exists but its post-state changed; no changes committed';
        END IF;
        RETURN;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.staff s
        WHERE s.id = repair_actor AND s.is_active AND s.full_name = 'Chris G'
    ) THEN
        RAISE EXCEPTION 'Migration 176 repair actor is not the active reviewed staff identity';
    END IF;

    IF (
        SELECT COUNT(*)
        FROM ros_176_targets target
        INNER JOIN public.transactions imported ON imported.id = target.imported_id
        INNER JOIN public.transactions canonical ON canonical.id = target.canonical_id
        WHERE imported.display_id = target.imported_display_id
          AND imported.customer_id = target.customer_id
          AND imported.customer_id = canonical.customer_id
          AND COALESCE(imported.is_counterpoint_import, FALSE)
          AND imported.counterpoint_doc_ref = target.counterpoint_doc_ref
          AND imported.status::text = 'open'
          AND ROUND(imported.total_price, 2) = target.imported_total
          AND ROUND(imported.amount_paid, 2) = target.imported_paid
          AND ROUND(imported.balance_due, 2) = target.imported_balance
          AND canonical.display_id = target.canonical_display_id
          AND NOT COALESCE(canonical.is_counterpoint_import, FALSE)
          AND canonical.status::text = target.canonical_status
          AND ROUND(canonical.total_price, 2) = target.canonical_total
          AND ROUND(canonical.amount_paid, 2) = target.canonical_paid
          AND ROUND(canonical.balance_due, 2) = target.canonical_balance
    ) <> 5 THEN
        RAISE EXCEPTION 'Migration 176 transaction header evidence changed; no changes committed';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM ros_176_targets target
        WHERE (SELECT COUNT(*) FROM public.transaction_lines tl WHERE tl.transaction_id = target.imported_id) <> target.imported_line_count
           OR (SELECT COUNT(*) FROM public.transaction_lines tl WHERE tl.transaction_id = target.canonical_id) <> target.canonical_line_count
    ) THEN
        RAISE EXCEPTION 'Migration 176 reviewed line counts changed; no changes committed';
    END IF;

    IF (
        SELECT COUNT(*)
        FROM ros_176_line_matches expected
        INNER JOIN public.transaction_lines imported
            ON imported.id = expected.imported_line_id
           AND imported.transaction_id = expected.imported_id
        INNER JOIN public.transaction_lines canonical
            ON canonical.id = expected.canonical_line_id
           AND canonical.transaction_id = expected.canonical_id
        WHERE imported.variant_id = expected.variant_id
          AND canonical.variant_id = expected.variant_id
          AND imported.quantity = expected.quantity
          AND canonical.quantity = expected.quantity
          AND ROUND(imported.unit_price, 2) = expected.unit_price
          AND ROUND(canonical.unit_price, 2) = expected.unit_price
          AND ROUND(imported.state_tax, 2) = expected.state_tax
          AND ROUND(canonical.state_tax, 2) = expected.state_tax
          AND ROUND(imported.local_tax, 2) = expected.local_tax
          AND ROUND(canonical.local_tax, 2) = expected.local_tax
    ) <> 6 THEN
        RAISE EXCEPTION 'Migration 176 exact product, quantity, price, or tax evidence changed; no changes committed';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM ros_176_targets target
        WHERE (
            SELECT COUNT(*)
            FROM public.transactions candidate
            WHERE candidate.customer_id = target.customer_id
              AND candidate.id <> target.imported_id
              AND NOT COALESCE(candidate.is_counterpoint_import, FALSE)
              AND candidate.booked_at BETWEEN
                    (SELECT booked_at FROM public.transactions WHERE id = target.imported_id) - INTERVAL '7 days'
                AND (SELECT booked_at FROM public.transactions WHERE id = target.imported_id) + INTERVAL '7 days'
              AND NOT EXISTS (
                    SELECT 1
                    FROM public.transaction_lines imported_line
                    WHERE imported_line.transaction_id = target.imported_id
                      AND NOT EXISTS (
                            SELECT 1
                            FROM public.transaction_lines candidate_line
                            WHERE candidate_line.transaction_id = candidate.id
                              AND candidate_line.variant_id = imported_line.variant_id
                              AND candidate_line.quantity = imported_line.quantity
                              AND ROUND(candidate_line.unit_price, 2) = ROUND(imported_line.unit_price, 2)
                              AND ROUND(candidate_line.state_tax, 2) = ROUND(imported_line.state_tax, 2)
                              AND ROUND(candidate_line.local_tax, 2) = ROUND(imported_line.local_tax, 2)
                      )
              )
        ) <> 1
    ) THEN
        RAISE EXCEPTION 'Migration 176 no longer has five unique subset matches; no changes committed';
    END IF;

    IF (
        SELECT COUNT(*)
        FROM ros_176_targets target
        INNER JOIN public.payment_allocations pa
            ON pa.id = target.allocation_id
           AND pa.target_transaction_id = target.imported_id
           AND pa.transaction_id = target.payment_id
        INNER JOIN public.payment_transactions pt ON pt.id = target.payment_id
        WHERE ROUND(pa.amount_allocated, 2) = target.allocation_amount
          AND ROUND(pt.amount, 2) = target.allocation_amount
          AND pt.status = 'success'
          AND pt.provider_payment_id IS NULL
          AND pt.provider_transaction_id IS NULL
          AND pt.metadata->>'counterpoint_doc_ref' = target.counterpoint_doc_ref
          AND (SELECT COUNT(*) FROM public.payment_allocations all_pa WHERE all_pa.transaction_id = pt.id) = 1
    ) <> 5 THEN
        RAISE EXCEPTION 'Migration 176 imported payment evidence changed; no changes committed';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.transaction_return_lines trl
        WHERE trl.transaction_id IN (
            SELECT canonical_id FROM ros_176_targets
            UNION ALL
            SELECT imported_id FROM ros_176_targets
        )
    ) OR EXISTS (
        SELECT 1
        FROM public.transaction_lines tl
        WHERE tl.transaction_id IN (SELECT imported_id FROM ros_176_targets)
          AND (
              tl.fulfillment_order_id IS NOT NULL
              OR tl.po_id IS NOT NULL
              OR tl.shipment_id IS NOT NULL
              OR tl.wedding_id IS NOT NULL
          )
    ) OR EXISTS (
        SELECT 1
        FROM public.counterpoint_transaction_reconciliation r
        WHERE r.canonical_transaction_id IN (
            SELECT canonical_id FROM ros_176_targets
            UNION ALL
            SELECT imported_id FROM ros_176_targets
        )
           OR r.superseded_transaction_ids && ARRAY(SELECT imported_id FROM ros_176_targets)
    ) THEN
        RAISE EXCEPTION 'Migration 176 found protected return, fulfillment, or prior reconciliation evidence';
    END IF;

    SELECT md5(COALESCE(jsonb_agg(payload ORDER BY payment_id)::text, '[]'))
    INTO canonical_payment_before
    FROM (
        SELECT
            pt.id AS payment_id,
            jsonb_build_object('payment', to_jsonb(pt), 'allocation', to_jsonb(pa)) AS payload
        FROM public.payment_allocations pa
        INNER JOIN public.payment_transactions pt ON pt.id = pa.transaction_id
        WHERE pa.target_transaction_id IN (SELECT canonical_id FROM ros_176_targets)
    ) snapshot;

    SELECT md5(COALESCE(jsonb_agg(to_jsonb(tl) ORDER BY tl.id)::text, '[]'))
    INTO line_before
    FROM public.transaction_lines tl
    WHERE tl.transaction_id IN (
        SELECT canonical_id FROM ros_176_targets
        UNION ALL
        SELECT imported_id FROM ros_176_targets
    );

    SELECT md5(COALESCE(jsonb_agg(to_jsonb(pv) ORDER BY pv.id)::text, '[]'))
    INTO inventory_before
    FROM public.product_variants pv
    WHERE pv.id IN (SELECT DISTINCT variant_id FROM ros_176_line_matches);

    INSERT INTO public.counterpoint_transaction_reconciliation (
        id, canonical_transaction_id, superseded_transaction_ids,
        moved_payment_ids, superseded_payment_ids, snapshot,
        reconciled_by_staff_id, reason, review_manifest_digest
    )
    SELECT
        target.reconciliation_id,
        target.canonical_id,
        ARRAY[target.imported_id],
        '{}'::uuid[],
        ARRAY[target.payment_id],
        jsonb_build_object(
            'repair_kind', 'exact_counterpoint_subset_duplicate',
            'evidence_sha256', evidence_sha256,
            'canonical', (
                SELECT jsonb_build_object(
                    'id', t.id, 'display_id', t.display_id, 'status', t.status,
                    'total_price', ROUND(t.total_price, 2)::text,
                    'amount_paid', ROUND(t.amount_paid, 2)::text,
                    'balance_due', ROUND(t.balance_due, 2)::text
                )
                FROM public.transactions t WHERE t.id = target.canonical_id
            ),
            'imported_duplicate', (
                SELECT jsonb_build_object(
                    'id', t.id, 'display_id', t.display_id, 'status', t.status,
                    'counterpoint_doc_ref', t.counterpoint_doc_ref,
                    'total_price', ROUND(t.total_price, 2)::text,
                    'amount_paid', ROUND(t.amount_paid, 2)::text,
                    'balance_due', ROUND(t.balance_due, 2)::text
                )
                FROM public.transactions t WHERE t.id = target.imported_id
            ),
            'imported_lines', (
                SELECT jsonb_agg(jsonb_build_object(
                    'id', tl.id, 'variant_id', tl.variant_id, 'quantity', tl.quantity,
                    'unit_price', ROUND(tl.unit_price, 2)::text,
                    'state_tax', ROUND(tl.state_tax, 2)::text,
                    'local_tax', ROUND(tl.local_tax, 2)::text,
                    'fulfillment', tl.fulfillment,
                    'order_lifecycle_status', tl.order_lifecycle_status,
                    'is_fulfilled', tl.is_fulfilled
                ) ORDER BY tl.id)
                FROM public.transaction_lines tl WHERE tl.transaction_id = target.imported_id
            ),
            'imported_payment', (
                SELECT jsonb_build_object(
                    'payment_id', pt.id, 'allocation_id', pa.id,
                    'payment_method', pt.payment_method,
                    'status', pt.status,
                    'amount', ROUND(pt.amount, 2)::text,
                    'amount_allocated', ROUND(pa.amount_allocated, 2)::text,
                    'provider_payment_id', pt.provider_payment_id,
                    'provider_transaction_id', pt.provider_transaction_id
                )
                FROM public.payment_allocations pa
                INNER JOIN public.payment_transactions pt ON pt.id = pa.transaction_id
                WHERE pa.id = target.allocation_id
            ),
            'canonical_transactions_unchanged', TRUE,
            'provider_payments_unchanged', TRUE,
            'inventory_unchanged', TRUE,
            'fulfillment_links_unchanged', TRUE
        ),
        repair_actor,
        'Supersede exact Counterpoint subset copy of an existing ROS transaction.',
        evidence_sha256
    FROM ros_176_targets target;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 5 THEN
        RAISE EXCEPTION 'Migration 176 created % of 5 reconciliation snapshots', affected;
    END IF;

    DELETE FROM public.payment_allocations pa
    USING ros_176_targets target
    WHERE pa.id = target.allocation_id
      AND pa.transaction_id = target.payment_id
      AND pa.target_transaction_id = target.imported_id
      AND ROUND(pa.amount_allocated, 2) = target.allocation_amount;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 5 THEN
        RAISE EXCEPTION 'Migration 176 removed % of 5 imported allocations', affected;
    END IF;

    UPDATE public.payment_transactions pt
    SET amount = 0,
        merchant_fee = 0,
        net_amount = 0,
        status = 'superseded',
        metadata = COALESCE(pt.metadata, '{}'::jsonb) || jsonb_build_object(
            'counterpoint_reconciliation_id', target.reconciliation_id::text,
            'counterpoint_reconciliation_action', 'superseded_subset_duplicate',
            'counterpoint_reconciliation_original_amount', target.allocation_amount::text,
            'counterpoint_reconciliation_canonical_transaction_id', target.canonical_id::text,
            'review_manifest_digest', evidence_sha256
        )
    FROM ros_176_targets target
    WHERE pt.id = target.payment_id
      AND pt.status = 'success'
      AND ROUND(pt.amount, 2) = target.allocation_amount
      AND pt.provider_payment_id IS NULL
      AND pt.provider_transaction_id IS NULL;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 5 THEN
        RAISE EXCEPTION 'Migration 176 superseded % of 5 imported payment artifacts', affected;
    END IF;

    UPDATE public.transactions imported
    SET status = 'cancelled',
        fulfilled_at = NULL,
        total_price = 0,
        amount_paid = 0,
        balance_due = 0,
        metadata = COALESCE(imported.metadata, '{}'::jsonb) || jsonb_build_object(
            'counterpoint_reconciliation_status', 'superseded',
            'counterpoint_reconciliation_id', target.reconciliation_id::text,
            'counterpoint_reconciliation_canonical_transaction_id', target.canonical_id::text,
            'counterpoint_reconciled_at', CURRENT_TIMESTAMP,
            'counterpoint_subset_duplicate_evidence_sha256', evidence_sha256,
            'provider_payments_unchanged', TRUE,
            'inventory_unchanged', TRUE,
            'fulfillment_links_unchanged', TRUE
        )
    FROM ros_176_targets target
    WHERE imported.id = target.imported_id
      AND imported.status::text = 'open'
      AND ROUND(imported.total_price, 2) = target.imported_total
      AND ROUND(imported.amount_paid, 2) = target.imported_paid
      AND ROUND(imported.balance_due, 2) = target.imported_balance;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 5 THEN
        RAISE EXCEPTION 'Migration 176 superseded % of 5 imported transaction shells', affected;
    END IF;

    INSERT INTO public.transaction_activity_log (
        transaction_id, customer_id, event_kind, summary, metadata
    )
    SELECT
        activity.transaction_id,
        target.customer_id,
        'counterpoint_reconciliation',
        CASE
            WHEN activity.transaction_id = target.canonical_id
                THEN 'Retained original ROS transaction after exact Counterpoint subset duplicate review.'
            ELSE 'Superseded exact Counterpoint subset duplicate of an existing ROS transaction.'
        END,
        jsonb_build_object(
            'repair_kind', 'exact_counterpoint_subset_duplicate',
            'counterpoint_reconciliation_id', target.reconciliation_id::text,
            'canonical_transaction_id', target.canonical_id::text,
            'superseded_transaction_id', target.imported_id::text,
            'reconciled_by_staff_id', repair_actor::text,
            'reason', 'User-approved repair of five exact Counterpoint subset duplicate orders.',
            'review_manifest_digest', evidence_sha256,
            'canonical_transactions_unchanged', TRUE,
            'provider_payments_unchanged', TRUE,
            'inventory_unchanged', TRUE,
            'fulfillment_links_unchanged', TRUE
        )
    FROM ros_176_targets target
    CROSS JOIN LATERAL (
        VALUES (target.canonical_id), (target.imported_id)
    ) activity(transaction_id);
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 10 THEN
        RAISE EXCEPTION 'Migration 176 wrote % of 10 transaction audit rows', affected;
    END IF;

    SELECT md5(COALESCE(jsonb_agg(payload ORDER BY payment_id)::text, '[]'))
    INTO canonical_payment_after
    FROM (
        SELECT
            pt.id AS payment_id,
            jsonb_build_object('payment', to_jsonb(pt), 'allocation', to_jsonb(pa)) AS payload
        FROM public.payment_allocations pa
        INNER JOIN public.payment_transactions pt ON pt.id = pa.transaction_id
        WHERE pa.target_transaction_id IN (SELECT canonical_id FROM ros_176_targets)
    ) snapshot;

    SELECT md5(COALESCE(jsonb_agg(to_jsonb(tl) ORDER BY tl.id)::text, '[]'))
    INTO line_after
    FROM public.transaction_lines tl
    WHERE tl.transaction_id IN (
        SELECT canonical_id FROM ros_176_targets
        UNION ALL
        SELECT imported_id FROM ros_176_targets
    );

    SELECT md5(COALESCE(jsonb_agg(to_jsonb(pv) ORDER BY pv.id)::text, '[]'))
    INTO inventory_after
    FROM public.product_variants pv
    WHERE pv.id IN (SELECT DISTINCT variant_id FROM ros_176_line_matches);

    IF canonical_payment_before IS DISTINCT FROM canonical_payment_after
       OR line_before IS DISTINCT FROM line_after
       OR inventory_before IS DISTINCT FROM inventory_after THEN
        RAISE EXCEPTION 'Migration 176 changed protected payment, line, fulfillment, or inventory evidence';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM ros_176_targets target
        INNER JOIN public.transactions imported ON imported.id = target.imported_id
        INNER JOIN public.transactions canonical ON canonical.id = target.canonical_id
        INNER JOIN public.payment_transactions pt ON pt.id = target.payment_id
        WHERE imported.status::text <> 'cancelled'
           OR ROUND(imported.total_price, 2) <> 0
           OR ROUND(imported.amount_paid, 2) <> 0
           OR ROUND(imported.balance_due, 2) <> 0
           OR imported.metadata->>'counterpoint_reconciliation_status' <> 'superseded'
           OR canonical.status::text <> target.canonical_status
           OR ROUND(canonical.total_price, 2) <> target.canonical_total
           OR ROUND(canonical.amount_paid, 2) <> target.canonical_paid
           OR ROUND(canonical.balance_due, 2) <> target.canonical_balance
           OR pt.status <> 'superseded'
           OR ROUND(pt.amount, 2) <> 0
           OR EXISTS (SELECT 1 FROM public.payment_allocations pa WHERE pa.id = target.allocation_id)
    ) THEN
        RAISE EXCEPTION 'Migration 176 failed its atomic post-state verification';
    END IF;

    INSERT INTO public.ops_action_audit (
        actor_staff_id, action_key, reason, payload_json,
        payload_hash_sha256, result_ok, result_message, result_json
    )
    VALUES (
        repair_actor,
        repair_key,
        'User-approved repair of five exact Counterpoint subset duplicate orders.',
        jsonb_build_object(
            'evidence_file', 'docs/incidents/evidence/2026-08-01-counterpoint-subset-duplicate-reconciliation.json',
            'candidate_count', 5,
            'canonical_transaction_ids', ARRAY(SELECT canonical_id FROM ros_176_targets ORDER BY canonical_id),
            'superseded_transaction_ids', ARRAY(SELECT imported_id FROM ros_176_targets ORDER BY imported_id)
        ),
        evidence_sha256,
        TRUE,
        'Superseded five exact Counterpoint subset duplicate shells without changing canonical transactions, provider payments, inventory, lines, or fulfillment links.',
        jsonb_build_object(
            'reconciled_transactions', 5,
            'superseded_payment_artifacts', 5,
            'removed_imported_allocations', 5,
            'false_open_balance_removed', '418.74',
            'duplicate_transaction_total_removed', '1524.29',
            'duplicate_imported_allocations_removed', '1105.55',
            'canonical_transactions_changed', FALSE,
            'provider_payments_changed', FALSE,
            'inventory_changed', FALSE,
            'transaction_lines_changed', FALSE,
            'fulfillment_links_changed', FALSE
        )
    );
END
$repair$;

COMMIT;
