-- One immutable Z-report per till group and store-local business date.
-- A register session may remain open across calendar days, but its reports may not.

CREATE TABLE IF NOT EXISTS register_business_day_z_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    till_close_group_id UUID NOT NULL,
    primary_register_session_id UUID NOT NULL REFERENCES register_sessions(id),
    business_date DATE NOT NULL,
    closed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_by UUID REFERENCES staff(id),
    opening_float NUMERIC(12, 2) NOT NULL,
    expected_cash NUMERIC(12, 2) NOT NULL,
    actual_cash NUMERIC(12, 2),
    discrepancy NUMERIC(12, 2),
    cash_deposit_date DATE,
    cash_deposit_amount NUMERIC(12, 2),
    closing_notes TEXT,
    closing_comments TEXT,
    is_late_close BOOLEAN NOT NULL DEFAULT FALSE,
    z_report_json JSONB NOT NULL,
    CONSTRAINT register_business_day_z_reports_group_date_key
        UNIQUE (till_close_group_id, business_date),
    CONSTRAINT register_business_day_z_reports_actual_pair_check
        CHECK (
            (actual_cash IS NULL AND discrepancy IS NULL)
            OR (actual_cash IS NOT NULL AND discrepancy IS NOT NULL)
        )
);

CREATE INDEX IF NOT EXISTS register_business_day_z_reports_date_idx
    ON register_business_day_z_reports (business_date DESC, closed_at DESC);

CREATE INDEX IF NOT EXISTS register_business_day_z_reports_primary_session_idx
    ON register_business_day_z_reports (primary_register_session_id);

COMMENT ON TABLE register_business_day_z_reports IS
    'Immutable, single-store-day Z reports. Multiple rows may reference one long-running till group, but each group/date pair is unique.';

COMMENT ON COLUMN register_business_day_z_reports.is_late_close IS
    'True when the business date was closed after a later store-local date had begun. Per-day actual cash remains null when no separate historical drawer count exists.';

