-- Persist familiar mailbox triage state without permanently deleting retained email evidence.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'mailbox_messages'
          AND column_name = 'is_read'
    ) THEN
        ALTER TABLE mailbox_messages
            ADD COLUMN is_read BOOLEAN NOT NULL DEFAULT false;

        -- Existing mail predates read tracking and must not become a false unread backlog.
        UPDATE mailbox_messages
        SET is_read = true;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_mailbox_unread_received_at
    ON mailbox_messages(COALESCE(received_at, sent_at, created_at) DESC)
    WHERE is_read = false AND folder <> 'TRASH';
