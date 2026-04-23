CREATE TABLE IF NOT EXISTS staff_commission_rate_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    effective_start_date DATE NOT NULL,
    base_commission_rate DECIMAL(5, 4) NOT NULL,
    changed_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_commission_rate_history_staff_effective_uidx
    ON staff_commission_rate_history (staff_id, effective_start_date);

CREATE INDEX IF NOT EXISTS staff_commission_rate_history_staff_created_idx
    ON staff_commission_rate_history (staff_id, created_at DESC);

COMMENT ON TABLE staff_commission_rate_history IS
    'Effective-dated commission base rate history for fulfillment-based payroll recalculation.';
