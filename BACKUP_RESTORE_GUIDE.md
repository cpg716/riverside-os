# Database Management & Backups — Riverside OS

Riverside OS includes a robust database management system designed for data integrity, automated maintenance, and disaster recovery.

## Overview

The system manages backup/restore flows with two primary controls:
1. **`pg_dump`**: Creates consistent, compressed backups.
2. **Mandatory confirmation**: Backup creation, restore, and optimization require non-blocking `ConfirmationModal` approval (no browser-native dialogs).

Backups are stored locally in the configured backup directory and can be optionally encrypted, uploaded to cloud storage, and copied to additional machines or mounted drives. In v0.2.1+, the **Unified Engine** on the **Main Server PC** is the authoritative node responsible for running the background backup scheduler.

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
| `cloud_provider` | "s3" | Cloud destination: `s3`, `onedrive`, `google_drive`, or `dropbox`. |
| `cloud_root` | "" | Folder/root path inside the selected cloud provider. |
| `replication_targets` | `[]` | Local, external-drive, SMB/NAS, or synced-folder paths that receive verified backup copies. |
| `encryption_enabled` | `false` | When true, local and off-site snapshots are written as encrypted `.dump.enc` archives. |

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

Riverside supports two off-site patterns:

1. **Direct cloud upload** through OpenDAL.
2. **Verified filesystem replication** to mounted/synced folders such as OneDrive, Google Drive, Dropbox desktop folders, SMB shares, NAS paths, mapped Windows drives, or external drives.

For S3-compatible storage, save credentials in Settings or set:

```bash
BACKUP_S3_ACCESS_KEY="your-access-key"
BACKUP_S3_SECRET_KEY="your-secret-key"
```

For OneDrive, Google Drive, or Dropbox direct upload, save these credential-store values in Settings or set the equivalent environment variables:

```bash
BACKUP_CLOUD_ACCESS_TOKEN="short-lived-token"
BACKUP_CLOUD_REFRESH_TOKEN="long-lived-refresh-token"
BACKUP_CLOUD_CLIENT_ID="oauth-client-id"
BACKUP_CLOUD_CLIENT_SECRET="oauth-client-secret"
```

Access token alone can be used for short-lived tests. Production automation should use a refresh token plus client ID, and a client secret where the provider/app type requires it.

The system uses **OpenDAL** for cloud abstraction, ensuring compatibility with AWS S3, Cloudflare R2, Backblaze B2, MinIO, OneDrive, Google Drive, and Dropbox.

## Backup Archive Encryption

When **Encrypt Backup Archives** is enabled, snapshots are stored as `.dump.enc` files. The server encrypts the PostgreSQL custom dump with authenticated encryption before cloud upload or replication. Restore decrypts to a temporary local file, runs `pg_restore`, and removes the decrypted temporary file.

Production operators must preserve this key outside Git and outside the database:

```bash
RIVERSIDE_BACKUP_ENCRYPTION_KEY="at-least-32-characters"
```

Losing this key means encrypted backups cannot be restored. Rotate it only with an explicit backup/recovery plan: create a fresh backup under the new key, restore-drill it, and keep the old key until all old encrypted archives have aged out of retention.

## Maintenance & Integrity

- **Auto-Cleanup**: The server performs a non-blocking directory walk using `tokio::fs` to prune old files without impacting POS performance.
- **Transaction Safety**: All backups are consistent "point-in-time" snapshots thanks to PostgreSQL's native dump capabilities.
- **Size Monitoring**: Database and table size statistics are accessible via `GET /database/stats`.
- **Admin notifications** (notification bell): **Admin** staff receive inbox items when a **scheduled or manual local backup fails**, when **cloud upload fails** (if cloud sync is enabled), or when the **last successful local backup** is older than **`RIVERSIDE_BACKUP_OVERDUE_HOURS`** (default **30**; only while the store is not already in a “local backup failed” state). Outcomes are recorded in **`store_backup_health`** (migration **60**). Tapping a notification opens **Settings → Data & Backups**. See **`docs/PLAN_NOTIFICATION_CENTER.md`**, **`docs/NOTIFICATION_GENERATORS_AND_OPS.md`**, and **`DEVELOPER.md`** (env table). Other automated inbox items (QBO/weather health, PIN security digest, Counterpoint, etc.) use migration **61** and the same notification UI — see **`docs/NOTIFICATION_GENERATORS_AND_OPS.md`**.
- **Replication verification**: filesystem copies are written to a temp file, flushed, checked by size and SHA-256, then renamed into place. A failed copy records off-site backup failure health.
- **Restore drills**: run restores only against a non-production database unless an approved emergency window explicitly enables production restore.

> [!CAUTION]
> Restoring a backup is a destructive action. Ensure all registers are closed and no active transactions are in progress before initiating a restore.
