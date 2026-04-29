-- ROS Dev Center retention indexes for station and resolved-alert cleanup.

CREATE INDEX IF NOT EXISTS idx_ops_alert_event_resolved_retention
    ON ops_alert_event (resolved_at, updated_at, last_seen_at)
    WHERE status = 'resolved';

CREATE INDEX IF NOT EXISTS idx_ops_alert_event_station_offline_dedupe
    ON ops_alert_event (dedupe_key)
    WHERE rule_key = 'station_offline'
      AND status IN ('open', 'acked');
