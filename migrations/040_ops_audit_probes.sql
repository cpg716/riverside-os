-- ROS Dev Center audit probe runs and results.
-- Stores production audit probe execution history and per-probe row details.

CREATE TABLE IF NOT EXISTS ops_audit_probe_run (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    triggered_by_staff_id UUID REFERENCES staff (id) ON DELETE SET NULL,
    probe_count INT NOT NULL DEFAULT 0,
    total_violation_rows INT NOT NULL DEFAULT 0,
    probes_with_violations INT NOT NULL DEFAULT 0,
    duration_ms INT,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')) DEFAULT 'running',
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ops_audit_probe_run_created
    ON ops_audit_probe_run (created_at DESC);

CREATE TABLE IF NOT EXISTS ops_audit_probe_result (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_id UUID NOT NULL REFERENCES ops_audit_probe_run (id) ON DELETE CASCADE,
    probe_key TEXT NOT NULL,
    probe_label TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')) DEFAULT 'warning',
    violation_count INT NOT NULL DEFAULT 0,
    detail_rows JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ops_audit_probe_result_run
    ON ops_audit_probe_result (run_id, probe_key);

CREATE INDEX IF NOT EXISTS idx_ops_audit_probe_result_violations
    ON ops_audit_probe_result (run_id, violation_count DESC);

-- Alert rule for audit probe failures (non-zero violations).
INSERT INTO ops_alert_rule (rule_key, title, severity, enabled, suppress_minutes, channel_inbox, channel_email, channel_sms)
VALUES
    ('audit_probe_failure', 'Production audit probe detected violations', 'warning', true, 120, true, true, false)
ON CONFLICT (rule_key) DO NOTHING;

COMMENT ON TABLE ops_audit_probe_run IS 'Historical record of production audit probe executions from the ROS Dev Center.';
COMMENT ON TABLE ops_audit_probe_result IS 'Per-probe results with violation count and detail rows for each audit probe run.';
