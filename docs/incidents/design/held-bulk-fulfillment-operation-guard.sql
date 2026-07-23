-- HELD DESIGN — NOT AN EXECUTABLE PRODUCTION MIGRATION.
--
-- This statement-level prototype is retained with its adversarial harness as
-- incident evidence. It must not enter the active migration sequence: repeated
-- one-row statements, fulfilled inserts/COPY, other recognition drivers, and
-- the database-owner trust boundary remain unresolved, while legitimate
-- Counterpoint, wedding, checkout, and exchange writers can be rejected.
--
-- Fail closed on multi-transaction fulfillment rewrites.
--
-- Ordinary pickup, shipping, checkout, and recalculation statements remain valid
-- because they change fulfillment state for at most one Transaction Record. Any
-- statement that changes more than one distinct Transaction Record must bind an
-- exact, immutable manifest with:
--
--   SET LOCAL riverside.bulk_fulfillment_operation_id = '<operation uuid>';
--
-- Trigger errors abort the statement and therefore roll back the surrounding
-- database transaction.

CREATE OR REPLACE FUNCTION public.ros_150_uuid_array_is_nonempty_unique(values_to_check UUID[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT values_to_check IS NOT NULL
       AND cardinality(values_to_check) > 0
       AND array_ndims(values_to_check) = 1
       AND array_position(values_to_check, NULL) IS NULL
       AND cardinality(values_to_check) = (
           SELECT COUNT(DISTINCT value)::integer
           FROM unnest(values_to_check) AS value
       )
$$;

CREATE TABLE IF NOT EXISTS public.bulk_fulfillment_operation_manifest (
    operation_id UUID PRIMARY KEY,
    correlation_id UUID NOT NULL UNIQUE,
    operation_kind TEXT NOT NULL,
    transaction_ids UUID[] NOT NULL,
    expected_transaction_count INTEGER NOT NULL,
    actor_staff_id UUID NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
    confirming_manager_staff_id UUID NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
    reason TEXT NOT NULL,
    manifest_digest TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT bulk_fulfillment_manifest_operation_correlation_uidx
        UNIQUE (operation_id, correlation_id),
    CONSTRAINT bulk_fulfillment_manifest_operation_kind_chk
        CHECK (
            operation_kind IN (
                'counterpoint_false_fulfillment_restore_open',
                'restore_pickup_recognition_evidence'
            )
        ),
    CONSTRAINT bulk_fulfillment_manifest_scope_nonempty_unique_chk
        CHECK (public.ros_150_uuid_array_is_nonempty_unique(transaction_ids)),
    CONSTRAINT bulk_fulfillment_manifest_expected_count_chk
        CHECK (
            expected_transaction_count BETWEEN 1 AND 100
            AND expected_transaction_count = cardinality(transaction_ids)
        ),
    CONSTRAINT bulk_fulfillment_manifest_reason_chk
        CHECK (length(btrim(reason)) BETWEEN 12 AND 2000),
    CONSTRAINT bulk_fulfillment_manifest_digest_chk
        CHECK (manifest_digest ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS public.bulk_fulfillment_operation_record (
    operation_id UUID NOT NULL
        REFERENCES public.bulk_fulfillment_operation_manifest(operation_id) ON DELETE RESTRICT,
    transaction_id UUID NOT NULL REFERENCES public.transactions(id) ON DELETE RESTRICT,
    manifest_ordinal INTEGER NOT NULL CHECK (manifest_ordinal > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (operation_id, transaction_id),
    CONSTRAINT bulk_fulfillment_operation_record_ordinal_uidx
        UNIQUE (operation_id, manifest_ordinal)
);

CREATE TABLE IF NOT EXISTS public.bulk_fulfillment_transition_event (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    statement_event_id UUID NOT NULL,
    operation_id UUID,
    correlation_id UUID,
    transaction_id UUID REFERENCES public.transactions(id) ON DELETE RESTRICT,
    source_table TEXT NOT NULL,
    source_record_id UUID NOT NULL,
    changed_transaction_count INTEGER NOT NULL CHECK (changed_transaction_count >= 0),
    before_state JSONB NOT NULL,
    after_state JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT bulk_fulfillment_transition_event_source_chk
        CHECK (source_table IN ('transactions', 'transaction_lines', 'fulfillment_orders')),
    CONSTRAINT bulk_fulfillment_transition_event_operation_pair_chk
        CHECK (
            (operation_id IS NULL AND correlation_id IS NULL)
            OR (operation_id IS NOT NULL AND correlation_id IS NOT NULL)
        ),
    CONSTRAINT bulk_fulfillment_transition_event_bulk_manifest_chk
        CHECK (changed_transaction_count <= 1 OR operation_id IS NOT NULL),
    CONSTRAINT bulk_fulfillment_transition_event_manifest_fk
        FOREIGN KEY (operation_id, correlation_id)
        REFERENCES public.bulk_fulfillment_operation_manifest(operation_id, correlation_id)
        ON DELETE RESTRICT,
    CONSTRAINT bulk_fulfillment_transition_event_record_fk
        FOREIGN KEY (operation_id, transaction_id)
        REFERENCES public.bulk_fulfillment_operation_record(operation_id, transaction_id)
        ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.bulk_fulfillment_operation_verification (
    verification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_id UUID NOT NULL
        REFERENCES public.bulk_fulfillment_operation_manifest(operation_id) ON DELETE RESTRICT,
    verified_by_staff_id UUID NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
    expected_transaction_count INTEGER NOT NULL
        CHECK (expected_transaction_count BETWEEN 1 AND 100),
    verified_transaction_count INTEGER NOT NULL CHECK (verified_transaction_count >= 0),
    overall_status TEXT NOT NULL,
    qbo_traceability TEXT NOT NULL,
    evidence_digest TEXT NOT NULL,
    summary JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT bulk_fulfillment_verification_identity_uidx
        UNIQUE (verification_id, operation_id),
    CONSTRAINT bulk_fulfillment_verification_count_chk
        CHECK (verified_transaction_count <= expected_transaction_count),
    CONSTRAINT bulk_fulfillment_verification_status_chk
        CHECK (overall_status IN ('verified', 'review_required', 'failed')),
    CONSTRAINT bulk_fulfillment_verification_qbo_traceability_chk
        CHECK (length(btrim(qbo_traceability)) BETWEEN 1 AND 4000),
    CONSTRAINT bulk_fulfillment_verification_digest_chk
        CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT bulk_fulfillment_verification_summary_chk
        CHECK (jsonb_typeof(summary) = 'object')
);

CREATE TABLE IF NOT EXISTS public.bulk_fulfillment_operation_verification_record (
    verification_id UUID NOT NULL,
    operation_id UUID NOT NULL,
    transaction_id UUID NOT NULL,
    verification_status TEXT NOT NULL,
    transaction_evidence JSONB NOT NULL,
    line_evidence JSONB NOT NULL,
    payment_evidence JSONB NOT NULL,
    inventory_evidence JSONB NOT NULL,
    revenue_evidence JSONB NOT NULL,
    commission_evidence JSONB NOT NULL,
    loyalty_evidence JSONB NOT NULL,
    audit_evidence JSONB NOT NULL,
    qbo_evidence JSONB NOT NULL,
    record_digest TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (verification_id, transaction_id),
    CONSTRAINT bulk_fulfillment_verification_record_status_chk
        CHECK (verification_status IN ('verified', 'review_required', 'failed')),
    CONSTRAINT bulk_fulfillment_verification_record_digest_chk
        CHECK (record_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT bulk_fulfillment_verification_record_summary_fk
        FOREIGN KEY (verification_id, operation_id)
        REFERENCES public.bulk_fulfillment_operation_verification(verification_id, operation_id)
        ON DELETE RESTRICT,
    CONSTRAINT bulk_fulfillment_verification_record_scope_fk
        FOREIGN KEY (operation_id, transaction_id)
        REFERENCES public.bulk_fulfillment_operation_record(operation_id, transaction_id)
        ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS bulk_fulfillment_operation_record_transaction_idx
    ON public.bulk_fulfillment_operation_record (transaction_id, operation_id);

CREATE INDEX IF NOT EXISTS bulk_fulfillment_transition_event_transaction_idx
    ON public.bulk_fulfillment_transition_event (transaction_id, created_at DESC);

CREATE INDEX IF NOT EXISTS bulk_fulfillment_transition_event_operation_idx
    ON public.bulk_fulfillment_transition_event (operation_id, created_at, id)
    WHERE operation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS bulk_fulfillment_verification_record_transaction_idx
    ON public.bulk_fulfillment_operation_verification_record
        (transaction_id, created_at DESC);

CREATE INDEX IF NOT EXISTS bulk_fulfillment_verification_operation_idx
    ON public.bulk_fulfillment_operation_verification
        (operation_id, created_at DESC, verification_id);

COMMENT ON TABLE public.bulk_fulfillment_operation_manifest IS
    'Immutable exact-scope authorization manifest required before one UPDATE statement may change fulfillment state across multiple Transaction Records.';

COMMENT ON COLUMN public.bulk_fulfillment_operation_manifest.manifest_digest IS
    'Lowercase SHA-256 supplied by the authorized service for the canonical operation, correlation, operation kind, scope, actor, manager, and reason payload.';

COMMENT ON TABLE public.bulk_fulfillment_operation_record IS
    'Immutable per-Transaction expansion of a bulk fulfillment manifest; foreign keys prove every declared Transaction Record existed when the manifest was inserted.';

COMMENT ON TABLE public.bulk_fulfillment_transition_event IS
    'Append-only before/after evidence emitted by statement-level fulfillment guards. Multi-Transaction events must reference the exact manifest and record scope.';

COMMENT ON TABLE public.bulk_fulfillment_operation_verification IS
    'Immutable post-operation verification summary. Deferred constraints require exact coverage of every Transaction Record declared by its manifest.';

COMMENT ON TABLE public.bulk_fulfillment_operation_verification_record IS
    'Immutable per-Transaction financial, inventory, revenue, commission, loyalty, audit, and QBO verification evidence for one bulk fulfillment operation.';

CREATE OR REPLACE FUNCTION public.ros_150_validate_bulk_fulfillment_record()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    declared_transaction_id UUID;
BEGIN
    SELECT manifest.transaction_ids[NEW.manifest_ordinal]
    INTO declared_transaction_id
    FROM public.bulk_fulfillment_operation_manifest manifest
    WHERE manifest.operation_id = NEW.operation_id;

    IF declared_transaction_id IS DISTINCT FROM NEW.transaction_id THEN
        RAISE EXCEPTION 'bulk fulfillment manifest record does not match its declared ordinal'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.ros_150_expand_bulk_fulfillment_manifest()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO public.bulk_fulfillment_operation_record (
        operation_id,
        transaction_id,
        manifest_ordinal
    )
    SELECT
        NEW.operation_id,
        declared.transaction_id,
        declared.ordinality::integer
    FROM unnest(NEW.transaction_ids) WITH ORDINALITY
        AS declared(transaction_id, ordinality);

    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS bulk_fulfillment_operation_record_validate_insert
    ON public.bulk_fulfillment_operation_record;
CREATE TRIGGER bulk_fulfillment_operation_record_validate_insert
BEFORE INSERT ON public.bulk_fulfillment_operation_record
FOR EACH ROW
EXECUTE FUNCTION public.ros_150_validate_bulk_fulfillment_record();

DROP TRIGGER IF EXISTS bulk_fulfillment_manifest_expand_records
    ON public.bulk_fulfillment_operation_manifest;
CREATE TRIGGER bulk_fulfillment_manifest_expand_records
AFTER INSERT ON public.bulk_fulfillment_operation_manifest
FOR EACH ROW
EXECUTE FUNCTION public.ros_150_expand_bulk_fulfillment_manifest();

CREATE OR REPLACE FUNCTION public.ros_150_reject_immutable_audit_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '% is immutable; append a new fulfillment operation instead', TG_TABLE_NAME
        USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS bulk_fulfillment_manifest_immutable
    ON public.bulk_fulfillment_operation_manifest;
CREATE TRIGGER bulk_fulfillment_manifest_immutable
BEFORE UPDATE OR DELETE ON public.bulk_fulfillment_operation_manifest
FOR EACH ROW
EXECUTE FUNCTION public.ros_150_reject_immutable_audit_change();

DROP TRIGGER IF EXISTS bulk_fulfillment_manifest_no_truncate
    ON public.bulk_fulfillment_operation_manifest;
CREATE TRIGGER bulk_fulfillment_manifest_no_truncate
BEFORE TRUNCATE ON public.bulk_fulfillment_operation_manifest
FOR EACH STATEMENT
EXECUTE FUNCTION public.ros_150_reject_immutable_audit_change();

DROP TRIGGER IF EXISTS bulk_fulfillment_operation_record_immutable
    ON public.bulk_fulfillment_operation_record;
CREATE TRIGGER bulk_fulfillment_operation_record_immutable
BEFORE UPDATE OR DELETE ON public.bulk_fulfillment_operation_record
FOR EACH ROW
EXECUTE FUNCTION public.ros_150_reject_immutable_audit_change();

DROP TRIGGER IF EXISTS bulk_fulfillment_operation_record_no_truncate
    ON public.bulk_fulfillment_operation_record;
CREATE TRIGGER bulk_fulfillment_operation_record_no_truncate
BEFORE TRUNCATE ON public.bulk_fulfillment_operation_record
FOR EACH STATEMENT
EXECUTE FUNCTION public.ros_150_reject_immutable_audit_change();

DROP TRIGGER IF EXISTS bulk_fulfillment_transition_event_immutable
    ON public.bulk_fulfillment_transition_event;
CREATE TRIGGER bulk_fulfillment_transition_event_immutable
BEFORE UPDATE OR DELETE ON public.bulk_fulfillment_transition_event
FOR EACH ROW
EXECUTE FUNCTION public.ros_150_reject_immutable_audit_change();

DROP TRIGGER IF EXISTS bulk_fulfillment_transition_event_no_truncate
    ON public.bulk_fulfillment_transition_event;
CREATE TRIGGER bulk_fulfillment_transition_event_no_truncate
BEFORE TRUNCATE ON public.bulk_fulfillment_transition_event
FOR EACH STATEMENT
EXECUTE FUNCTION public.ros_150_reject_immutable_audit_change();

DROP TRIGGER IF EXISTS bulk_fulfillment_verification_immutable
    ON public.bulk_fulfillment_operation_verification;
CREATE TRIGGER bulk_fulfillment_verification_immutable
BEFORE UPDATE OR DELETE ON public.bulk_fulfillment_operation_verification
FOR EACH ROW
EXECUTE FUNCTION public.ros_150_reject_immutable_audit_change();

DROP TRIGGER IF EXISTS bulk_fulfillment_verification_no_truncate
    ON public.bulk_fulfillment_operation_verification;
CREATE TRIGGER bulk_fulfillment_verification_no_truncate
BEFORE TRUNCATE ON public.bulk_fulfillment_operation_verification
FOR EACH STATEMENT
EXECUTE FUNCTION public.ros_150_reject_immutable_audit_change();

DROP TRIGGER IF EXISTS bulk_fulfillment_verification_record_immutable
    ON public.bulk_fulfillment_operation_verification_record;
CREATE TRIGGER bulk_fulfillment_verification_record_immutable
BEFORE UPDATE OR DELETE ON public.bulk_fulfillment_operation_verification_record
FOR EACH ROW
EXECUTE FUNCTION public.ros_150_reject_immutable_audit_change();

DROP TRIGGER IF EXISTS bulk_fulfillment_verification_record_no_truncate
    ON public.bulk_fulfillment_operation_verification_record;
CREATE TRIGGER bulk_fulfillment_verification_record_no_truncate
BEFORE TRUNCATE ON public.bulk_fulfillment_operation_verification_record
FOR EACH STATEMENT
EXECUTE FUNCTION public.ros_150_reject_immutable_audit_change();

CREATE OR REPLACE FUNCTION public.ros_150_validate_verification_completeness()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_verification_id UUID;
    v_expected_transaction_count INTEGER;
    v_manifest_transaction_count INTEGER;
    v_declared_verified_count INTEGER;
    v_overall_status TEXT;
    v_record_count BIGINT;
    v_verified_count BIGINT;
    v_review_required_count BIGINT;
    v_failed_count BIGINT;
BEGIN
    v_verification_id := NEW.verification_id;

    SELECT
        verification.expected_transaction_count,
        manifest.expected_transaction_count,
        verification.verified_transaction_count,
        verification.overall_status
    INTO
        v_expected_transaction_count,
        v_manifest_transaction_count,
        v_declared_verified_count,
        v_overall_status
    FROM public.bulk_fulfillment_operation_verification verification
    INNER JOIN public.bulk_fulfillment_operation_manifest manifest
        ON manifest.operation_id = verification.operation_id
    WHERE verification.verification_id = v_verification_id;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF v_expected_transaction_count <> v_manifest_transaction_count THEN
        RAISE EXCEPTION 'bulk fulfillment verification rejected: expected count does not match its immutable manifest'
            USING ERRCODE = '23514';
    END IF;

    SELECT
        COUNT(*),
        COUNT(*) FILTER (WHERE verification_status = 'verified'),
        COUNT(*) FILTER (WHERE verification_status = 'review_required'),
        COUNT(*) FILTER (WHERE verification_status = 'failed')
    INTO
        v_record_count,
        v_verified_count,
        v_review_required_count,
        v_failed_count
    FROM public.bulk_fulfillment_operation_verification_record record
    WHERE record.verification_id = v_verification_id;

    IF v_record_count <> v_expected_transaction_count THEN
        RAISE EXCEPTION 'bulk fulfillment verification rejected: evidence must cover every exact manifest Transaction Record'
            USING ERRCODE = '23514';
    END IF;

    IF v_declared_verified_count <> v_verified_count THEN
        RAISE EXCEPTION 'bulk fulfillment verification rejected: verified count does not match per-Transaction evidence'
            USING ERRCODE = '23514';
    END IF;

    IF v_overall_status = 'verified'
       AND (
           v_verified_count <> v_expected_transaction_count
           OR v_review_required_count <> 0
           OR v_failed_count <> 0
       ) THEN
        RAISE EXCEPTION 'bulk fulfillment verification rejected: verified status requires every Transaction Record to be verified'
            USING ERRCODE = '23514';
    END IF;

    IF v_overall_status = 'review_required'
       AND (v_review_required_count = 0 OR v_failed_count <> 0) THEN
        RAISE EXCEPTION 'bulk fulfillment verification rejected: review-required status must have review evidence and no failed record'
            USING ERRCODE = '23514';
    END IF;

    IF v_overall_status = 'failed' AND v_failed_count = 0 THEN
        RAISE EXCEPTION 'bulk fulfillment verification rejected: failed status requires at least one failed record'
            USING ERRCODE = '23514';
    END IF;

    RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS bulk_fulfillment_verification_completeness
    ON public.bulk_fulfillment_operation_verification;
CREATE CONSTRAINT TRIGGER bulk_fulfillment_verification_completeness
AFTER INSERT ON public.bulk_fulfillment_operation_verification
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.ros_150_validate_verification_completeness();

DROP TRIGGER IF EXISTS bulk_fulfillment_verification_record_completeness
    ON public.bulk_fulfillment_operation_verification_record;
CREATE CONSTRAINT TRIGGER bulk_fulfillment_verification_record_completeness
AFTER INSERT ON public.bulk_fulfillment_operation_verification_record
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.ros_150_validate_verification_completeness();

CREATE OR REPLACE FUNCTION public.ros_150_resolve_bulk_fulfillment_manifest(
    changed_transaction_ids UUID[]
)
RETURNS TABLE (
    resolved_operation_id UUID,
    resolved_correlation_id UUID
)
LANGUAGE plpgsql
AS $$
DECLARE
    normalized_transaction_ids UUID[];
    configured_operation_text TEXT;
    configured_operation_id UUID;
    active_operation_text TEXT;
    active_operation_id UUID;
BEGIN
    SELECT array_agg(scope.transaction_id ORDER BY scope.transaction_id)
    INTO normalized_transaction_ids
    FROM (
        SELECT DISTINCT transaction_id
        FROM unnest(changed_transaction_ids) AS transaction_id
        WHERE transaction_id IS NOT NULL
    ) AS scope;

    IF COALESCE(cardinality(normalized_transaction_ids), 0) = 0 THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID;
        RETURN;
    END IF;

    configured_operation_text := NULLIF(
        btrim(current_setting('riverside.bulk_fulfillment_operation_id', true)),
        ''
    );
    active_operation_text := NULLIF(
        btrim(current_setting(
            'riverside.active_bulk_fulfillment_operation_id',
            true
        )),
        ''
    );

    IF configured_operation_text IS NULL
       AND cardinality(normalized_transaction_ids) = 1 THEN
        IF active_operation_text IS NOT NULL THEN
            RAISE EXCEPTION 'fulfillment update rejected: an approved bulk operation cannot be cleared and followed by an unmanifested mutation in the same database transaction'
                USING ERRCODE = '23514';
        END IF;
        RETURN QUERY SELECT NULL::UUID, NULL::UUID;
        RETURN;
    END IF;

    IF configured_operation_text IS NULL THEN
        RAISE EXCEPTION 'bulk fulfillment update rejected: SET LOCAL riverside.bulk_fulfillment_operation_id to an exact approved manifest'
            USING ERRCODE = '23514';
    END IF;

    BEGIN
        configured_operation_id := configured_operation_text::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'bulk fulfillment update rejected: operation setting is not a UUID'
            USING ERRCODE = '23514';
    END;

    IF active_operation_text IS NULL THEN
        PERFORM set_config(
            'riverside.active_bulk_fulfillment_operation_id',
            configured_operation_id::text,
            true
        );
    ELSE
        BEGIN
            active_operation_id := active_operation_text::UUID;
        EXCEPTION WHEN invalid_text_representation THEN
            RAISE EXCEPTION 'bulk fulfillment update rejected: active operation guard is not a UUID'
                USING ERRCODE = '23514';
        END;
        IF active_operation_id IS DISTINCT FROM configured_operation_id THEN
            RAISE EXCEPTION 'bulk fulfillment update rejected: one database transaction cannot consume multiple approved fulfillment manifests'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(configured_operation_id::text, 150)
    );

    SELECT manifest.operation_id, manifest.correlation_id
    INTO resolved_operation_id, resolved_correlation_id
    FROM public.bulk_fulfillment_operation_manifest manifest
    WHERE manifest.operation_id = configured_operation_id
      AND manifest.expected_transaction_count = cardinality(normalized_transaction_ids)
      AND manifest.transaction_ids @> normalized_transaction_ids
      AND manifest.transaction_ids <@ normalized_transaction_ids
      AND (
          SELECT array_agg(record.transaction_id ORDER BY record.transaction_id)
          FROM public.bulk_fulfillment_operation_record record
          WHERE record.operation_id = manifest.operation_id
      ) = normalized_transaction_ids;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'bulk fulfillment update rejected: manifest scope does not exactly match the changed Transaction Records'
            USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.bulk_fulfillment_transition_event used
        WHERE used.operation_id = configured_operation_id
    ) THEN
        RAISE EXCEPTION 'bulk fulfillment update rejected: manifest has already been consumed by a fulfillment transition'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEXT;
END
$$;

CREATE OR REPLACE FUNCTION public.ros_150_guard_transaction_fulfillment_updates()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_changed_transaction_ids UUID[];
    v_changed_transaction_count INTEGER;
    v_resolved_operation_id UUID;
    v_resolved_correlation_id UUID;
    v_operation_kind TEXT;
    v_statement_event_id UUID := gen_random_uuid();
BEGIN
    SELECT
        array_agg(changed.transaction_id ORDER BY changed.transaction_id),
        COUNT(*)::integer
    INTO v_changed_transaction_ids, v_changed_transaction_count
    FROM (
        SELECT new_row.id AS transaction_id
        FROM old_fulfillment_rows old_row
        INNER JOIN new_fulfillment_rows new_row ON new_row.id = old_row.id
        WHERE old_row.status IS DISTINCT FROM new_row.status
           OR old_row.fulfilled_at IS DISTINCT FROM new_row.fulfilled_at
           OR old_row.fulfillment_method IS DISTINCT FROM new_row.fulfillment_method
    ) AS changed;

    IF COALESCE(v_changed_transaction_count, 0) = 0 THEN
        RETURN NULL;
    END IF;

    SELECT manifest.resolved_operation_id, manifest.resolved_correlation_id
    INTO v_resolved_operation_id, v_resolved_correlation_id
    FROM public.ros_150_resolve_bulk_fulfillment_manifest(v_changed_transaction_ids) manifest;

    IF v_resolved_operation_id IS NOT NULL THEN
        SELECT approved.operation_kind
        INTO v_operation_kind
        FROM public.bulk_fulfillment_operation_manifest approved
        WHERE approved.operation_id = v_resolved_operation_id;

        IF v_operation_kind = 'counterpoint_false_fulfillment_restore_open'
           AND EXISTS (
               SELECT 1
               FROM old_fulfillment_rows old_row
               INNER JOIN new_fulfillment_rows new_row ON new_row.id = old_row.id
               WHERE (
                   old_row.status IS DISTINCT FROM new_row.status
                   OR old_row.fulfilled_at IS DISTINCT FROM new_row.fulfilled_at
                   OR old_row.fulfillment_method IS DISTINCT FROM new_row.fulfillment_method
               )
               AND NOT (
                   old_row.status::text = 'fulfilled'
                   AND new_row.status::text = 'open'
                   AND old_row.fulfilled_at IS NOT NULL
                   AND new_row.fulfilled_at IS NULL
                   AND (
                       to_jsonb(old_row) - 'status' - 'fulfilled_at'
                   ) = (
                       to_jsonb(new_row) - 'status' - 'fulfilled_at'
                   )
               )
           ) THEN
            RAISE EXCEPTION 'bulk fulfillment update rejected: restore-open manifest does not authorize this before/after transition'
                USING ERRCODE = '23514';
        ELSIF v_operation_kind = 'restore_pickup_recognition_evidence'
           AND EXISTS (
               SELECT 1
               FROM old_fulfillment_rows old_row
               INNER JOIN new_fulfillment_rows new_row ON new_row.id = old_row.id
               WHERE (
                   old_row.status IS DISTINCT FROM new_row.status
                   OR old_row.fulfilled_at IS DISTINCT FROM new_row.fulfilled_at
                   OR old_row.fulfillment_method IS DISTINCT FROM new_row.fulfillment_method
               )
               AND NOT (
                   old_row.status::text = 'open'
                   AND old_row.fulfilled_at IS NULL
                   AND new_row.fulfilled_at IS NOT NULL
                   AND (
                       (new_row.balance_due = 0::numeric
                        AND new_row.status::text = 'fulfilled')
                       OR
                       (new_row.balance_due > 0::numeric
                        AND new_row.status::text = 'open')
                   )
                   AND (
                       to_jsonb(old_row) - 'status' - 'fulfilled_at'
                   ) = (
                       to_jsonb(new_row) - 'status' - 'fulfilled_at'
                   )
               )
           ) THEN
            RAISE EXCEPTION 'bulk fulfillment update rejected: pickup-recognition manifest does not authorize this before/after transition'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    INSERT INTO public.bulk_fulfillment_transition_event (
        statement_event_id,
        operation_id,
        correlation_id,
        transaction_id,
        source_table,
        source_record_id,
        changed_transaction_count,
        before_state,
        after_state
    )
    SELECT
        v_statement_event_id,
        v_resolved_operation_id,
        v_resolved_correlation_id,
        new_row.id,
        'transactions',
        new_row.id,
        v_changed_transaction_count,
        jsonb_build_object(
            'status', old_row.status::text,
            'fulfilled_at', old_row.fulfilled_at,
            'fulfillment_method', old_row.fulfillment_method::text
        ),
        jsonb_build_object(
            'status', new_row.status::text,
            'fulfilled_at', new_row.fulfilled_at,
            'fulfillment_method', new_row.fulfillment_method::text
        )
    FROM old_fulfillment_rows old_row
    INNER JOIN new_fulfillment_rows new_row ON new_row.id = old_row.id
    WHERE old_row.status IS DISTINCT FROM new_row.status
       OR old_row.fulfilled_at IS DISTINCT FROM new_row.fulfilled_at
       OR old_row.fulfillment_method IS DISTINCT FROM new_row.fulfillment_method;

    RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION public.ros_150_guard_transaction_line_fulfillment_updates()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_changed_transaction_ids UUID[];
    v_changed_transaction_count INTEGER;
    v_changed_line_count INTEGER;
    v_resolved_operation_id UUID;
    v_resolved_correlation_id UUID;
    v_statement_event_id UUID := gen_random_uuid();
BEGIN
    SELECT COUNT(*)::integer
    INTO v_changed_line_count
    FROM old_fulfillment_rows old_row
    INNER JOIN new_fulfillment_rows new_row ON new_row.id = old_row.id
    WHERE old_row.is_fulfilled IS DISTINCT FROM new_row.is_fulfilled
       OR old_row.transaction_id IS DISTINCT FROM new_row.transaction_id
       OR old_row.fulfillment IS DISTINCT FROM new_row.fulfillment
       OR old_row.is_internal IS DISTINCT FROM new_row.is_internal
       OR old_row.fulfillment_order_id IS DISTINCT FROM new_row.fulfillment_order_id
       OR old_row.fulfilled_at IS DISTINCT FROM new_row.fulfilled_at
       OR old_row.order_lifecycle_status IS DISTINCT FROM new_row.order_lifecycle_status
       OR old_row.ready_for_pickup_at IS DISTINCT FROM new_row.ready_for_pickup_at
       OR old_row.ready_for_pickup_by IS DISTINCT FROM new_row.ready_for_pickup_by
       OR old_row.picked_up_at IS DISTINCT FROM new_row.picked_up_at
       OR old_row.picked_up_by IS DISTINCT FROM new_row.picked_up_by
       OR old_row.shipped_at IS DISTINCT FROM new_row.shipped_at
       OR old_row.shipped_by IS DISTINCT FROM new_row.shipped_by
       OR old_row.shipment_id IS DISTINCT FROM new_row.shipment_id;

    IF v_changed_line_count > 100 THEN
        RAISE EXCEPTION 'Transaction Line fulfillment update rejected: one statement cannot change more than 100 lines'
            USING ERRCODE = '23514';
    END IF;

    SELECT
        array_agg(scope.transaction_id ORDER BY scope.transaction_id),
        COUNT(*)::integer
    INTO v_changed_transaction_ids, v_changed_transaction_count
    FROM (
        SELECT old_row.transaction_id
        FROM old_fulfillment_rows old_row
        INNER JOIN new_fulfillment_rows new_row ON new_row.id = old_row.id
        WHERE old_row.is_fulfilled IS DISTINCT FROM new_row.is_fulfilled
           OR old_row.transaction_id IS DISTINCT FROM new_row.transaction_id
           OR old_row.fulfillment IS DISTINCT FROM new_row.fulfillment
           OR old_row.is_internal IS DISTINCT FROM new_row.is_internal
           OR old_row.fulfillment_order_id IS DISTINCT FROM new_row.fulfillment_order_id
           OR old_row.fulfilled_at IS DISTINCT FROM new_row.fulfilled_at
           OR old_row.order_lifecycle_status IS DISTINCT FROM new_row.order_lifecycle_status
           OR old_row.ready_for_pickup_at IS DISTINCT FROM new_row.ready_for_pickup_at
           OR old_row.ready_for_pickup_by IS DISTINCT FROM new_row.ready_for_pickup_by
           OR old_row.picked_up_at IS DISTINCT FROM new_row.picked_up_at
           OR old_row.picked_up_by IS DISTINCT FROM new_row.picked_up_by
           OR old_row.shipped_at IS DISTINCT FROM new_row.shipped_at
           OR old_row.shipped_by IS DISTINCT FROM new_row.shipped_by
           OR old_row.shipment_id IS DISTINCT FROM new_row.shipment_id
        UNION
        SELECT new_row.transaction_id
        FROM old_fulfillment_rows old_row
        INNER JOIN new_fulfillment_rows new_row ON new_row.id = old_row.id
        WHERE old_row.is_fulfilled IS DISTINCT FROM new_row.is_fulfilled
           OR old_row.transaction_id IS DISTINCT FROM new_row.transaction_id
           OR old_row.fulfillment IS DISTINCT FROM new_row.fulfillment
           OR old_row.is_internal IS DISTINCT FROM new_row.is_internal
           OR old_row.fulfillment_order_id IS DISTINCT FROM new_row.fulfillment_order_id
           OR old_row.fulfilled_at IS DISTINCT FROM new_row.fulfilled_at
           OR old_row.order_lifecycle_status IS DISTINCT FROM new_row.order_lifecycle_status
           OR old_row.ready_for_pickup_at IS DISTINCT FROM new_row.ready_for_pickup_at
           OR old_row.ready_for_pickup_by IS DISTINCT FROM new_row.ready_for_pickup_by
           OR old_row.picked_up_at IS DISTINCT FROM new_row.picked_up_at
           OR old_row.picked_up_by IS DISTINCT FROM new_row.picked_up_by
           OR old_row.shipped_at IS DISTINCT FROM new_row.shipped_at
           OR old_row.shipped_by IS DISTINCT FROM new_row.shipped_by
           OR old_row.shipment_id IS DISTINCT FROM new_row.shipment_id
    ) AS scope
    WHERE scope.transaction_id IS NOT NULL;

    IF COALESCE(v_changed_transaction_count, 0) = 0 THEN
        RETURN NULL;
    END IF;

    SELECT manifest.resolved_operation_id, manifest.resolved_correlation_id
    INTO v_resolved_operation_id, v_resolved_correlation_id
    FROM public.ros_150_resolve_bulk_fulfillment_manifest(v_changed_transaction_ids) manifest;

    IF v_resolved_operation_id IS NOT NULL THEN
        RAISE EXCEPTION 'bulk fulfillment update rejected: recovery manifests authorize Transaction Record header transitions only'
            USING ERRCODE = '23514';
    END IF;

    INSERT INTO public.bulk_fulfillment_transition_event (
        statement_event_id,
        operation_id,
        correlation_id,
        transaction_id,
        source_table,
        source_record_id,
        changed_transaction_count,
        before_state,
        after_state
    )
    SELECT
        v_statement_event_id,
        v_resolved_operation_id,
        v_resolved_correlation_id,
        COALESCE(new_row.transaction_id, old_row.transaction_id),
        'transaction_lines',
        new_row.id,
        v_changed_transaction_count,
        jsonb_build_object(
            'transaction_id', old_row.transaction_id,
            'fulfillment', old_row.fulfillment::text,
            'is_internal', old_row.is_internal,
            'fulfillment_order_id', old_row.fulfillment_order_id,
            'is_fulfilled', old_row.is_fulfilled,
            'fulfilled_at', old_row.fulfilled_at,
            'order_lifecycle_status', old_row.order_lifecycle_status::text,
            'ready_for_pickup_at', old_row.ready_for_pickup_at,
            'ready_for_pickup_by', old_row.ready_for_pickup_by,
            'picked_up_at', old_row.picked_up_at,
            'picked_up_by', old_row.picked_up_by,
            'shipped_at', old_row.shipped_at,
            'shipped_by', old_row.shipped_by,
            'shipment_id', old_row.shipment_id
        ),
        jsonb_build_object(
            'transaction_id', new_row.transaction_id,
            'fulfillment', new_row.fulfillment::text,
            'is_internal', new_row.is_internal,
            'fulfillment_order_id', new_row.fulfillment_order_id,
            'is_fulfilled', new_row.is_fulfilled,
            'fulfilled_at', new_row.fulfilled_at,
            'order_lifecycle_status', new_row.order_lifecycle_status::text,
            'ready_for_pickup_at', new_row.ready_for_pickup_at,
            'ready_for_pickup_by', new_row.ready_for_pickup_by,
            'picked_up_at', new_row.picked_up_at,
            'picked_up_by', new_row.picked_up_by,
            'shipped_at', new_row.shipped_at,
            'shipped_by', new_row.shipped_by,
            'shipment_id', new_row.shipment_id
        )
    FROM old_fulfillment_rows old_row
    INNER JOIN new_fulfillment_rows new_row ON new_row.id = old_row.id
    WHERE old_row.is_fulfilled IS DISTINCT FROM new_row.is_fulfilled
       OR old_row.transaction_id IS DISTINCT FROM new_row.transaction_id
       OR old_row.fulfillment IS DISTINCT FROM new_row.fulfillment
       OR old_row.is_internal IS DISTINCT FROM new_row.is_internal
       OR old_row.fulfillment_order_id IS DISTINCT FROM new_row.fulfillment_order_id
       OR old_row.fulfilled_at IS DISTINCT FROM new_row.fulfilled_at
       OR old_row.order_lifecycle_status IS DISTINCT FROM new_row.order_lifecycle_status
       OR old_row.ready_for_pickup_at IS DISTINCT FROM new_row.ready_for_pickup_at
       OR old_row.ready_for_pickup_by IS DISTINCT FROM new_row.ready_for_pickup_by
       OR old_row.picked_up_at IS DISTINCT FROM new_row.picked_up_at
       OR old_row.picked_up_by IS DISTINCT FROM new_row.picked_up_by
       OR old_row.shipped_at IS DISTINCT FROM new_row.shipped_at
       OR old_row.shipped_by IS DISTINCT FROM new_row.shipped_by
       OR old_row.shipment_id IS DISTINCT FROM new_row.shipment_id;

    RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION public.ros_150_guard_fulfillment_order_updates()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_changed_transaction_ids UUID[];
    v_changed_transaction_count INTEGER;
    v_changed_order_count INTEGER;
    v_unmapped_order_count INTEGER;
    v_resolved_operation_id UUID;
    v_resolved_correlation_id UUID;
    v_statement_event_id UUID := gen_random_uuid();
BEGIN
    WITH changed_orders AS (
        SELECT new_row.id
        FROM old_fulfillment_rows old_row
        INNER JOIN new_fulfillment_rows new_row ON new_row.id = old_row.id
        WHERE old_row.status IS DISTINCT FROM new_row.status
           OR old_row.fulfilled_at IS DISTINCT FROM new_row.fulfilled_at
    ), mapped_scope AS (
        SELECT DISTINCT changed.id AS fulfillment_order_id, line.transaction_id
        FROM changed_orders changed
        INNER JOIN public.transaction_lines line
            ON line.fulfillment_order_id = changed.id
        WHERE line.transaction_id IS NOT NULL
    )
    SELECT
        (SELECT COUNT(*)::integer FROM changed_orders),
        (
            SELECT COUNT(*)::integer
            FROM changed_orders changed
            WHERE NOT EXISTS (
                SELECT 1
                FROM mapped_scope mapped
                WHERE mapped.fulfillment_order_id = changed.id
            )
        ),
        (
            SELECT array_agg(DISTINCT mapped.transaction_id ORDER BY mapped.transaction_id)
            FROM mapped_scope mapped
        ),
        (
            SELECT COUNT(DISTINCT mapped.transaction_id)::integer
            FROM mapped_scope mapped
        )
    INTO
        v_changed_order_count,
        v_unmapped_order_count,
        v_changed_transaction_ids,
        v_changed_transaction_count;

    IF COALESCE(v_changed_order_count, 0) = 0 THEN
        RETURN NULL;
    END IF;

    IF COALESCE(v_unmapped_order_count, 0) > 0 THEN
        RAISE EXCEPTION 'fulfillment order update rejected: every changed Fulfillment Order must map to a Transaction Record'
            USING ERRCODE = '23514';
    END IF;

    IF v_changed_order_count > 100 THEN
        RAISE EXCEPTION 'fulfillment order update rejected: one statement cannot change more than 100 Fulfillment Orders'
            USING ERRCODE = '23514';
    END IF;

    IF COALESCE(v_changed_transaction_count, 0) > 0 THEN
        SELECT manifest.resolved_operation_id, manifest.resolved_correlation_id
        INTO v_resolved_operation_id, v_resolved_correlation_id
        FROM public.ros_150_resolve_bulk_fulfillment_manifest(v_changed_transaction_ids) manifest;

        IF v_resolved_operation_id IS NOT NULL THEN
            RAISE EXCEPTION 'bulk fulfillment update rejected: recovery manifests authorize Transaction Record header transitions only'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    WITH changed_orders AS (
        SELECT
            old_row.id,
            old_row.status AS old_status,
            new_row.status AS new_status,
            old_row.fulfilled_at AS old_fulfilled_at,
            new_row.fulfilled_at AS new_fulfilled_at
        FROM old_fulfillment_rows old_row
        INNER JOIN new_fulfillment_rows new_row ON new_row.id = old_row.id
        WHERE old_row.status IS DISTINCT FROM new_row.status
           OR old_row.fulfilled_at IS DISTINCT FROM new_row.fulfilled_at
    ), mapped AS (
        SELECT DISTINCT
            changed.*,
            line.transaction_id
        FROM changed_orders changed
        INNER JOIN public.transaction_lines line
            ON line.fulfillment_order_id = changed.id
        WHERE line.transaction_id IS NOT NULL
    )
    INSERT INTO public.bulk_fulfillment_transition_event (
        statement_event_id,
        operation_id,
        correlation_id,
        transaction_id,
        source_table,
        source_record_id,
        changed_transaction_count,
        before_state,
        after_state
    )
    SELECT
        v_statement_event_id,
        v_resolved_operation_id,
        v_resolved_correlation_id,
        mapped.transaction_id,
        'fulfillment_orders',
        mapped.id,
        COALESCE(v_changed_transaction_count, 0),
        jsonb_build_object(
            'status', mapped.old_status,
            'fulfilled_at', mapped.old_fulfilled_at
        ),
        jsonb_build_object(
            'status', mapped.new_status,
            'fulfilled_at', mapped.new_fulfilled_at
        )
    FROM mapped;

    RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS transactions_bulk_fulfillment_guard
    ON public.transactions;
CREATE TRIGGER transactions_bulk_fulfillment_guard
AFTER UPDATE ON public.transactions
REFERENCING OLD TABLE AS old_fulfillment_rows NEW TABLE AS new_fulfillment_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.ros_150_guard_transaction_fulfillment_updates();

DROP TRIGGER IF EXISTS transaction_lines_bulk_fulfillment_guard
    ON public.transaction_lines;
CREATE TRIGGER transaction_lines_bulk_fulfillment_guard
AFTER UPDATE ON public.transaction_lines
REFERENCING OLD TABLE AS old_fulfillment_rows NEW TABLE AS new_fulfillment_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.ros_150_guard_transaction_line_fulfillment_updates();

DROP TRIGGER IF EXISTS fulfillment_orders_bulk_fulfillment_guard
    ON public.fulfillment_orders;
CREATE TRIGGER fulfillment_orders_bulk_fulfillment_guard
AFTER UPDATE ON public.fulfillment_orders
REFERENCING OLD TABLE AS old_fulfillment_rows NEW TABLE AS new_fulfillment_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.ros_150_guard_fulfillment_order_updates();
