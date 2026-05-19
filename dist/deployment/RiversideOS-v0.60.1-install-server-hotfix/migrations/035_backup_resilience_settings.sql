-- Backup resilience settings: archive encryption and verified replication targets.

ALTER TABLE public.store_settings
    ALTER COLUMN backup_settings SET DEFAULT '{
        "auto_cleanup_days": 30,
        "schedule_cron": "0 2 * * *",
        "cloud_storage_enabled": false,
        "cloud_bucket_name": "",
        "cloud_region": "us-east-1",
        "cloud_endpoint": "",
        "cloud_provider": "s3",
        "cloud_root": "",
        "replication_targets": [],
        "encryption_enabled": false
    }'::jsonb;

UPDATE public.store_settings
SET backup_settings = '{
        "auto_cleanup_days": 30,
        "schedule_cron": "0 2 * * *",
        "cloud_storage_enabled": false,
        "cloud_bucket_name": "",
        "cloud_region": "us-east-1",
        "cloud_endpoint": "",
        "cloud_provider": "s3",
        "cloud_root": "",
        "replication_targets": [],
        "encryption_enabled": false
    }'::jsonb || COALESCE(backup_settings, '{}'::jsonb);
