-- Counterpoint financial-integrity evidence and a review-first booking-date repair path.
--
-- This migration is intentionally non-destructive: it does not rewrite imported
-- transactions, lines, booking events, or tender rows. The reporting views are
-- the dry-run manifest. Reviewed repairs are applied later through the
-- staff-gated service, which records an immutable before/after audit row.

CREATE TABLE IF NOT EXISTS public.counterpoint_booking_date_repair_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    manifest_key TEXT NOT NULL UNIQUE,
    transaction_id UUID NOT NULL REFERENCES public.transactions(id) ON DELETE RESTRICT,
    repaired_by_staff_id UUID NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
    reason TEXT NOT NULL,
    review_manifest_digest TEXT NOT NULL,
    review_manifest_candidate_count INTEGER NOT NULL CHECK (review_manifest_candidate_count >= 0),
    line_rows_updated INTEGER NOT NULL DEFAULT 0 CHECK (line_rows_updated >= 0),
    booking_events_updated INTEGER NOT NULL DEFAULT 0 CHECK (booking_events_updated >= 0),
    source_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    result_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT counterpoint_booking_date_repair_reason_required
        CHECK (length(btrim(reason)) >= 12)
);

ALTER TABLE public.counterpoint_booking_date_repair_audit
    ADD COLUMN IF NOT EXISTS review_manifest_digest TEXT,
    ADD COLUMN IF NOT EXISTS review_manifest_candidate_count INTEGER;

UPDATE public.counterpoint_booking_date_repair_audit
SET review_manifest_digest = COALESCE(review_manifest_digest, 'legacy-unbound'),
    review_manifest_candidate_count = COALESCE(review_manifest_candidate_count, 0)
WHERE review_manifest_digest IS NULL
   OR review_manifest_candidate_count IS NULL;

ALTER TABLE public.counterpoint_booking_date_repair_audit
    ALTER COLUMN review_manifest_digest SET NOT NULL,
    ALTER COLUMN review_manifest_candidate_count SET NOT NULL;

ALTER TABLE public.counterpoint_transaction_reconciliation
    ADD COLUMN IF NOT EXISTS review_manifest_digest TEXT;

COMMENT ON COLUMN public.counterpoint_transaction_reconciliation.review_manifest_digest IS
    'SHA-256 of the exact reviewed candidate, line, transaction, and payment manifest applied by the reconciliation.';

CREATE INDEX IF NOT EXISTS idx_counterpoint_booking_date_repair_audit_transaction
    ON public.counterpoint_booking_date_repair_audit (transaction_id, created_at DESC);

COMMENT ON TABLE public.counterpoint_booking_date_repair_audit IS
    'Append-only evidence for reviewed Counterpoint booking timestamp repairs. Tender and transaction financial amounts are snapshot-only and are never changed by this repair.';

DROP VIEW IF EXISTS reporting.counterpoint_booking_date_repair_manifest;
DROP VIEW IF EXISTS reporting.counterpoint_import_financial_integrity;

