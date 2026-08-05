-- Audit probe runs originally opened one alert per run. Current code uses the
-- stable audit_probe:current key, so preserve the newest legacy alert as that
-- current alert and resolve the older duplicate rows.
WITH latest_legacy AS (
    SELECT id
    FROM ops_alert_event
    WHERE rule_key = 'audit_probe_failure'
      AND status IN ('open', 'acked')
      AND dedupe_key LIKE 'audit_probe:run:%'
      AND NOT EXISTS (
          SELECT 1
          FROM ops_alert_event current_alert
          WHERE current_alert.dedupe_key = 'audit_probe:current'
      )
    ORDER BY last_seen_at DESC, created_at DESC
    LIMIT 1
)
UPDATE ops_alert_event alert
SET dedupe_key = 'audit_probe:current',
    updated_at = CURRENT_TIMESTAMP
FROM latest_legacy
WHERE alert.id = latest_legacy.id;

UPDATE ops_alert_event
SET status = 'resolved',
    resolved_at = COALESCE(resolved_at, CURRENT_TIMESTAMP),
    updated_at = CURRENT_TIMESTAMP
WHERE rule_key = 'audit_probe_failure'
  AND status IN ('open', 'acked')
  AND dedupe_key LIKE 'audit_probe:run:%';
