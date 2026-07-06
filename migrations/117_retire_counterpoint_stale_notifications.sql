-- Counterpoint import/sync is a one-time transition operation. Retire stale
-- sync notifications and close any already-open stale ops alerts so staff do
-- not get recurring noise after the import is complete.

UPDATE public.ops_alert_event
SET
    status = 'resolved',
    resolved_at = COALESCE(resolved_at, now()),
    last_seen_at = now()
WHERE rule_key = 'counterpoint_sync_stale'
  AND status IN ('open', 'acked');

UPDATE public.ops_alert_rule
SET enabled = false
WHERE rule_key = 'counterpoint_sync_stale';

DELETE FROM public.app_notification
WHERE kind IN ('counterpoint_alerts_bundle', 'counterpoint_sync_error', 'counterpoint_sync_stale')
   OR dedupe_key LIKE 'counterpoint_alerts_bundle:%';

INSERT INTO ros_schema_migrations (version) VALUES ('117_retire_counterpoint_stale_notifications.sql')
ON CONFLICT (version) DO NOTHING;
