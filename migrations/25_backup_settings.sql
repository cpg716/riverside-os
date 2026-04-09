-- Migration 25: Add Database Backup & Cloud Sync settings to store_settings
-- This allows configuring schedules, retention, and S3-compatible cloud storage.

ALTER TABLE store_settings 
ADD COLUMN IF NOT EXISTS backup_settings JSONB NOT NULL DEFAULT '{
    "auto_cleanup_days": 30,
    "schedule_cron": "0 2 * * *",
    "cloud_storage_enabled": false,
    "cloud_bucket_name": "",
    "cloud_region": "us-east-1",
    "cloud_endpoint": ""
}'::jsonb;
