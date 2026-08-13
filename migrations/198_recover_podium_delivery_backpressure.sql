-- Recover Podium work that was terminally failed by the corrected contact SQL
-- or by the prior review worker treating provider backpressure as a delivery error.

UPDATE podium_webhook_delivery
SET processing_status = 'pending',
    processing_attempts = 0,
    next_attempt_at = NOW(),
    claimed_at = NULL,
    processed_at = NULL,
    last_error = 'Requeued after Riverside customer contact processing correction.'
WHERE processing_status = 'failed'
  AND last_error LIKE '%column "updated_at" of relation "customers" does not exist%';

UPDATE transactions
SET podium_review_invite_status = 'scheduled',
    review_invite_scheduled_for = NOW(),
    review_invite_claimed_at = NULL,
    review_invite_attempts = 0,
    review_invite_last_error = 'Requeued after Podium rate-limit handling correction.'
WHERE podium_review_invite_status = 'failed'
  AND review_invite_sent_at IS NULL
  AND review_invite_suppressed_at IS NULL
  AND review_invite_last_error ILIKE '%HTTP 429%';