CREATE OR REPLACE VIEW reporting.counterpoint_import_financial_integrity AS
WITH returned_quantity AS (
    SELECT
        transaction_line_id,
        COUNT(*)::bigint AS return_event_count,
        COALESCE(SUM(quantity_returned), 0)::integer AS quantity_returned
    FROM public.transaction_return_lines
    GROUP BY transaction_line_id
),
line_rollup AS (
    SELECT
        tl.transaction_id,
        COUNT(*)::bigint AS line_count,
        COALESCE(SUM(rq.return_event_count), 0)::bigint AS return_event_count,
        ROUND(COALESCE(SUM(
            GREATEST(tl.quantity - COALESCE(rq.quantity_returned, 0), 0)::numeric
                * tl.unit_price
        ), 0), 2)::numeric(14, 2)
            AS line_subtotal,
        ROUND(COALESCE(SUM(
            GREATEST(tl.quantity - COALESCE(rq.quantity_returned, 0), 0)::numeric
                * (COALESCE(tl.state_tax, 0) + COALESCE(tl.local_tax, 0))
        ), 0), 2)::numeric(14, 2) AS line_tax,
        COUNT(*) FILTER (
            WHERE tl.booked_at IS DISTINCT FROM t.booked_at
        )::bigint AS line_booked_at_mismatch_count
    FROM public.transaction_lines tl
    INNER JOIN public.transactions t ON t.id = tl.transaction_id
    LEFT JOIN returned_quantity rq ON rq.transaction_line_id = tl.id
    WHERE COALESCE(t.is_counterpoint_import, FALSE)
    GROUP BY tl.transaction_id
),
allocation_rollup AS (
    SELECT
        pa.target_transaction_id AS transaction_id,
        COUNT(*)::bigint AS allocation_count,
        COUNT(*) FILTER (
            WHERE pa.amount_allocated < 0
               OR COALESCE(pt.metadata->>'kind', '') IN (
                   'order_refund', 'exchange_refund_remainder'
               )
        )::bigint AS refund_allocation_count,
        ROUND(COALESCE(SUM(pa.amount_allocated), 0), 2)::numeric(14, 2)
            AS allocated_tender_total
    FROM public.payment_allocations pa
    INNER JOIN public.payment_transactions pt ON pt.id = pa.transaction_id
    INNER JOIN public.transactions t ON t.id = pa.target_transaction_id
    WHERE COALESCE(t.is_counterpoint_import, FALSE)
    GROUP BY pa.target_transaction_id
),
booking_event_rollup AS (
    SELECT
        e.transaction_id,
        COUNT(*)::bigint AS booking_event_count,
        COUNT(*) FILTER (
            WHERE e.event_kind = 'initial_booking'
              AND e.transaction_line_id IS NOT NULL
              AND e.booked_at IS DISTINCT FROM t.booked_at
        )::bigint AS booking_event_time_mismatch_count,
        COUNT(*) FILTER (
            WHERE e.event_kind = 'initial_booking'
              AND e.transaction_line_id IS NULL
              AND COALESCE(e.metadata->>'reporting_exclusion_reason', '')
                    <> 'counterpoint_reimport_superseded'
        )::bigint AS orphaned_initial_booking_event_count,
        COUNT(*) FILTER (
            WHERE e.event_kind IN ('line_amendment', 'line_deleted')
              AND COALESCE(e.metadata->>'reporting_excluded', '') = ''
        )::bigint AS unreviewed_adjustment_event_count
    FROM public.transaction_line_booking_events e
    INNER JOIN public.transactions t ON t.id = e.transaction_id
    WHERE COALESCE(t.is_counterpoint_import, FALSE)
    GROUP BY e.transaction_id
),
activity_rollup AS (
    SELECT
        transaction_id,
        COUNT(*)::bigint AS activity_event_count,
        COUNT(*) FILTER (
            WHERE event_kind IN ('counterpoint_import', 'counterpoint_import_evidence')
        )::bigint AS counterpoint_import_event_count,
        COUNT(*) FILTER (
            WHERE event_kind NOT IN ('counterpoint_import', 'counterpoint_import_evidence')
        )::bigint AS post_import_activity_event_count
    FROM public.transaction_activity_log
    GROUP BY transaction_id
),
immutable_import_evidence AS (
    SELECT DISTINCT ON (transaction_id)
        transaction_id,
        metadata->'financial_evidence' AS financial_evidence,
        created_at AS evidence_recorded_at
    FROM public.transaction_activity_log
    WHERE event_kind IN ('counterpoint_import', 'counterpoint_import_evidence')
      AND jsonb_typeof(metadata->'financial_evidence') = 'object'
    ORDER BY transaction_id, created_at DESC, id DESC
),
source_rows AS (
    SELECT
        t.*,
        COALESCE(
            immutable.financial_evidence,
            t.metadata #> '{counterpoint_financial_evidence}'
        ) AS import_financial_snapshot,
        immutable.financial_evidence IS NOT NULL AS import_snapshot_is_immutable,
        immutable.evidence_recorded_at
    FROM public.transactions t
    LEFT JOIN immutable_import_evidence immutable ON immutable.transaction_id = t.id
    WHERE COALESCE(t.is_counterpoint_import, FALSE)
),
evidence AS (
    SELECT
        t.id AS transaction_id,
        COALESCE(t.display_id, t.counterpoint_doc_ref, t.counterpoint_ticket_ref, t.id::text)
            AS display_id,
        t.counterpoint_ticket_ref,
        t.counterpoint_doc_ref,
        t.booked_at,
        t.created_at AS imported_at,
        ROUND(COALESCE(t.total_price, 0), 2)::numeric(14, 2) AS header_total,
        ROUND(COALESCE(t.amount_paid, 0), 2)::numeric(14, 2) AS stored_amount_paid,
        COALESCE(jsonb_typeof(t.import_financial_snapshot) = 'object', FALSE)
            AS source_financial_evidence_present,
        t.import_snapshot_is_immutable AS source_financial_evidence_immutable,
        t.evidence_recorded_at,
        CASE
            WHEN jsonb_typeof(t.import_financial_snapshot->'review_codes') = 'array'
            THEN ARRAY(
                SELECT jsonb_array_elements_text(t.import_financial_snapshot->'review_codes')
            )
            ELSE ARRAY[]::text[]
        END AS import_snapshot_review_codes,
        CASE
            WHEN COALESCE(t.import_financial_snapshot->>'imported_header_total', '')
                ~ '^-?[0-9]+([.][0-9]+)?$'
            THEN ROUND((t.import_financial_snapshot->>'imported_header_total')::numeric, 2)
                ::numeric(14, 2)
        END AS import_snapshot_header_total,
        CASE
            WHEN COALESCE(t.import_financial_snapshot->>'imported_line_total', '')
                ~ '^-?[0-9]+([.][0-9]+)?$'
            THEN ROUND((t.import_financial_snapshot->>'imported_line_total')::numeric, 2)
                ::numeric(14, 2)
        END AS import_snapshot_line_total,
        CASE
            WHEN COALESCE(t.import_financial_snapshot->>'source_tender_total', '')
                ~ '^-?[0-9]+([.][0-9]+)?$'
            THEN ROUND((t.import_financial_snapshot->>'source_tender_total')::numeric, 2)
                ::numeric(14, 2)
        END AS import_snapshot_tender_total,
        CASE
            WHEN COALESCE(
                t.import_financial_snapshot->>'source_header_line_delta', ''
            ) ~ '^-?[0-9]+([.][0-9]+)?$'
            THEN ROUND((t.import_financial_snapshot->>'source_header_line_delta')::numeric, 2)
                ::numeric(14, 2)
        END AS source_header_line_delta,
        CASE
            WHEN COALESCE(
                t.import_financial_snapshot->>'source_tender_line_delta', ''
            ) ~ '^-?[0-9]+([.][0-9]+)?$'
            THEN ROUND((t.import_financial_snapshot->>'source_tender_line_delta')::numeric, 2)
                ::numeric(14, 2)
        END AS source_tender_line_delta,
        CASE
            WHEN COALESCE(
                t.import_financial_snapshot->>'source_header_tender_delta', ''
            ) ~ '^-?[0-9]+([.][0-9]+)?$'
            THEN ROUND((t.import_financial_snapshot->>'source_header_tender_delta')::numeric, 2)
                ::numeric(14, 2)
        END AS source_header_tender_delta,
        CASE
            WHEN COALESCE(
                t.import_financial_snapshot->>'source_amount_paid_tender_delta', ''
            ) ~ '^-?[0-9]+([.][0-9]+)?$'
            THEN ROUND((t.import_financial_snapshot->>'source_amount_paid_tender_delta')::numeric, 2)
                ::numeric(14, 2)
        END AS source_amount_paid_tender_delta,
        CASE
            WHEN jsonb_typeof(t.import_financial_snapshot->'source_tender_rows_present') = 'boolean'
            THEN (t.import_financial_snapshot->>'source_tender_rows_present')::boolean
        END AS source_tender_rows_present,
        COALESCE(l.line_count, 0)::bigint AS line_count,
        COALESCE(l.return_event_count, 0)::bigint AS return_event_count,
        COALESCE(l.line_subtotal, 0)::numeric(14, 2) AS line_subtotal,
        COALESCE(l.line_tax, 0)::numeric(14, 2) AS line_tax,
        ROUND(COALESCE(l.line_subtotal, 0) + COALESCE(l.line_tax, 0), 2)::numeric(14, 2)
            AS line_total,
        COALESCE(a.allocation_count, 0)::bigint AS allocation_count,
        COALESCE(a.refund_allocation_count, 0)::bigint AS refund_allocation_count,
        COALESCE(a.allocated_tender_total, 0)::numeric(14, 2) AS allocated_tender_total,
        ROUND(COALESCE(t.total_price, 0) - (
            COALESCE(l.line_subtotal, 0) + COALESCE(l.line_tax, 0)
        ), 2)::numeric(14, 2) AS header_line_delta,
        ROUND(COALESCE(t.amount_paid, 0) - COALESCE(a.allocated_tender_total, 0), 2)::numeric(14, 2)
            AS stored_paid_allocation_delta,
        ROUND(COALESCE(a.allocated_tender_total, 0) - (
            COALESCE(l.line_subtotal, 0) + COALESCE(l.line_tax, 0)
        ), 2)::numeric(14, 2) AS allocation_line_delta,
        COALESCE(l.line_booked_at_mismatch_count, 0)::bigint AS line_booked_at_mismatch_count,
        COALESCE(b.booking_event_count, 0)::bigint AS booking_event_count,
        COALESCE(b.booking_event_time_mismatch_count, 0)::bigint
            AS booking_event_time_mismatch_count,
        COALESCE(b.orphaned_initial_booking_event_count, 0)::bigint
            AS orphaned_initial_booking_event_count,
        COALESCE(b.unreviewed_adjustment_event_count, 0)::bigint
            AS unreviewed_adjustment_event_count,
        COALESCE(al.activity_event_count, 0)::bigint AS activity_event_count,
        COALESCE(al.counterpoint_import_event_count, 0)::bigint
            AS counterpoint_import_event_count,
        COALESCE(al.post_import_activity_event_count, 0)::bigint
            AS post_import_activity_event_count
    FROM source_rows t
    LEFT JOIN line_rollup l ON l.transaction_id = t.id
    LEFT JOIN allocation_rollup a ON a.transaction_id = t.id
    LEFT JOIN booking_event_rollup b ON b.transaction_id = t.id
    LEFT JOIN activity_rollup al ON al.transaction_id = t.id
),
classified AS (
    SELECT
        evidence.*,
        (
            return_event_count > 0
            OR refund_allocation_count > 0
            OR post_import_activity_event_count > 0
        ) AS has_post_import_activity,
        CASE
            WHEN import_snapshot_header_total IS NOT NULL
            THEN ROUND(header_total - import_snapshot_header_total, 2)::numeric(14, 2)
        END AS current_header_snapshot_delta,
        CASE
            WHEN import_snapshot_tender_total IS NOT NULL
            THEN ROUND(stored_amount_paid - import_snapshot_tender_total, 2)::numeric(14, 2)
        END AS current_paid_snapshot_delta,
        CASE
            WHEN import_snapshot_tender_total IS NOT NULL
            THEN ROUND(allocated_tender_total - import_snapshot_tender_total, 2)::numeric(14, 2)
        END AS current_allocation_snapshot_delta
    FROM evidence
),
state_classified AS (
    SELECT
        classified.*,
        (
            ABS(COALESCE(current_header_snapshot_delta, 0)) > 0.01
            OR ABS(COALESCE(current_paid_snapshot_delta, 0)) > 0.01
            OR ABS(COALESCE(current_allocation_snapshot_delta, 0)) > 0.01
        ) AS current_state_differs_from_import
    FROM classified
)
SELECT
    state_classified.*,
    import_snapshot_review_codes || ARRAY_REMOVE(ARRAY[
        CASE
            WHEN NOT source_financial_evidence_present
            THEN 'missing_counterpoint_financial_snapshot'
        END,
        CASE
            WHEN source_financial_evidence_present
             AND NOT source_financial_evidence_immutable
            THEN 'financial_snapshot_not_in_immutable_activity'
        END,
        CASE
            WHEN source_financial_evidence_present
             AND NOT has_post_import_activity
             AND current_state_differs_from_import
            THEN 'current_net_changed_without_post_import_evidence'
        END,
        CASE WHEN line_booked_at_mismatch_count > 0 THEN 'line_booked_at_mismatch' END,
        CASE WHEN booking_event_time_mismatch_count > 0 THEN 'booking_event_time_mismatch' END,
        CASE WHEN orphaned_initial_booking_event_count > 0 THEN 'orphaned_initial_booking_event' END,
        CASE WHEN unreviewed_adjustment_event_count > 0 THEN 'unreviewed_booking_adjustment' END,
        CASE WHEN counterpoint_import_event_count = 0 THEN 'missing_counterpoint_import_evidence' END
    ], NULL)::text[] AS review_codes,
    CASE
        WHEN import_snapshot_review_codes && ARRAY[
            'header_line_total_mismatch',
            'source_header_line_total_mismatch'
        ]::text[]
            THEN 'critical'
        WHEN cardinality(import_snapshot_review_codes) > 0
          OR NOT source_financial_evidence_present
          OR NOT source_financial_evidence_immutable
          OR (
              NOT has_post_import_activity
              AND current_state_differs_from_import
          )
          OR line_booked_at_mismatch_count > 0
          OR booking_event_time_mismatch_count > 0
          OR orphaned_initial_booking_event_count > 0
          OR unreviewed_adjustment_event_count > 0
          OR counterpoint_import_event_count = 0
            THEN 'review'
        ELSE 'ok'
    END AS integrity_status,
    CASE
        WHEN cardinality(import_snapshot_review_codes) > 0
            THEN 'The immutable import snapshot has a source financial mismatch. Review Counterpoint evidence; do not rewrite money from this report.'
        WHEN has_post_import_activity AND current_state_differs_from_import
            THEN 'Current net values differ from the import snapshot only as current operational state. Returns, refunds, and later activity are not import corruption.'
        WHEN source_financial_evidence_present
         AND current_state_differs_from_import
            THEN 'Current net values changed without durable post-import evidence. Review the transaction audit before any correction.'
        WHEN line_booked_at_mismatch_count > 0 OR booking_event_time_mismatch_count > 0
            THEN 'Booking timestamp repair is available after manifest review; tender values remain unchanged.'
        WHEN orphaned_initial_booking_event_count > 0 OR unreviewed_adjustment_event_count > 0
            THEN 'Review historical booking events before changing reporting treatment.'
        WHEN counterpoint_import_event_count = 0
            THEN 'The Transaction audit feed will show synthesized import evidence; no historical activity row was fabricated.'
        ELSE 'No imported financial-integrity exception detected.'
    END AS recommended_action
