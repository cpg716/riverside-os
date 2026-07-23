\set ON_ERROR_STOP on

-- Run only against a disposable, fully migrated database:
--   psql "$DATABASE_URL" \
--     -f docs/incidents/design/held-bulk-fulfillment-operation-guard.sql
--   psql "$DATABASE_URL" -v ros_guard_regression=1 \
--     -f scripts/test-bulk-fulfillment-guard.sql
--
-- Every fixture and successful mutation is rolled back. The explicit psql
-- variable prevents accidental execution without an intentional test command.
\if :{?ros_guard_regression}
\else
\echo 'Refusing to run: pass -v ros_guard_regression=1 against a disposable database.'
\quit 3
\endif

\if :ros_guard_regression
\else
\echo 'Refusing to run: ros_guard_regression must be truthy.'
\quit 3
\endif

BEGIN;
SELECT set_config('riverside.bulk_fulfillment_operation_id', '', true);

DO $test$
BEGIN
    IF to_regclass('public.bulk_fulfillment_operation_manifest') IS NULL
       OR to_regclass('public.bulk_fulfillment_transition_event') IS NULL THEN
        RAISE EXCEPTION 'held fulfillment guard design must be applied before running this harness';
    END IF;
END
$test$;

INSERT INTO public.staff (id, full_name, cashier_code, role)
VALUES
    ('f1500000-0000-0000-0000-000000000001', 'Guard Test Actor', 'F150A', 'admin'),
    ('f1500000-0000-0000-0000-000000000002', 'Guard Test Manager', 'F150M', 'admin');

INSERT INTO public.products (id, name, base_retail_price, base_cost)
VALUES (
    'f1504000-0000-0000-0000-000000000001',
    'Migration 150 Guard Fixture',
    10.00,
    5.00
);

-- Two pre-fulfilled fixtures are inserted directly because migration 150 is an
-- UPDATE-statement guard. This is another explicit residual boundary: INSERT,
-- COPY, and DELETE paths are not protected by this harness/migration.
INSERT INTO public.transactions (
    id,
    display_id,
    total_price,
    balance_due,
    status,
    fulfilled_at
)
VALUES
    (
        'f1501000-0000-0000-0000-000000000001',
        'TXN-F150-1',
        10.00,
        10.00,
        'open',
        NULL
    ),
    (
        'f1501000-0000-0000-0000-000000000002',
        'TXN-F150-2',
        20.00,
        20.00,
        'open',
        NULL
    ),
    (
        'f1501000-0000-0000-0000-000000000003',
        'TXN-F150-3',
        30.00,
        30.00,
        'open',
        NULL
    ),
    (
        'f1501000-0000-0000-0000-000000000004',
        'TXN-F150-4-FULFILLED',
        40.00,
        40.00,
        'fulfilled',
        TIMESTAMPTZ '2026-07-21 20:49:04+00'
    ),
    (
        'f1501000-0000-0000-0000-000000000005',
        'TXN-F150-5-FULFILLED',
        50.00,
        50.00,
        'fulfilled',
        TIMESTAMPTZ '2026-07-21 20:49:04+00'
    );

-- A normal one-Transaction statement remains valid without a manifest and is audited.
SAVEPOINT normal_single_transaction;
UPDATE public.transactions
SET status = 'fulfilled', fulfilled_at = CURRENT_TIMESTAMP
WHERE id = 'f1501000-0000-0000-0000-000000000001';

DO $test$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM public.bulk_fulfillment_transition_event event
        WHERE event.source_table = 'transactions'
          AND event.transaction_id = 'f1501000-0000-0000-0000-000000000001'
          AND event.operation_id IS NULL
          AND event.changed_transaction_count = 1
    ) THEN
        RAISE EXCEPTION 'normal one-Transaction update was not audited';
    END IF;
END
$test$;

UPDATE public.transactions
SET status = 'open', fulfilled_at = NULL
WHERE id = 'f1501000-0000-0000-0000-000000000001';
ROLLBACK TO SAVEPOINT normal_single_transaction;
RELEASE SAVEPOINT normal_single_transaction;

-- Documented residual boundary: repeated one-row statements are individually
-- audited but are not classified as bulk by a statement-level trigger. This
-- proves the harness cannot be cited as protection against an autocommit/loop
-- path; those paths require a trusted service/role boundary.
SAVEPOINT sequential_single_row_statements;
UPDATE public.transactions
SET status = 'fulfilled', fulfilled_at = CURRENT_TIMESTAMP
WHERE id = 'f1501000-0000-0000-0000-000000000001';

