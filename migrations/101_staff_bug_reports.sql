-- Staff-submitted bug reports (screenshot + client logs + triage in Settings).

CREATE TYPE bug_report_status AS ENUM ('pending', 'complete');

CREATE TABLE staff_bug_report (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    steps_context TEXT NOT NULL,
    client_console_log TEXT NOT NULL DEFAULT '',
    client_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    screenshot_png BYTEA NOT NULL,
    status bug_report_status NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    resolved_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL
);

CREATE INDEX idx_staff_bug_report_created_at ON staff_bug_report(created_at DESC);
CREATE INDEX idx_staff_bug_report_status ON staff_bug_report(status);

COMMENT ON TABLE staff_bug_report IS 'In-app bug submissions with screenshot and client diagnostics; triage under Settings → Bug reports (settings.admin).';