FROM state_classified;

COMMENT ON VIEW reporting.counterpoint_import_financial_integrity IS
    'Read-only comparison of immutable Counterpoint import snapshots with current net state. Later returns, refunds, and audited activity are reported separately and are never classified as import corruption.';

CREATE OR REPLACE VIEW reporting.counterpoint_booking_date_repair_manifest AS
WITH line_candidates AS (
    SELECT
        tl.transaction_id,
        COUNT(*)::bigint AS line_rows_to_update,
        ARRAY_AGG(tl.id ORDER BY tl.id) AS transaction_line_ids,
        JSONB_AGG(
            jsonb_build_object(
                'transaction_line_id', tl.id,
                'current_booked_at', tl.booked_at,
                'target_booked_at', t.booked_at
            ) ORDER BY tl.id
        ) AS line_snapshot
    FROM public.transaction_lines tl
    INNER JOIN public.transactions t ON t.id = tl.transaction_id
    WHERE COALESCE(t.is_counterpoint_import, FALSE)
      AND tl.booked_at IS DISTINCT FROM t.booked_at
    GROUP BY tl.transaction_id
),
event_candidates AS (
    SELECT
        e.transaction_id,
        COUNT(*)::bigint AS booking_events_to_update,
        ARRAY_AGG(e.id ORDER BY e.id) AS booking_event_ids,
        JSONB_AGG(
            jsonb_build_object(
                'booking_event_id', e.id,
                'transaction_line_id', e.transaction_line_id,
                'current_booked_at', e.booked_at,
                'target_booked_at', t.booked_at
            ) ORDER BY e.id
        ) AS event_snapshot
    FROM public.transaction_line_booking_events e
    INNER JOIN public.transactions t ON t.id = e.transaction_id
    INNER JOIN public.transaction_lines tl
        ON tl.id = e.transaction_line_id
       AND tl.transaction_id = e.transaction_id
    WHERE COALESCE(t.is_counterpoint_import, FALSE)
      AND e.event_kind = 'initial_booking'
      AND e.booked_at IS DISTINCT FROM t.booked_at
    GROUP BY e.transaction_id
)
SELECT
    md5(concat_ws(
        '|',
        fi.transaction_id::text,
        fi.booked_at::text,
        COALESCE(l.transaction_line_ids::text, ''),
        COALESCE(e.booking_event_ids::text, ''),
        COALESCE(l.line_snapshot::text, ''),
        COALESCE(e.event_snapshot::text, ''),
        fi.header_total::text,
        fi.stored_amount_paid::text,
        fi.allocated_tender_total::text
    )) AS manifest_key,
    fi.transaction_id,
    fi.display_id,
    fi.counterpoint_ticket_ref,
    fi.counterpoint_doc_ref,
    fi.booked_at AS target_booked_at,
    COALESCE(l.line_rows_to_update, 0)::bigint AS line_rows_to_update,
    COALESCE(l.transaction_line_ids, ARRAY[]::uuid[]) AS transaction_line_ids,
    COALESCE(e.booking_events_to_update, 0)::bigint AS booking_events_to_update,
    COALESCE(e.booking_event_ids, ARRAY[]::uuid[]) AS booking_event_ids,
    fi.orphaned_initial_booking_event_count,
    fi.unreviewed_adjustment_event_count,
    fi.header_total,
    fi.line_total,
    fi.stored_amount_paid,
    fi.allocated_tender_total,
    fi.integrity_status,
    fi.review_codes,
    TRUE AS tender_values_read_only,
    jsonb_build_object(
        'transaction', jsonb_build_object(
            'transaction_id', fi.transaction_id,
            'display_id', fi.display_id,
            'counterpoint_ticket_ref', fi.counterpoint_ticket_ref,
            'counterpoint_doc_ref', fi.counterpoint_doc_ref,
            'booked_at', fi.booked_at,
            'imported_at', fi.imported_at
        ),
        'lines', COALESCE(l.line_snapshot, '[]'::jsonb),
        'booking_events', COALESCE(e.event_snapshot, '[]'::jsonb),
        'financial_read_only', jsonb_build_object(
            'immutable_import_snapshot', jsonb_build_object(
                'header_total', fi.import_snapshot_header_total,
                'line_total', fi.import_snapshot_line_total,
                'tender_total', fi.import_snapshot_tender_total,
                'review_codes', fi.import_snapshot_review_codes
            ),
            'current_net_state', jsonb_build_object(
                'header_total', fi.header_total,
                'line_total', fi.line_total,
                'stored_amount_paid', fi.stored_amount_paid,
                'allocated_tender_total', fi.allocated_tender_total,
                'return_event_count', fi.return_event_count,
                'refund_allocation_count', fi.refund_allocation_count,
                'has_post_import_activity', fi.has_post_import_activity
            )
        )
    ) AS source_snapshot
FROM reporting.counterpoint_import_financial_integrity fi
LEFT JOIN line_candidates l ON l.transaction_id = fi.transaction_id
LEFT JOIN event_candidates e ON e.transaction_id = fi.transaction_id
WHERE COALESCE(l.line_rows_to_update, 0) > 0
   OR COALESCE(e.booking_events_to_update, 0) > 0;

COMMENT ON VIEW reporting.counterpoint_booking_date_repair_manifest IS
    'Dry-run manifest for imported Counterpoint line and initial-booking timestamps that differ from the source transaction booking time. Financial and tender fields are context-only and are never changed by the repair.';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_ro') THEN
        GRANT SELECT ON reporting.counterpoint_import_financial_integrity TO metabase_ro;
        GRANT SELECT ON reporting.counterpoint_booking_date_repair_manifest TO metabase_ro;
    END IF;
END $$;
