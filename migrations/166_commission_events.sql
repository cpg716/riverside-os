-- Phase 2 commission reporting ledger.
-- Immutable event rows become the reporting source for earned commission, return
-- adjustments, combo incentives, and manual owner/accounting adjustments.

CREATE TABLE IF NOT EXISTS commission_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
    transaction_line_id UUID REFERENCES transaction_lines(id) ON DELETE SET NULL,
    source_event_id UUID,
    event_type TEXT NOT NULL CHECK (
        event_type IN (
            'sale_commission',
            'spiff',
            'combo_incentive',
            'return_adjustment',
            'exchange_adjustment',
            'manual_adjustment'
        )
    ),
    event_at TIMESTAMPTZ NOT NULL,
    reporting_date DATE NOT NULL,
    commissionable_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    base_rate_used NUMERIC(8, 4) NOT NULL DEFAULT 0,
    base_commission_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    incentive_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    adjustment_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    total_commission_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    note TEXT,
    created_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS commission_events_source_type_uidx
    ON commission_events (source_event_id, event_type)
    WHERE source_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS commission_events_reporting_staff_idx
    ON commission_events (reporting_date, staff_id, event_type);

CREATE INDEX IF NOT EXISTS commission_events_transaction_line_idx
    ON commission_events (transaction_line_id);

INSERT INTO commission_events (
    staff_id,
    transaction_id,
    transaction_line_id,
    source_event_id,
    event_type,
    event_at,
    reporting_date,
    commissionable_amount,
    base_rate_used,
    base_commission_amount,
    incentive_amount,
    adjustment_amount,
    total_commission_amount,
    snapshot_json,
    note
)
SELECT
    oi.salesperson_id,
    oi.transaction_id,
    oi.id,
    oi.id,
    CASE WHEN COALESCE(oi.is_internal, FALSE) THEN 'combo_incentive' ELSE 'sale_commission' END,
    COALESCE(oi.fulfilled_at, o.fulfilled_at, o.booked_at),
    COALESCE(oi.fulfilled_at, o.fulfilled_at, o.booked_at)::date,
    CASE WHEN COALESCE(oi.is_internal, FALSE) THEN 0 ELSE (oi.unit_price * oi.quantity)::numeric(14, 2) END,
    COALESCE((
        SELECT h.base_commission_rate
        FROM staff_commission_rate_history h
        WHERE h.staff_id = oi.salesperson_id
          AND h.effective_start_date <= COALESCE(oi.fulfilled_at, o.fulfilled_at, o.booked_at)::date
        ORDER BY h.effective_start_date DESC, h.created_at DESC
        LIMIT 1
    ), st.base_commission_rate, 0)::numeric(8, 4),
    CASE
        WHEN COALESCE(oi.is_internal, FALSE) THEN 0
        ELSE ROUND(
            (oi.unit_price * oi.quantity)
            * COALESCE((
                SELECT h.base_commission_rate
                FROM staff_commission_rate_history h
                WHERE h.staff_id = oi.salesperson_id
                  AND h.effective_start_date <= COALESCE(oi.fulfilled_at, o.fulfilled_at, o.booked_at)::date
                ORDER BY h.effective_start_date DESC, h.created_at DESC
                LIMIT 1
            ), st.base_commission_rate, 0),
            2
        )
    END::numeric(14, 2),
    CASE
        WHEN COALESCE(oi.is_internal, FALSE) THEN oi.calculated_commission
        ELSE (
            oi.calculated_commission - ROUND(
                (oi.unit_price * oi.quantity)
                * COALESCE((
                    SELECT h.base_commission_rate
                    FROM staff_commission_rate_history h
                    WHERE h.staff_id = oi.salesperson_id
                      AND h.effective_start_date <= COALESCE(oi.fulfilled_at, o.fulfilled_at, o.booked_at)::date
                    ORDER BY h.effective_start_date DESC, h.created_at DESC
                    LIMIT 1
                ), st.base_commission_rate, 0),
                2
            )
        )
    END::numeric(14, 2),
    0,
    oi.calculated_commission::numeric(14, 2),
    jsonb_build_object(
        'transaction_short_id', COALESCE(o.short_id, 'TXN-' || left(o.id::text, 8)),
        'product_name', p.name,
        'quantity', oi.quantity,
        'unit_price', oi.unit_price,
        'staff_name', st.full_name,
        'source', CASE WHEN COALESCE(oi.is_internal, FALSE) THEN 'Combo incentive' ELSE 'Staff base rate plus fixed incentives' END
    ),
    CASE WHEN COALESCE(oi.is_internal, FALSE) THEN 'Backfilled combo/SPIFF internal incentive event.' ELSE 'Backfilled sale commission event.' END
FROM transaction_lines oi
INNER JOIN transactions o ON o.id = oi.transaction_id
LEFT JOIN products p ON p.id = oi.product_id
LEFT JOIN staff st ON st.id = oi.salesperson_id
WHERE o.status::text <> 'cancelled'
  AND oi.is_fulfilled = TRUE
  AND oi.salesperson_id IS NOT NULL
  AND oi.calculated_commission <> 0
ON CONFLICT DO NOTHING;

INSERT INTO ros_schema_migrations (version) VALUES ('166_commission_events.sql') ON CONFLICT (version) DO NOTHING;
