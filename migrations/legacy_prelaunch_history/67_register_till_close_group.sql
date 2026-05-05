-- Till shift: Register #1 (drawer) + satellite lanes share till_close_group_id for combined Z-close.

ALTER TABLE register_sessions
    ADD COLUMN IF NOT EXISTS till_close_group_id UUID;

UPDATE register_sessions
SET till_close_group_id = gen_random_uuid()
WHERE till_close_group_id IS NULL;

ALTER TABLE register_sessions
    ALTER COLUMN till_close_group_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS register_sessions_open_till_group_idx
    ON register_sessions (till_close_group_id)
    WHERE is_open = true;

COMMENT ON COLUMN register_sessions.till_close_group_id IS
    'All open lanes in one physical till shift share this UUID. Register lane 1 owns the cash drawer; satellites use opening_float=0 and join via primary_session_id at open.';
