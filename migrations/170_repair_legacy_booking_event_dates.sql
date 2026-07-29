-- Migration 141 backfilled initial booking events from transaction_lines.booked_at.
-- Some imported historical lines still carried the import timestamp, which moved
-- years of booked activity onto one reporting day. The parent Transaction's
-- booked_at is the authoritative source business timestamp for these legacy rows.
--
-- Preserve the incorrect timestamp in metadata before repairing both the event
-- and its source line. Native events and later staff amendments are not touched.
WITH repaired_events AS (
    UPDATE transaction_line_booking_events event
    SET
        booked_at = transaction.booked_at,
        metadata = COALESCE(event.metadata, '{}'::jsonb)
            || jsonb_build_object(
                'legacy_backfill_booked_at', event.booked_at,
                'booking_date_repaired_by',
                    '170_repair_legacy_booking_event_dates.sql'
            )
    FROM transactions transaction
    WHERE transaction.id = event.transaction_id
      AND event.event_kind = 'initial_booking'
      AND COALESCE(event.metadata->>'backfilled', 'false') = 'true'
      AND transaction.booked_at IS NOT NULL
      AND event.booked_at IS DISTINCT FROM transaction.booked_at
    RETURNING event.transaction_line_id, event.booked_at
)
UPDATE transaction_lines line
SET booked_at = repaired.booked_at
FROM repaired_events repaired
WHERE line.id = repaired.transaction_line_id
  AND line.booked_at IS DISTINCT FROM repaired.booked_at;