UPDATE public.transactions
SET status = 'fulfilled', fulfilled_at = CURRENT_TIMESTAMP
WHERE id = 'f1501000-0000-0000-0000-000000000002';

DO $test$
BEGIN
    IF (
        SELECT COUNT(*)
        FROM public.bulk_fulfillment_transition_event event
        WHERE event.transaction_id IN (
            'f1501000-0000-0000-0000-000000000001',
            'f1501000-0000-0000-0000-000000000002'
        )
          AND event.operation_id IS NULL
          AND event.changed_transaction_count = 1
    ) <> 2 THEN
        RAISE EXCEPTION 'sequential one-row boundary did not emit one audit event per statement';
    END IF;
END
$test$;
ROLLBACK TO SAVEPOINT sequential_single_row_statements;
RELEASE SAVEPOINT sequential_single_row_statements;

-- More than one changed Transaction Record must fail without a manifest, and
-- the AFTER-trigger exception must roll the entire UPDATE back.
DO $test$
BEGIN
    BEGIN
        UPDATE public.transactions
        SET status = 'fulfilled', fulfilled_at = CURRENT_TIMESTAMP
        WHERE id IN (
            'f1501000-0000-0000-0000-000000000001',
            'f1501000-0000-0000-0000-000000000002'
        );
        RAISE EXCEPTION 'unmanifested bulk update was not rejected';
    EXCEPTION WHEN SQLSTATE '23514' THEN
        NULL;
    END;

    IF EXISTS (
        SELECT 1
        FROM public.transactions
        WHERE id IN (
            'f1501000-0000-0000-0000-000000000001',
            'f1501000-0000-0000-0000-000000000002'
        )
          AND (status <> 'open' OR fulfilled_at IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'rejected bulk update did not roll back';
    END IF;
END
$test$;

-- The database hard limit rejects manifests larger than 100 Transaction Records.
DO $test$
BEGIN
    BEGIN
        INSERT INTO public.bulk_fulfillment_operation_manifest (
            operation_id,
            correlation_id,
            operation_kind,
            transaction_ids,
            expected_transaction_count,
            actor_staff_id,
            confirming_manager_staff_id,
            reason,
            manifest_digest
        ) VALUES (
            'f1502000-0000-0000-0000-000000000101',
            'f1503000-0000-0000-0000-000000000101',
            'counterpoint_false_fulfillment_restore_open',
            ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 101)),
            101,
            'f1500000-0000-0000-0000-000000000001',
            'f1500000-0000-0000-0000-000000000002',
            'Regression proof for the one-hundred record hard limit',
            repeat('f', 64)
        );
        RAISE EXCEPTION 'manifest larger than 100 records was not rejected';
    EXCEPTION WHEN SQLSTATE '23514' THEN
        NULL;
    END;
END
$test$;

SAVEPOINT manifested_restore_open_contract;
INSERT INTO public.bulk_fulfillment_operation_manifest (
    operation_id,
    correlation_id,
    operation_kind,
    transaction_ids,
    expected_transaction_count,
    actor_staff_id,
    confirming_manager_staff_id,
    reason,
    manifest_digest
) VALUES (
    'f1502000-0000-0000-0000-000000000001',
    'f1503000-0000-0000-0000-000000000001',
    'counterpoint_false_fulfillment_restore_open',
    ARRAY[
        'f1501000-0000-0000-0000-000000000004'::uuid,
        'f1501000-0000-0000-0000-000000000005'::uuid
    ],
    2,
    'f1500000-0000-0000-0000-000000000001',
    'f1500000-0000-0000-0000-000000000002',
    'Reviewed exact migration 150 regression scope',
    repeat('1', 64)
);

-- A configured manifest whose IDs do not exactly match the changed set fails.
SELECT set_config(
    'riverside.bulk_fulfillment_operation_id',
    'f1502000-0000-0000-0000-000000000001',
    true
);
DO $test$
BEGIN
    BEGIN
        UPDATE public.transactions
        SET status = 'cancelled'
        WHERE id IN (
            'f1501000-0000-0000-0000-000000000004',
            'f1501000-0000-0000-0000-000000000003'
        );
        RAISE EXCEPTION 'mismatched manifest was accepted';
    EXCEPTION WHEN SQLSTATE '23514' THEN
        NULL;
    END;
