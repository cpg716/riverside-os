-- ROSIE Token Telemetry Table
-- Tracks AI token usage for cost analysis and provider comparison
-- Migration: 060

CREATE TABLE IF NOT EXISTS rosie_token_telemetry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    model_name TEXT NOT NULL,
    provider TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL
);

-- Index for efficient date-based queries
CREATE INDEX IF NOT EXISTS idx_rosie_token_telemetry_timestamp ON rosie_token_telemetry(timestamp DESC);

-- Index for provider/model analysis
CREATE INDEX IF NOT EXISTS idx_rosie_token_telemetry_provider_model ON rosie_token_telemetry(provider, model_name);

-- Comment for documentation
COMMENT ON TABLE rosie_token_telemetry IS 'Tracks AI token usage for ROSIE intelligence features to enable cost analysis and provider comparison';
COMMENT ON COLUMN rosie_token_telemetry.timestamp IS 'When the AI request was made';
COMMENT ON COLUMN rosie_token_telemetry.model_name IS 'The AI model used (e.g., gemma-2-9b, gpt-4, claude-3)';
COMMENT ON COLUMN rosie_token_telemetry.provider IS 'The AI provider (e.g., local, openai, anthropic)';
COMMENT ON COLUMN rosie_token_telemetry.input_tokens IS 'Number of tokens sent to the AI model';
COMMENT ON COLUMN rosie_token_telemetry.output_tokens IS 'Number of tokens received from the AI model';
