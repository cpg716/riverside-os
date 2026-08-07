-- Schedule unbiased Podium review requests after the customer has had time to
-- reflect on the fulfilled Riverside experience.

ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS review_invite_scheduled_for TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS review_invite_claimed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS review_invite_last_attempt_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS review_invite_attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS review_invite_last_error TEXT,
    ADD COLUMN IF NOT EXISTS review_invite_delivery_channel TEXT,
    ADD COLUMN IF NOT EXISTS podium_review_message_id TEXT;

ALTER TABLE transactions
    DROP CONSTRAINT IF EXISTS transactions_review_invite_delivery_channel_chk;

ALTER TABLE transactions
    ADD CONSTRAINT transactions_review_invite_delivery_channel_chk
    CHECK (review_invite_delivery_channel IS NULL OR review_invite_delivery_channel IN ('sms', 'email'));

CREATE INDEX IF NOT EXISTS idx_transactions_review_invite_due
    ON transactions (review_invite_scheduled_for, booked_at)
    WHERE podium_review_invite_status IN ('scheduled', 'sending');

CREATE INDEX IF NOT EXISTS idx_transactions_podium_review_invite_id
    ON transactions (podium_review_invite_id)
    WHERE podium_review_invite_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_podium_review_message_id
    ON transactions (podium_review_message_id)
    WHERE podium_review_message_id IS NOT NULL;

CREATE OR REPLACE FUNCTION review_invite_delivery_time(
    p_reference TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
) RETURNS TIMESTAMPTZ AS $$
DECLARE
    v_timezone TEXT;
    v_target_date DATE;
BEGIN
    v_timezone := reporting.effective_store_timezone();
    v_target_date := (p_reference AT TIME ZONE v_timezone)::date + 5;
    IF EXTRACT(DOW FROM v_target_date) = 0 THEN
        v_target_date := v_target_date + 1;
    END IF;
    RETURN (v_target_date + TIME '10:00') AT TIME ZONE v_timezone;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION schedule_fulfilled_transaction_review_invite()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status::text = 'fulfilled'
       AND NEW.customer_id IS NOT NULL
       AND NEW.review_invite_sent_at IS NULL
       AND NEW.review_invite_suppressed_at IS NULL
       AND NEW.podium_review_invite_status IS NULL
       AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status)
    THEN
        NEW.review_invite_scheduled_for := review_invite_delivery_time(CURRENT_TIMESTAMP);
        NEW.podium_review_invite_status := 'scheduled';
        NEW.review_invite_last_error := NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_schedule_fulfilled_transaction_review_invite ON transactions;

CREATE TRIGGER trigger_schedule_fulfilled_transaction_review_invite
    BEFORE INSERT OR UPDATE OF status ON transactions
    FOR EACH ROW
    EXECUTE FUNCTION schedule_fulfilled_transaction_review_invite();

COMMENT ON COLUMN transactions.review_invite_scheduled_for IS 'Evidence-based delayed delivery time for an eligible Podium review request.';
COMMENT ON COLUMN transactions.podium_review_message_id IS 'Podium conversation item/message UID used for exact asynchronous delivery failure correlation.';