END
$test$;
SELECT set_config('riverside.bulk_fulfillment_operation_id', '', true);

-- Exact scope is not enough: the operation kind authorizes fulfilled -> open
-- only, so a different status direction must fail and roll back.
SELECT set_config(
    'riverside.bulk_fulfillment_operation_id',
    'f1502000-0000-0000-0000-000000000001',
    true
);
DO $test$
BEGIN
    BEGIN
        UPDATE public.transactions
        SET status = 'cancelled'
        WHERE id IN (
            'f1501000-0000-0000-0000-000000000004',
            'f1501000-0000-0000-0000-000000000005'
        );
        RAISE EXCEPTION 'wrong manifest transition direction was accepted';
    EXCEPTION WHEN SQLSTATE '23514' THEN
        NULL;
    END;

    IF EXISTS (
        SELECT 1
        FROM public.transactions
        WHERE id IN (
            'f1501000-0000-0000-0000-000000000004',
            'f1501000-0000-0000-0000-000000000005'
        )
          AND status <> 'fulfilled'
    ) THEN
        RAISE EXCEPTION 'wrong-direction update did not roll back';
    END IF;
END
$test$;
SELECT set_config('riverside.bulk_fulfillment_operation_id', '', true);

-- A restore manifest cannot be used as cover for changing any other header
-- field in the same statement.
SELECT set_config(
    'riverside.bulk_fulfillment_operation_id',
    'f1502000-0000-0000-0000-000000000001',
    true
);
DO $test$
BEGIN
    BEGIN
        UPDATE public.transactions
        SET
            status = 'open',
            fulfilled_at = NULL,
            notes = 'unauthorized extra mutation'
        WHERE id IN (
            'f1501000-0000-0000-0000-000000000004',
            'f1501000-0000-0000-0000-000000000005'
        );
        RAISE EXCEPTION 'manifest allowed an extra transaction-column mutation';
    EXCEPTION WHEN SQLSTATE '23514' THEN
        NULL;
    END;

    IF EXISTS (
        SELECT 1
        FROM public.transactions
        WHERE id IN (
            'f1501000-0000-0000-0000-000000000004',
            'f1501000-0000-0000-0000-000000000005'
        )
          AND (
              status <> 'fulfilled'
              OR fulfilled_at IS NULL
              OR notes IS NOT NULL
          )
    ) THEN
        RAISE EXCEPTION 'extra-column manifested update did not roll back';
    END IF;
END
$test$;
SELECT set_config('riverside.bulk_fulfillment_operation_id', '', true);

-- The exact manifest succeeds and emits one immutable before/after event per ID.
SELECT set_config(
    'riverside.bulk_fulfillment_operation_id',
    'f1502000-0000-0000-0000-000000000001',
    true
);
UPDATE public.transactions
SET status = 'open', fulfilled_at = NULL
WHERE id IN (
    'f1501000-0000-0000-0000-000000000004',
    'f1501000-0000-0000-0000-000000000005'
);
SELECT set_config('riverside.bulk_fulfillment_operation_id', '', true);

DO $test$
BEGIN
    IF (
        SELECT COUNT(*)
        FROM public.bulk_fulfillment_transition_event event
        WHERE event.operation_id = 'f1502000-0000-0000-0000-000000000001'
          AND event.source_table = 'transactions'
    ) <> 2 THEN
        RAISE EXCEPTION 'exact manifested update did not emit one event per Transaction Record';
    END IF;

    BEGIN
        UPDATE public.bulk_fulfillment_operation_manifest
        SET reason = 'Attempted immutable manifest rewrite'
        WHERE operation_id = 'f1502000-0000-0000-0000-000000000001';
        RAISE EXCEPTION 'manifest immutability guard did not fire';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;

    BEGIN
        UPDATE public.bulk_fulfillment_transition_event
        SET after_state = after_state
        WHERE operation_id = 'f1502000-0000-0000-0000-000000000001';
        RAISE EXCEPTION 'event immutability guard did not fire';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;
END
$test$;

-- Clearing the public operation setting cannot turn the remainder of the same
-- database transaction into an unmanifested mutation path.
DO $test$
BEGIN
    BEGIN
        UPDATE public.transactions
        SET status = 'fulfilled', fulfilled_at = CURRENT_TIMESTAMP
        WHERE id = 'f1501000-0000-0000-0000-000000000001';
        RAISE EXCEPTION 'manifested transaction accepted a later unmanifested mutation';
    EXCEPTION WHEN SQLSTATE '23514' THEN
        NULL;
    END;
