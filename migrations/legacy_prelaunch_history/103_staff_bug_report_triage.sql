-- Bug report triage: dismissed status, correlation id, admin notes, external URL.

ALTER TYPE bug_report_status ADD VALUE IF NOT EXISTS 'dismissed';

ALTER TABLE staff_bug_report
    ADD COLUMN IF NOT EXISTS correlation_id UUID NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN IF NOT EXISTS resolver_notes TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS external_url TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_bug_report_correlation_id
    ON staff_bug_report (correlation_id);

CREATE INDEX IF NOT EXISTS idx_staff_bug_report_retention
    ON staff_bug_report (created_at);

COMMENT ON COLUMN staff_bug_report.correlation_id IS 'Stable id for log correlation and support reference (returned on submit).';
COMMENT ON COLUMN staff_bug_report.resolver_notes IS 'Internal triage notes from settings.admin.';
COMMENT ON COLUMN staff_bug_report.external_url IS 'Optional tracker URL (Linear, GitHub issue, etc.).';
