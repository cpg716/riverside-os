CREATE TABLE IF NOT EXISTS public.register_session_station_tokens (
    register_session_id uuid NOT NULL REFERENCES public.register_sessions(id) ON DELETE CASCADE,
    station_key text NOT NULL,
    pos_api_token text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (register_session_id, station_key),
    CONSTRAINT register_session_station_tokens_station_key_chk CHECK (length(btrim(station_key)) BETWEEN 8 AND 128),
    CONSTRAINT register_session_station_tokens_pos_api_token_chk CHECK (length(btrim(pos_api_token)) >= 16)
);

CREATE UNIQUE INDEX IF NOT EXISTS register_session_station_tokens_token_uidx
    ON public.register_session_station_tokens (pos_api_token);

CREATE INDEX IF NOT EXISTS idx_register_session_station_tokens_session
    ON public.register_session_station_tokens (register_session_id, last_used_at DESC);

COMMENT ON TABLE public.register_session_station_tokens IS
    'Per-device POS API tokens for open register sessions. A token is valid only with its issuing station key.';

COMMENT ON COLUMN public.register_session_station_tokens.station_key IS
    'Stable local device key generated on the workstation/PWA and sent with POS session token headers.';