END
$test$;

-- An immutable manifest is single-use. Re-selecting the same exact scope for a
-- second recognition-driving change must fail before any mutation is applied.
SELECT set_config(
    'riverside.bulk_fulfillment_operation_id',
    'f1502000-0000-0000-0000-000000000001',
    true
);
DO $test$
BEGIN
    BEGIN
        UPDATE public.transactions
        SET fulfillment_method = 'ship'
        WHERE id IN (
            'f1501000-0000-0000-0000-000000000004',
            'f1501000-0000-0000-0000-000000000005'
        );
        RAISE EXCEPTION 'consumed fulfillment manifest was reused';
    EXCEPTION WHEN SQLSTATE '23514' THEN
        NULL;
    END;

    IF EXISTS (
        SELECT 1
        FROM public.transactions
        WHERE id IN (
            'f1501000-0000-0000-0000-000000000004',
            'f1501000-0000-0000-0000-000000000005'
        )
          AND fulfillment_method::text = 'ship'
    ) THEN
        RAISE EXCEPTION 'reused-manifest update did not roll back';
    END IF;
END
$test$;
SELECT set_config('riverside.bulk_fulfillment_operation_id', '', true);

-- Multiple immutable post-verification snapshots may be appended for the same
-- operation after a review is resolved.
INSERT INTO public.bulk_fulfillment_operation_verification (
    verification_id,
    operation_id,
    verified_by_staff_id,
    expected_transaction_count,
    verified_transaction_count,
    overall_status,
    qbo_traceability,
    evidence_digest,
    summary
) VALUES
    (
        'f1507000-0000-0000-0000-000000000001',
        'f1502000-0000-0000-0000-000000000001',
        'f1500000-0000-0000-0000-000000000002',
        2,
        2,
        'verified',
        'Initial QBO traceability verification',
        repeat('7', 64),
        '{"phase":"initial"}'::jsonb
    ),
    (
        'f1507000-0000-0000-0000-000000000002',
        'f1502000-0000-0000-0000-000000000001',
        'f1500000-0000-0000-0000-000000000002',
        2,
        2,
        'verified',
        'Follow-up QBO traceability verification',
        repeat('8', 64),
        '{"phase":"follow_up"}'::jsonb
    );

INSERT INTO public.bulk_fulfillment_operation_verification_record (
    verification_id,
    operation_id,
    transaction_id,
    verification_status,
    transaction_evidence,
    line_evidence,
    payment_evidence,
    inventory_evidence,
    revenue_evidence,
    commission_evidence,
    loyalty_evidence,
    audit_evidence,
    qbo_evidence,
    record_digest
)
SELECT
    verification.verification_id,
    verification.operation_id,
    scope.transaction_id,
    'verified',
    '{}'::jsonb,
    '{}'::jsonb,
    '{}'::jsonb,
    '{}'::jsonb,
    '{}'::jsonb,
    '{}'::jsonb,
    '{}'::jsonb,
    '{}'::jsonb,
    '{}'::jsonb,
    repeat('9', 64)
FROM public.bulk_fulfillment_operation_verification verification
INNER JOIN public.bulk_fulfillment_operation_record scope
    ON scope.operation_id = verification.operation_id
WHERE verification.verification_id IN (
    'f1507000-0000-0000-0000-000000000001',
    'f1507000-0000-0000-0000-000000000002'
);

SET CONSTRAINTS
    bulk_fulfillment_verification_completeness,
    bulk_fulfillment_verification_record_completeness
IMMEDIATE;
SET CONSTRAINTS
    bulk_fulfillment_verification_completeness,
    bulk_fulfillment_verification_record_completeness
DEFERRED;

DO $test$
BEGIN
    BEGIN
        UPDATE public.bulk_fulfillment_operation_verification
        SET summary = summary
        WHERE verification_id = 'f1507000-0000-0000-0000-000000000001';
        RAISE EXCEPTION 'verification immutability guard did not fire';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;
END
$test$;

ROLLBACK TO SAVEPOINT manifested_restore_open_contract;
RELEASE SAVEPOINT manifested_restore_open_contract;

