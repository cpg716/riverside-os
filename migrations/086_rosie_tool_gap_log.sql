CREATE TABLE IF NOT EXISTS rosie_tool_gap_log (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    staff_id uuid REFERENCES staff(id) ON DELETE SET NULL,
    question_summary text NOT NULL,
    detected_domain text NOT NULL,
    suggested_tool text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rosie_tool_gap_log_created
    ON rosie_tool_gap_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rosie_tool_gap_log_domain_created
    ON rosie_tool_gap_log (detected_domain, created_at DESC);

COMMENT ON TABLE rosie_tool_gap_log IS
    'Redacted ROSIE approved-tool planner gaps for future read-only tool planning; no raw SQL or source payloads.';
