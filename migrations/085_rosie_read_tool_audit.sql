-- ROSIE read-only semantic tool execution audit.

CREATE TABLE IF NOT EXISTS rosie_read_tool_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    tool_name TEXT NOT NULL,
    arguments_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    permission_result TEXT NOT NULL CHECK (permission_result IN ('allowed', 'denied')),
    row_count INTEGER NOT NULL DEFAULT 0,
    success BOOLEAN NOT NULL DEFAULT false,
    error_category TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rosie_read_tool_audit_staff_created
    ON rosie_read_tool_audit (staff_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rosie_read_tool_audit_tool_created
    ON rosie_read_tool_audit (tool_name, created_at DESC);

COMMENT ON TABLE rosie_read_tool_audit IS
    'Append-only audit metadata for ROSIE read-only semantic data tool calls. Does not store full sensitive payloads.';
