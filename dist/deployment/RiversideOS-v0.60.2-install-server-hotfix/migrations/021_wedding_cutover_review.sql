ALTER TABLE wedding_parties
    ADD COLUMN IF NOT EXISTS cutover_review_status TEXT NOT NULL DEFAULT 'not_required',
    ADD COLUMN IF NOT EXISTS cutover_reviewed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cutover_reviewed_by TEXT,
    ADD COLUMN IF NOT EXISTS cutover_review_notes TEXT;

ALTER TABLE wedding_parties
    DROP CONSTRAINT IF EXISTS wedding_parties_cutover_review_status_chk;

ALTER TABLE wedding_parties
    ADD CONSTRAINT wedding_parties_cutover_review_status_chk
    CHECK (cutover_review_status IN ('not_required', 'needs_review', 'in_review', 'blocked', 'reviewed'));

CREATE TABLE IF NOT EXISTS wedding_cutover_match_suggestions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wedding_party_id UUID NOT NULL REFERENCES wedding_parties(id) ON DELETE CASCADE,
    wedding_member_id UUID REFERENCES wedding_members(id) ON DELETE SET NULL,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
    transaction_line_id UUID REFERENCES transaction_lines(id) ON DELETE CASCADE,
    confidence TEXT NOT NULL DEFAULT 'medium',
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'suggested',
    reviewed_by TEXT,
    reviewed_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT wedding_cutover_match_suggestions_confidence_chk
        CHECK (confidence IN ('high', 'medium', 'low')),
    CONSTRAINT wedding_cutover_match_suggestions_status_chk
        CHECK (status IN ('suggested', 'accepted', 'rejected', 'ignored'))
);

CREATE INDEX IF NOT EXISTS idx_wedding_cutover_suggestions_party_status
    ON wedding_cutover_match_suggestions(wedding_party_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wedding_cutover_suggestions_transaction
    ON wedding_cutover_match_suggestions(transaction_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wedding_cutover_suggestions_unique_line
    ON wedding_cutover_match_suggestions(wedding_party_id, wedding_member_id, transaction_id, transaction_line_id)
    WHERE transaction_line_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wedding_cutover_suggestions_unique_transaction
    ON wedding_cutover_match_suggestions(wedding_party_id, wedding_member_id, transaction_id)
    WHERE transaction_line_id IS NULL;