-- Correct the known 2026-07-10/11 combined close without inventing historical
-- drawer counts. The original physical close timestamp/count remains on
-- register_sessions for audit; staff-facing Z history reads these two daily rows.
WITH target AS (
    SELECT
        rs.id AS primary_session_id,
        rs.till_close_group_id,
        rs.opened_by,
        rs.closed_by,
        rs.shift_primary_staff_id,
        rs.opening_float,
        rs.actual_cash,
        rs.cash_deposit_date,
        rs.cash_deposit_amount,
        rs.closed_at,
        rs.closing_notes,
        rs.closing_comments,
        rs.z_report_json
    FROM register_sessions rs
    WHERE rs.id = 'ef7a5aff-52b5-47c8-8f92-8b73fa6aa011'::uuid
      AND rs.register_lane = 1
      AND rs.closed_at IS NOT NULL
), repair_dates(business_date) AS (
    VALUES (DATE '2026-07-10'), (DATE '2026-07-11')
), prepared AS (
    SELECT
        t.*,
        d.business_date,
        t.opening_float
            + COALESCE(cash.cash_total, 0)
            + COALESCE(adjustments.paid_in, 0)
            - COALESCE(adjustments.paid_out, 0) AS expected_cash,
        COALESCE(adjustments.net_adjustments, 0) AS net_adjustments,
        COALESCE(tenders.rows, '[]'::jsonb) AS tenders,
        COALESCE(lane_tenders.rows, '[]'::jsonb) AS tenders_by_lane,
        COALESCE(transactions.rows, '[]'::jsonb) AS transactions,
        COALESCE(cash_adjustment_rows.rows, '[]'::jsonb) AS cash_adjustments,
        COALESCE(drawer_open_rows.rows, '[]'::jsonb) AS manual_drawer_opens,
        COALESCE(inventory_rows.rows, '[]'::jsonb) AS inventory_activity,
        COALESCE(override_rows.rows, '[]'::jsonb) AS override_summary
    FROM target t
    CROSS JOIN repair_dates d
    LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(pt.amount), 0)::numeric AS cash_total
        FROM payment_transactions pt
        INNER JOIN register_sessions rs_group ON rs_group.id = pt.session_id
        WHERE rs_group.till_close_group_id = t.till_close_group_id
          AND pt.payment_method = 'cash'
          AND (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date = d.business_date
    ) cash ON TRUE
    LEFT JOIN LATERAL (
        SELECT
            COALESCE(SUM(rca.amount) FILTER (WHERE rca.direction = 'paid_in'), 0)::numeric AS paid_in,
            COALESCE(SUM(rca.amount) FILTER (WHERE rca.direction = 'paid_out'), 0)::numeric AS paid_out,
            COALESCE(SUM(CASE WHEN rca.direction = 'paid_in' THEN rca.amount ELSE -rca.amount END), 0)::numeric AS net_adjustments
        FROM register_cash_adjustments rca
        WHERE rca.session_id = t.primary_session_id
          AND (rca.created_at AT TIME ZONE reporting.effective_store_timezone())::date = d.business_date
    ) adjustments ON TRUE
    LEFT JOIN LATERAL (
        SELECT jsonb_agg(
            jsonb_build_object(
                'payment_method', grouped.payment_method,
                'total_amount', grouped.total_amount,
                'tx_count', grouped.tx_count
            ) ORDER BY grouped.payment_method
        ) AS rows
        FROM (
            SELECT pt.payment_method, SUM(pt.amount)::numeric AS total_amount, COUNT(*)::bigint AS tx_count
            FROM payment_transactions pt
            INNER JOIN register_sessions rs_group ON rs_group.id = pt.session_id
            WHERE rs_group.till_close_group_id = t.till_close_group_id
              AND (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date = d.business_date
            GROUP BY pt.payment_method
        ) grouped
    ) tenders ON TRUE
    LEFT JOIN LATERAL (
        SELECT jsonb_agg(
            jsonb_build_object(
                'register_lane', lane_group.register_lane,
                'tenders', lane_group.tenders
            ) ORDER BY lane_group.register_lane
        ) AS rows
        FROM (
            SELECT
                grouped.register_lane,
                jsonb_agg(
                    jsonb_build_object(
                        'payment_method', grouped.payment_method,
                        'total_amount', grouped.total_amount,
                        'tx_count', grouped.tx_count
                    ) ORDER BY grouped.payment_method
                ) AS tenders
            FROM (
                SELECT rs_group.register_lane, pt.payment_method,
                       SUM(pt.amount)::numeric AS total_amount, COUNT(*)::bigint AS tx_count
                FROM payment_transactions pt
                INNER JOIN register_sessions rs_group ON rs_group.id = pt.session_id
                WHERE rs_group.till_close_group_id = t.till_close_group_id
                  AND (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date = d.business_date
                GROUP BY rs_group.register_lane, pt.payment_method
            ) grouped
            GROUP BY grouped.register_lane
        ) lane_group
    ) lane_tenders ON TRUE
    LEFT JOIN LATERAL (
        SELECT jsonb_agg(item ORDER BY (item->>'created_at')::timestamptz DESC) AS rows
        FROM jsonb_array_elements(COALESCE(t.z_report_json->'transactions', '[]'::jsonb)) item
        WHERE ((item->>'created_at')::timestamptz AT TIME ZONE reporting.effective_store_timezone())::date = d.business_date
    ) transactions ON TRUE
    LEFT JOIN LATERAL (
        SELECT jsonb_agg(item ORDER BY (item->>'created_at')::timestamptz DESC) AS rows
        FROM jsonb_array_elements(COALESCE(t.z_report_json->'cash_adjustments', '[]'::jsonb)) item
        WHERE ((item->>'created_at')::timestamptz AT TIME ZONE reporting.effective_store_timezone())::date = d.business_date
    ) cash_adjustment_rows ON TRUE
    LEFT JOIN LATERAL (
        SELECT jsonb_agg(item ORDER BY (item->>'created_at')::timestamptz DESC) AS rows
        FROM jsonb_array_elements(COALESCE(t.z_report_json->'manual_drawer_opens', '[]'::jsonb)) item
        WHERE ((item->>'created_at')::timestamptz AT TIME ZONE reporting.effective_store_timezone())::date = d.business_date
    ) drawer_open_rows ON TRUE
    LEFT JOIN LATERAL (
        SELECT jsonb_agg(item ORDER BY (item->>'created_at')::timestamptz DESC) AS rows
        FROM jsonb_array_elements(COALESCE(t.z_report_json->'inventory_activity', '[]'::jsonb)) item
        WHERE ((item->>'created_at')::timestamptz AT TIME ZONE reporting.effective_store_timezone())::date = d.business_date
    ) inventory_rows ON TRUE
    LEFT JOIN LATERAL (
        SELECT jsonb_agg(
            jsonb_build_object(
                'reason', grouped.reason,
                'line_count', grouped.line_count,
                'total_delta', grouped.total_delta
            ) ORDER BY grouped.line_count DESC
        ) AS rows
        FROM (
            SELECT
                COALESCE(NULLIF(TRIM(tl.size_specs->>'price_override_reason'), ''), '(unset)') AS reason,
                COUNT(*)::bigint AS line_count,
                COALESCE(SUM(
                    (COALESCE((tl.size_specs->>'original_unit_price')::numeric, 0)
                    - COALESCE((tl.size_specs->>'overridden_unit_price')::numeric, 0))
                    * tl.quantity::numeric
                ), 0)::numeric(14,2) AS total_delta
            FROM payment_transactions pt
            INNER JOIN register_sessions rs_group ON rs_group.id = pt.session_id
            INNER JOIN payment_allocations pa ON pa.transaction_id = pt.id
            INNER JOIN transaction_lines tl ON tl.transaction_id = pa.target_transaction_id
            WHERE rs_group.till_close_group_id = t.till_close_group_id
              AND (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date = d.business_date
              AND tl.size_specs ? 'price_override_reason'
            GROUP BY 1
        ) grouped
    ) override_rows ON TRUE
    WHERE EXISTS (
        SELECT 1
        FROM payment_transactions pt
        INNER JOIN register_sessions rs_group ON rs_group.id = pt.session_id
        WHERE rs_group.till_close_group_id = t.till_close_group_id
          AND (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date = d.business_date
    )
)
INSERT INTO register_business_day_z_reports (
    till_close_group_id,
    primary_register_session_id,
    business_date,
    closed_at,
    closed_by,
    opening_float,
    expected_cash,
    actual_cash,
    discrepancy,
    cash_deposit_date,
    cash_deposit_amount,
    closing_notes,
    closing_comments,
    is_late_close,
    z_report_json
)
SELECT
    p.till_close_group_id,
    p.primary_session_id,
    p.business_date,
    p.closed_at,
    COALESCE(p.closed_by, p.shift_primary_staff_id, p.opened_by),
    p.opening_float,
    p.expected_cash,
    CASE WHEN p.business_date = DATE '2026-07-11' THEN p.actual_cash ELSE NULL END,
    CASE WHEN p.business_date = DATE '2026-07-11' THEN p.actual_cash - p.expected_cash ELSE NULL END,
    CASE WHEN p.business_date = DATE '2026-07-11' THEN p.cash_deposit_date ELSE NULL END,
    CASE WHEN p.business_date = DATE '2026-07-11' THEN p.cash_deposit_amount ELSE NULL END,
    CONCAT_WS(E'\n', NULLIF(TRIM(p.closing_notes), ''),
        'Historical correction: the 2026-07-10 and 2026-07-11 activity was originally combined in a 2026-07-13 close. The saved $982.75 count and $682.75 deposit reconcile exactly to 2026-07-11 plus the $300.00 float; no separate 2026-07-10 drawer count was captured.'),
    p.closing_comments,
    TRUE,
    (COALESCE(p.z_report_json, '{}'::jsonb) - 'closed_session_ids') || jsonb_build_object(
        'report_type', 'z_report',
        'business_date', p.business_date,
        'qbo_activity_date', p.business_date,
        'till_session_ids', COALESCE(p.z_report_json->'closed_session_ids', '[]'::jsonb),
        'opening_float', p.opening_float,
        'net_cash_adjustments', p.net_adjustments,
        'expected_cash', p.expected_cash,
        'actual_cash', CASE WHEN p.business_date = DATE '2026-07-11' THEN p.actual_cash ELSE NULL END,
        'discrepancy', CASE WHEN p.business_date = DATE '2026-07-11' THEN p.actual_cash - p.expected_cash ELSE NULL END,
        'cash_deposit_date', CASE WHEN p.business_date = DATE '2026-07-11' THEN p.cash_deposit_date ELSE NULL END,
        'cash_deposit_amount', CASE WHEN p.business_date = DATE '2026-07-11' THEN p.cash_deposit_amount ELSE NULL END,
        'cash_reconciliation_status', CASE WHEN p.business_date = DATE '2026-07-11' THEN 'counted_at_late_close' ELSE 'not_captured_separately' END,
        'is_late_close', TRUE,
        'tenders', p.tenders,
        'tenders_by_lane', p.tenders_by_lane,
        'transactions', p.transactions,
        'cash_adjustments', p.cash_adjustments,
        'manual_drawer_opens', p.manual_drawer_opens,
        'inventory_activity', p.inventory_activity,
        'override_summary', p.override_summary,
        'qbo_journal', NULL,
        'qbo_journal_error', 'Historical correction: review the QBO journal for this business date.',
        'closing_notes', CONCAT_WS(E'\n', NULLIF(TRIM(p.closing_notes), ''),
            'Historical correction: the 2026-07-10 and 2026-07-11 activity was originally combined in a 2026-07-13 close. The saved $982.75 count and $682.75 deposit reconcile exactly to 2026-07-11 plus the $300.00 float; no separate 2026-07-10 drawer count was captured.')
    )
FROM prepared p
ON CONFLICT (till_close_group_id, business_date) DO NOTHING;
