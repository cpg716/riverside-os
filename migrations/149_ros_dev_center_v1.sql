-- ROS Dev Center v1: ops telemetry, alerts, action audit, delivery log, and bug↔incident linkage.

CREATE TABLE IF NOT EXISTS ops_station_heartbeat (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    station_key TEXT NOT NULL UNIQUE,
    station_label TEXT NOT NULL,
    app_version TEXT NOT NULL,
    git_sha TEXT,
    tailscale_node TEXT,
    lan_ip TEXT,
    last_sync_at TIMESTAMPTZ,
    last_update_check_at TIMESTAMPTZ,
    last_update_install_at TIMESTAMPTZ,
    meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ops_station_heartbeat_last_seen
    ON ops_station_heartbeat (last_seen_at DESC);

CREATE TABLE IF NOT EXISTS ops_alert_rule (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rule_key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    enabled BOOLEAN NOT NULL DEFAULT true,
    suppress_minutes INTEGER NOT NULL DEFAULT 60,
    channel_inbox BOOLEAN NOT NULL DEFAULT true,
    channel_email BOOLEAN NOT NULL DEFAULT true,
    channel_sms BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ops_alert_event (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rule_key TEXT NOT NULL,
    dedupe_key TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    status TEXT NOT NULL CHECK (status IN ('open', 'acked', 'resolved')) DEFAULT 'open',
    context JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acked_at TIMESTAMPTZ,
    acked_by_staff_id UUID REFERENCES staff (id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    resolved_by_staff_id UUID REFERENCES staff (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_alert_event_dedupe
    ON ops_alert_event (dedupe_key)
    WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ops_alert_event_status
    ON ops_alert_event (status, severity, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS ops_action_audit (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    actor_staff_id UUID NOT NULL REFERENCES staff (id) ON DELETE RESTRICT,
    action_key TEXT NOT NULL,
    reason TEXT NOT NULL,
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    payload_hash_sha256 TEXT NOT NULL,
    correlation_id UUID NOT NULL DEFAULT uuid_generate_v4(),
    result_ok BOOLEAN NOT NULL,
    result_message TEXT NOT NULL,
    result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ops_action_audit_created
    ON ops_action_audit (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ops_action_audit_actor
    ON ops_action_audit (actor_staff_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ops_notification_delivery_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    alert_event_id UUID NOT NULL REFERENCES ops_alert_event (id) ON DELETE CASCADE,
    channel TEXT NOT NULL CHECK (channel IN ('inbox', 'email', 'sms')),
    destination TEXT,
    delivery_status TEXT NOT NULL CHECK (delivery_status IN ('queued', 'sent', 'failed')),
    provider_message_id TEXT,
    error_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ops_notification_delivery_alert
    ON ops_notification_delivery_log (alert_event_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ops_bug_incident_link (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bug_report_id UUID NOT NULL REFERENCES staff_bug_report (id) ON DELETE CASCADE,
    alert_event_id UUID NOT NULL REFERENCES ops_alert_event (id) ON DELETE CASCADE,
    linked_by_staff_id UUID REFERENCES staff (id) ON DELETE SET NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (bug_report_id, alert_event_id)
);

CREATE INDEX IF NOT EXISTS idx_ops_bug_incident_link_bug
    ON ops_bug_incident_link (bug_report_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ops_bug_incident_link_alert
    ON ops_bug_incident_link (alert_event_id, created_at DESC);

INSERT INTO ops_alert_rule (rule_key, title, severity, enabled, suppress_minutes, channel_inbox, channel_email, channel_sms)
VALUES
    ('integration_qbo_failure', 'QBO integration failure', 'critical', true, 60, true, true, true),
    ('integration_weather_failure', 'Weather integration failure', 'warning', true, 120, true, true, false),
    ('backup_overdue', 'Database backup overdue', 'critical', true, 180, true, true, true),
    ('counterpoint_sync_stale', 'Counterpoint sync stale', 'warning', true, 180, true, true, false),
    ('station_offline', 'Register workstation offline', 'warning', true, 30, true, false, false)
ON CONFLICT (rule_key) DO NOTHING;

-- Dev Center permissions (strictly scoped to trusted admins).
INSERT INTO staff_role_permission (role, permission_key, allowed)
VALUES
    ('admin', 'ops.dev_center.view', true),
    ('admin', 'ops.dev_center.actions', true),
    ('salesperson', 'ops.dev_center.view', false),
    ('salesperson', 'ops.dev_center.actions', false),
    ('sales_support', 'ops.dev_center.view', false),
    ('sales_support', 'ops.dev_center.actions', false)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;

COMMENT ON TABLE ops_station_heartbeat IS 'Per-register heartbeat telemetry for ROS Dev Center fleet monitoring.';
COMMENT ON TABLE ops_alert_event IS 'Operational alerts with dedupe + ack/resolution lifecycle for ROS Dev Center.';
COMMENT ON TABLE ops_action_audit IS 'Immutable guarded-action audit trail for ROS Dev Center.';
COMMENT ON TABLE ops_notification_delivery_log IS 'Delivery attempts for Dev Center alert channels (inbox/email/sms).';
COMMENT ON TABLE ops_bug_incident_link IS 'Links existing ROS bug reports to Dev Center operational incidents.';
