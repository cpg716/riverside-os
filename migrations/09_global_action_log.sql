-- Immutable wedding / special-order activity stream + Morning Compass support.

CREATE TABLE IF NOT EXISTS wedding_activity_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wedding_party_id UUID NOT NULL REFERENCES wedding_parties(id) ON DELETE CASCADE,
    wedding_member_id UUID REFERENCES wedding_members(id) ON DELETE SET NULL,
    actor_name TEXT NOT NULL,
    action_type TEXT NOT NULL,
    description TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wedding_activity_log_created ON wedding_activity_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wedding_activity_log_party ON wedding_activity_log (wedding_party_id);
CREATE INDEX IF NOT EXISTS idx_wedding_activity_log_member ON wedding_activity_log (wedding_member_id);

COMMENT ON TABLE wedding_activity_log IS 'Append-only operational feed: status, measurements, payments, notes (actor attribution).';
