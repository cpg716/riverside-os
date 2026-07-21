-- Counterpoint financial repairs update existing imported lines; they are not new sales.
-- Preserve the event rows for auditability, but keep them out of Booked Sales.
UPDATE transaction_line_booking_events e
SET metadata = COALESCE(e.metadata, '{}'::jsonb)
    || jsonb_build_object('reporting_excluded', 'counterpoint_financial_repair')
FROM transactions t
WHERE e.transaction_id = t.id
  AND e.event_kind = 'line_amendment'
  AND e.booked_at >= TIMESTAMPTZ '2026-07-21 00:00:00-04'
  AND e.booked_at < TIMESTAMPTZ '2026-07-22 00:00:00-04'
  AND COALESCE(t.is_counterpoint_import, FALSE)
  AND t.metadata->>'counterpoint_financial_repair' IS NOT NULL
  AND COALESCE(e.metadata->>'reporting_excluded', '') IS DISTINCT FROM 'counterpoint_financial_repair';

DROP TRIGGER IF EXISTS transaction_line_booking_event_trigger ON transaction_lines;
CREATE TRIGGER transaction_line_booking_event_trigger
AFTER INSERT OR UPDATE OR DELETE ON transaction_lines
FOR EACH ROW
WHEN (current_setting('riverside.suppress_booking_event', true) IS DISTINCT FROM 'true')
EXECUTE FUNCTION record_transaction_line_booking_event();
