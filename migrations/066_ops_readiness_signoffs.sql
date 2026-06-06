-- Persist manual ROS Operations readiness signoffs.
-- Migration: 066

CREATE TABLE IF NOT EXISTS ops_readiness_signoffs (
    check_key TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'manual_required',
    notes TEXT NOT NULL DEFAULT '',
    evidence_ref TEXT NOT NULL DEFAULT '',
    expires_at TIMESTAMPTZ,
    signed_off_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    signed_off_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ops_readiness_signoffs_status_check
        CHECK (status IN ('ready', 'manual_required')),
    CONSTRAINT ops_readiness_signoffs_category_check
        CHECK (category IN ('daily_open', 'go_live', 'evidence'))
);

CREATE INDEX IF NOT EXISTS idx_ops_readiness_signoffs_category
    ON ops_readiness_signoffs(category);

CREATE INDEX IF NOT EXISTS idx_ops_readiness_signoffs_signed_off_at
    ON ops_readiness_signoffs(signed_off_at DESC);

COMMENT ON TABLE ops_readiness_signoffs IS 'Manager-reviewed manual signoffs for ROS Operations readiness checks.';
