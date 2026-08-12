-- Remember the PIN-verified Riverside staff member credited with replies in each Podium conversation.

ALTER TABLE podium_conversation
    ADD COLUMN IF NOT EXISTS responder_staff_id UUID,
    ADD COLUMN IF NOT EXISTS responder_verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS responder_selected_by_staff_id UUID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'podium_conversation_responder_staff_fk'
          AND conrelid = 'podium_conversation'::regclass
    ) THEN
        ALTER TABLE podium_conversation
            ADD CONSTRAINT podium_conversation_responder_staff_fk
            FOREIGN KEY (responder_staff_id) REFERENCES staff(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'podium_conversation_responder_selected_by_staff_fk'
          AND conrelid = 'podium_conversation'::regclass
    ) THEN
        ALTER TABLE podium_conversation
            ADD CONSTRAINT podium_conversation_responder_selected_by_staff_fk
            FOREIGN KEY (responder_selected_by_staff_id) REFERENCES staff(id) ON DELETE SET NULL;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_podium_conversation_responder_staff
    ON podium_conversation (responder_staff_id)
    WHERE responder_staff_id IS NOT NULL;

COMMENT ON COLUMN podium_conversation.responder_staff_id IS
    'PIN-verified Riverside staff member whose name is credited on replies from this conversation.';
COMMENT ON COLUMN podium_conversation.responder_verified_at IS
    'Time the remembered responder last verified their Access PIN or was established from the authenticated sender.';
COMMENT ON COLUMN podium_conversation.responder_selected_by_staff_id IS
    'Authenticated Riverside operator who selected the remembered responder, when available.';
