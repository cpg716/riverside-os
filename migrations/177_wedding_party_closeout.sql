ALTER TABLE wedding_parties
    ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS closed_by_staff_id UUID REFERENCES staff(id),
    ADD COLUMN IF NOT EXISTS closeout_outcome TEXT,
    ADD COLUMN IF NOT EXISTS closeout_reason TEXT,
    ADD COLUMN IF NOT EXISTS closeout_notes TEXT;

ALTER TABLE wedding_parties
    DROP CONSTRAINT IF EXISTS wedding_parties_closeout_outcome_chk;

ALTER TABLE wedding_parties
    ADD CONSTRAINT wedding_parties_closeout_outcome_chk
    CHECK (
        closeout_outcome IS NULL OR closeout_outcome IN (
            'completed_outside_ros',
            'cancelled',
            'not_completed',
            'legacy_record',
            'duplicate_or_test'
        )
    );

CREATE INDEX IF NOT EXISTS idx_wedding_parties_closed_at
    ON wedding_parties (closed_at DESC)
    WHERE closed_at IS NOT NULL;
