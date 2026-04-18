# Database Management & Backups — Riverside OS

Riverside OS includes a robust database management system designed for data integrity, automated maintenance, and disaster recovery.

## Overview

The system manages backup/restore flows with two primary controls:
1. **`pg_dump`**: Creates consistent, compressed backups.
2. **Mandatory confirmation**: Backup creation, restore, and optimization require non-blocking `ConfirmationModal` approval (no browser-native dialogs).

Backups are stored locally in the `backups/` directory and can be optionally synced to S3-compatible cloud storage. In v0.2.1+, the **Unified Engine** on the **Main Server PC** is the authoritative node responsible for running the background backup scheduler.

## Backup Settings

Backup behavior is controlled via the `store_settings` table (JSONB `backup_settings` field).

| Setting | Default | Description |
|---------|---------|-------------|
| `auto_cleanup_days` | 30 | Backups older than this are automatically deleted to save disk space. |
| `schedule_cron` | `0 2 * * *` | Cron schedule for the automatic backup task (default 2 AM). |
| `cloud_storage_enabled` | `false` | When true, successful local backups are uploaded to the cloud. |
| `cloud_bucket_name` | "" | S3-compatible bucket name. |
| `cloud_region` | "us-east-1" | S3 region. |
| `cloud_endpoint` | "" | Custom endpoint (e.g., DigitalOcean Spaces or MinIO). |

## Manual Operations (Server API)

The backend provides several endpoints for management (`/api/settings/...`):

- **List Backups**: `GET /backups` — Returns filename, size, and creation time.
- **Create Backup**: `POST /backups/create` — Triggers an immediate `pg_dump`.
- **Restore**: `POST /backups/restore/:filename` — **WARNING**: This drops and replaces the current database state.
- **Download**: `GET /backups/download/:filename` — Download a binary dump file for off-site storage.
- **Optimize**: `POST /database/optimize` — Runs `VACUUM ANALYZE` to reclaim space and update query planner stats.

### ROS Dev Center guarded backup action

For authorized admins, **Settings → ROS Dev Center** exposes guarded action key `backup.trigger_local`, which invokes the same backup manager path with mandatory dual confirmation and immutable action audit logging.

## Cloud Sync Setup

To enable cloud backups, you must set the following environment variables on the server:

```bash
BACKUP_S3_ACCESS_KEY="your-access-key"
BACKUP_S3_SECRET_KEY="your-secret-key"
```

The system uses **OpenDAL** for cloud abstraction, ensuring high performance and compatibility with AWS S3, DigitalOcean Spaces, Backblaze B2, and generic S3-compatible endpoints.

## Maintenance & Integrity

- **Auto-Cleanup**: The server performs a non-blocking directory walk using `tokio::fs` to prune old files without impacting POS performance.
- **Transaction Safety**: All backups are consistent "point-in-time" snapshots thanks to PostgreSQL's native dump capabilities.
- **Size Monitoring**: Database and table size statistics are accessible via `GET /database/stats`.
- **Admin notifications** (notification bell): **Admin** staff receive inbox items when a **scheduled or manual local backup fails**, when **cloud upload fails** (if cloud sync is enabled), or when the **last successful local backup** is older than **`RIVERSIDE_BACKUP_OVERDUE_HOURS`** (default **30**; only while the store is not already in a “local backup failed” state). Outcomes are recorded in **`store_backup_health`** (migration **60**). Tapping a notification opens **Settings → Data & Backups**. See **`docs/PLAN_NOTIFICATION_CENTER.md`**, **`docs/NOTIFICATION_GENERATORS_AND_OPS.md`**, and **`DEVELOPER.md`** (env table). Other automated inbox items (QBO/weather health, PIN security digest, Counterpoint, etc.) use migration **61** and the same notification UI — see **`docs/NOTIFICATION_GENERATORS_AND_OPS.md`**.

> [!CAUTION]
> Restoring a backup is a destructive action. Ensure all registers are closed and no active transactions are in progress before initiating a restore.
