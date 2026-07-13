CREATE TABLE IF NOT EXISTS public.staff_access_sessions (
    id uuid PRIMARY KEY,
    staff_id uuid NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    station_key text NOT NULL,
    connection_key text NOT NULL,
    runtime_surface text NOT NULL,
    user_agent text,
    api_base text,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CONSTRAINT staff_access_sessions_station_key_chk
        CHECK (length(btrim(station_key)) BETWEEN 8 AND 128),
    CONSTRAINT staff_access_sessions_connection_key_chk
        CHECK (length(btrim(connection_key)) BETWEEN 8 AND 128),
    CONSTRAINT staff_access_sessions_runtime_surface_chk
        CHECK (runtime_surface IN ('tauri_desktop', 'pwa_standalone', 'browser_tab')),
    CONSTRAINT staff_access_sessions_user_agent_chk
        CHECK (user_agent IS NULL OR length(user_agent) <= 512),
    CONSTRAINT staff_access_sessions_api_base_chk
        CHECK (api_base IS NULL OR length(api_base) <= 512)
);

CREATE INDEX IF NOT EXISTS idx_staff_access_sessions_staff_active
    ON public.staff_access_sessions (staff_id, last_seen_at DESC)
    WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_staff_access_sessions_expiry
    ON public.staff_access_sessions (expires_at)
    WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_access_sessions_one_connection
    ON public.staff_access_sessions (staff_id, station_key, connection_key)
    WHERE revoked_at IS NULL;

COMMENT ON TABLE public.staff_access_sessions IS
    'Opaque, station-bound Staff Access sessions. Each browser tab, installed PWA, or Tauri window receives its own revocable session.';

COMMENT ON COLUMN public.staff_access_sessions.token_hash IS
    'SHA-256 hash of the opaque token; the raw token is returned once and is never stored by the server.';
