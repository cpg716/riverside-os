-- Review requests belong only to native Riverside Transactions completed by
-- pickup/takeaway. Historical Counterpoint imports are reference records and
-- must never enter the customer review delivery queue.

CREATE OR REPLACE FUNCTION schedule_fulfilled_transaction_review_invite()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status::text = 'fulfilled'
       AND COALESCE(NEW.is_counterpoint_import, FALSE) = FALSE
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

CREATE OR REPLACE FUNCTION enforce_counterpoint_review_ineligibility()
RETURNS TRIGGER AS $$
BEGIN
    IF COALESCE(NEW.is_counterpoint_import, FALSE) = TRUE
       AND NEW.review_invite_sent_at IS NULL
       AND NEW.review_invite_suppressed_at IS NULL
       AND (
           NEW.podium_review_invite_status IS NOT NULL
           OR NEW.review_invite_scheduled_for IS NOT NULL
           OR NEW.review_invite_claimed_at IS NOT NULL
       )
    THEN
        NEW.review_invite_suppressed_at := NOW();
        NEW.review_invite_scheduled_for := NULL;
        NEW.review_invite_claimed_at := NULL;
        NEW.podium_review_invite_status := 'suppressed';
        NEW.podium_review_invite_id := COALESCE(
            NULLIF(BTRIM(NEW.podium_review_invite_id), ''),
            'ros_skipped_counterpoint_history'
        );
        NEW.review_invite_last_error :=
            'Historical Counterpoint imports are not eligible for Riverside review requests.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_enforce_counterpoint_review_ineligibility ON transactions;

CREATE TRIGGER trigger_enforce_counterpoint_review_ineligibility
    BEFORE INSERT OR UPDATE OF
        is_counterpoint_import,
        podium_review_invite_status,
        review_invite_scheduled_for,
        review_invite_claimed_at
    ON transactions
    FOR EACH ROW
    EXECUTE FUNCTION enforce_counterpoint_review_ineligibility();

UPDATE transactions
SET review_invite_suppressed_at = NOW(),
    review_invite_scheduled_for = NULL,
    review_invite_claimed_at = NULL,
    podium_review_invite_status = 'suppressed',
    podium_review_invite_id = COALESCE(
        NULLIF(BTRIM(podium_review_invite_id), ''),
        'ros_skipped_counterpoint_history'
    ),
    review_invite_last_error =
        'Historical Counterpoint imports are not eligible for Riverside review requests.'
WHERE COALESCE(is_counterpoint_import, FALSE) = TRUE
  AND review_invite_sent_at IS NULL
  AND review_invite_suppressed_at IS NULL
  AND (
      podium_review_invite_status IS NOT NULL
      OR review_invite_scheduled_for IS NOT NULL
      OR review_invite_claimed_at IS NOT NULL
  );

COMMENT ON FUNCTION schedule_fulfilled_transaction_review_invite() IS
    'Schedules review requests only for native Riverside fulfilled/picked-up/takeaway Transactions; historical Counterpoint imports are ineligible.';

COMMENT ON FUNCTION enforce_counterpoint_review_ineligibility() IS
    'Suppresses any unsent review queue state applied to a historical Counterpoint Transaction, including manual scheduling and retry paths.';