-- Orphan Fulfillment Orders cannot change state because their Transaction scope
-- cannot be audited.
INSERT INTO public.fulfillment_orders (id, display_id)
VALUES ('f1505000-0000-0000-0000-000000000001', 'ORD-F150-ORPHAN');

DO $test$
BEGIN
    BEGIN
        UPDATE public.fulfillment_orders
        SET status = 'ready'
        WHERE id = 'f1505000-0000-0000-0000-000000000001';
        RAISE EXCEPTION 'unmapped Fulfillment Order update was not rejected';
    EXCEPTION WHEN SQLSTATE '23514' THEN
        NULL;
    END;
END
$test$;

-- Multiple Fulfillment Orders mapped to one exact Transaction Record are a
-- normal lifecycle operation. They remain bounded to 100 orders and emit one
-- immutable event per changed Fulfillment Order.
INSERT INTO public.fulfillment_orders (id, display_id)
VALUES
    ('f1505000-0000-0000-0000-000000000002', 'ORD-F150-MAPPED-1'),
    ('f1505000-0000-0000-0000-000000000003', 'ORD-F150-MAPPED-2');

INSERT INTO public.transaction_lines (
    id,
    transaction_id,
    fulfillment_order_id,
    product_id,
    fulfillment,
    quantity,
    unit_price,
    unit_cost,
    line_display_id,
    is_internal
) VALUES
    (
        'f1506000-0000-0000-0000-000000000001',
        'f1501000-0000-0000-0000-000000000001',
        'f1505000-0000-0000-0000-000000000002',
        'f1504000-0000-0000-0000-000000000001',
        'special_order',
        1,
        10.00,
        5.00,
        'LINE-F150-1',
        FALSE
    ),
    (
        'f1506000-0000-0000-0000-000000000002',
        'f1501000-0000-0000-0000-000000000001',
        'f1505000-0000-0000-0000-000000000003',
        'f1504000-0000-0000-0000-000000000001',
        'special_order',
        1,
        10.00,
        5.00,
        'LINE-F150-2',
        FALSE
    ),
    (
        'f1506000-0000-0000-0000-000000000003',
        'f1501000-0000-0000-0000-000000000002',
        NULL,
        'f1504000-0000-0000-0000-000000000001',
        'special_order',
        1,
        10.00,
        5.00,
        'LINE-F150-3',
        FALSE
    );

-- Reassigning one line between two Transaction Records changes both scopes and
-- cannot be smuggled through as a one-row update.
DO $test$
BEGIN
    BEGIN
        UPDATE public.transaction_lines
        SET transaction_id = 'f1501000-0000-0000-0000-000000000002'
        WHERE id = 'f1506000-0000-0000-0000-000000000001';
        RAISE EXCEPTION 'cross-Transaction line reassignment was not rejected';
    EXCEPTION WHEN SQLSTATE '23514' THEN
        NULL;
    END;

    IF (
        SELECT transaction_id
            <> 'f1501000-0000-0000-0000-000000000001'::uuid
        FROM public.transaction_lines
        WHERE id = 'f1506000-0000-0000-0000-000000000001'
    ) THEN
        RAISE EXCEPTION 'rejected line reassignment did not roll back';
    END IF;
END
$test$;

-- A recognition-driving fulfillment-type update spanning two Transaction
-- Records also requires an approved, operation-specific path.
DO $test$
BEGIN
    BEGIN
        UPDATE public.transaction_lines
        SET fulfillment = 'takeaway'
        WHERE id IN (
            'f1506000-0000-0000-0000-000000000001',
            'f1506000-0000-0000-0000-000000000003'
        );
        RAISE EXCEPTION 'multi-Transaction fulfillment-type update was not rejected';
    EXCEPTION WHEN SQLSTATE '23514' THEN
        NULL;
    END;

    IF EXISTS (
        SELECT 1
        FROM public.transaction_lines
        WHERE id IN (
            'f1506000-0000-0000-0000-000000000001',
            'f1506000-0000-0000-0000-000000000003'
        )
          AND fulfillment::text = 'takeaway'
    ) THEN
        RAISE EXCEPTION 'rejected fulfillment-type update did not roll back';
    END IF;
END
$test$;

