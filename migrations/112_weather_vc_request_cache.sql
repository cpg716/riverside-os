-- Persist Visual Crossing request cache across ROS server restarts and processes.
CREATE TABLE IF NOT EXISTS public.weather_vc_request_cache (
    cache_key TEXT PRIMARY KEY,
    payload_json JSONB,
    error_message TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT weather_vc_request_cache_payload_or_error_chk
        CHECK (payload_json IS NOT NULL OR error_message IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_weather_vc_request_cache_expires
    ON public.weather_vc_request_cache (expires_at);

INSERT INTO ros_schema_migrations (version) VALUES ('112_weather_vc_request_cache.sql')
ON CONFLICT (version) DO NOTHING;
