-- Resolve false-positive workstation offline alerts from ordinary browser-tab heartbeats.
-- Tauri desktop and standalone PWA stations set meta.monitor_offline=true and remain monitored.

UPDATE ops_alert_event a
SET
    status = 'resolved',
    resolved_at = COALESCE(a.resolved_at, NOW()),
    resolved_by_staff_id = NULL,
    updated_at = NOW()
FROM ops_station_heartbeat s
WHERE a.rule_key = 'station_offline'
  AND a.status IN ('open', 'acked')
  AND a.dedupe_key = 'station_offline:' || s.station_key
  AND LOWER(COALESCE(s.meta->>'monitor_offline', 'false')) <> 'true';

UPDATE staff_error_event e
SET status = 'complete'
WHERE e.event_source = 'server_ops_alert'
  AND e.status = 'pending'
  AND COALESCE(e.client_meta->>'rule_key', '') = 'station_offline'
  AND EXISTS (
      SELECT 1
      FROM ops_alert_event a
      LEFT JOIN ops_station_heartbeat s
        ON a.dedupe_key = 'station_offline:' || s.station_key
      WHERE a.id::text = e.client_meta->>'ops_alert_id'
        AND a.rule_key = 'station_offline'
        AND LOWER(COALESCE(s.meta->>'monitor_offline', 'false')) <> 'true'
  );