-- Lifecycle actor/provenance fields are watched too; they cannot be rewritten
-- across Transaction Records without entering the same exact-scope guard.
DO $test$
BEGIN
    BEGIN
        UPDATE public.transaction_lines
        SET picked_up_by = 'f1500000-0000-0000-0000-000000000001'
        WHERE id IN (
            'f1506000-0000-0000-0000-000000000001',
            'f1506000-0000-0000-0000-000000000003'
        );
        RAISE EXCEPTION 'multi-Transaction lifecycle actor rewrite was not rejected';
    EXCEPTION WHEN SQLSTATE '23514' THEN
        NULL;
    END;

    IF EXISTS (
        SELECT 1
        FROM public.transaction_lines
        WHERE id IN (
            'f1506000-0000-0000-0000-000000000001',
            'f1506000-0000-0000-0000-000000000003'
        )
          AND picked_up_by IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'rejected lifecycle actor rewrite did not roll back';
    END IF;
END
$test$;

SAVEPOINT bounded_multi_order;
UPDATE public.fulfillment_orders
SET status = 'ready'
WHERE id IN (
    'f1505000-0000-0000-0000-000000000002',
    'f1505000-0000-0000-0000-000000000003'
);

DO $test$
BEGIN
    IF (
        SELECT COUNT(*)
        FROM public.bulk_fulfillment_transition_event event
        WHERE event.source_table = 'fulfillment_orders'
          AND event.source_record_id IN (
            'f1505000-0000-0000-0000-000000000002',
            'f1505000-0000-0000-0000-000000000003'
          )
          AND event.transaction_id =
              'f1501000-0000-0000-0000-000000000001'::uuid
          AND event.changed_transaction_count = 1
          AND event.operation_id IS NULL
    ) <> 2 THEN
        RAISE EXCEPTION 'bounded multi-order update was not fully audited';
    END IF;
END
$test$;
ROLLBACK TO SAVEPOINT bounded_multi_order;
RELEASE SAVEPOINT bounded_multi_order;

-- One statement cannot exceed the 100-Fulfillment-Order hard cap, even when
-- all changed orders map to one Transaction Record.
INSERT INTO public.fulfillment_orders (id, display_id)
SELECT
    md5('f150-cap-order-' || series.value::text)::uuid,
    'ORD-F150-CAP-' || series.value::text
FROM generate_series(1, 101) AS series(value);

INSERT INTO public.transaction_lines (
    id,
    transaction_id,
    fulfillment_order_id,
    product_id,
    fulfillment,
    quantity,
    unit_price,
    unit_cost,
    line_display_id,
    is_internal
)
SELECT
    md5('f150-cap-line-' || series.value::text)::uuid,
    'f1501000-0000-0000-0000-000000000003'::uuid,
    md5('f150-cap-order-' || series.value::text)::uuid,
    'f1504000-0000-0000-0000-000000000001'::uuid,
    'special_order',
    1,
    10.00,
    5.00,
    'LINE-F150-CAP-' || series.value::text,
    FALSE
FROM generate_series(1, 101) AS series(value);

DO $test$
BEGIN
    BEGIN
        UPDATE public.fulfillment_orders
        SET status = 'ready'
        WHERE display_id LIKE 'ORD-F150-CAP-%';
        RAISE EXCEPTION '101-order fulfillment statement was not rejected';
    EXCEPTION WHEN SQLSTATE '23514' THEN
        NULL;
    END;

    IF EXISTS (
        SELECT 1
        FROM public.fulfillment_orders
        WHERE display_id LIKE 'ORD-F150-CAP-%'
          AND status::text = 'ready'
    ) THEN
        RAISE EXCEPTION 'over-limit Fulfillment Order update did not roll back';
    END IF;
END
$test$;

-- The matching line-level hard cap is independent of Transaction scope.
DO $test$
BEGIN
    BEGIN
        UPDATE public.transaction_lines
        SET
            is_fulfilled = TRUE,
            fulfilled_at = CURRENT_TIMESTAMP
        WHERE line_display_id LIKE 'LINE-F150-CAP-%';
        RAISE EXCEPTION '101-line fulfillment statement was not rejected';
    EXCEPTION WHEN SQLSTATE '23514' THEN
        NULL;
    END;

    IF EXISTS (
        SELECT 1
        FROM public.transaction_lines
        WHERE line_display_id LIKE 'LINE-F150-CAP-%'
          AND (is_fulfilled OR fulfilled_at IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'over-limit Transaction Line update did not roll back';
    END IF;
END
$test$;

ROLLBACK;
\echo 'Migration 150 bulk fulfillment guard regression passed.'
