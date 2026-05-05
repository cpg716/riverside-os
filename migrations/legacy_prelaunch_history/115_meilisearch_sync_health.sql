-- Meilisearch Sync Health Tracking
CREATE TABLE meilisearch_sync_status (
    index_name TEXT PRIMARY KEY,
    last_success_at TIMESTAMPTZ,
    last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    row_count BIGINT DEFAULT 0,
    is_success BOOLEAN NOT NULL DEFAULT FALSE,
    error_message TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Initial rows for all current indices
INSERT INTO meilisearch_sync_status (index_name) VALUES 
('ros_variants'),
('ros_store_products'),
('ros_customers'),
('ros_wedding_parties'),
('ros_orders'),
('ros_help'),
('ros_staff'),
('ros_vendors'),
('ros_categories'),
('ros_appointments'),
('ros_tasks')
ON CONFLICT DO NOTHING;
