-- Reassert the invariant that one physical register lane can only have one open drawer/session.
-- If this fails, the live database already has duplicate open rows that must be reconciled first.

CREATE UNIQUE INDEX IF NOT EXISTS register_sessions_open_lane_uidx
    ON public.register_sessions (register_lane)
    WHERE is_open = true;
