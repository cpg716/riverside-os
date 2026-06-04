-- Notification Center search and fatigue-health support.

CREATE INDEX IF NOT EXISTS idx_app_notification_search_tsv
    ON app_notification
    USING GIN (
        to_tsvector(
            'simple',
            COALESCE(title, '') || ' ' ||
            COALESCE(body, '') || ' ' ||
            COALESCE(kind, '') || ' ' ||
            COALESCE(source, '')
        )
    );

CREATE INDEX IF NOT EXISTS idx_app_notification_deep_link_gin
    ON app_notification
    USING GIN (deep_link jsonb_path_ops);
