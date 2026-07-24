# Backup System Verification Report

**Updated:** 2026-07-24
**Version:** v0.95.0 source candidate
**Status:** Implementation contract validated locally; production backup proof pending

## Summary

This document describes the backup safety contract implemented by the v0.95.0 source candidate. Local unit, migration, and compilation checks validate the code paths, but they do not prove that the production Main Hub has created a current backup, retained its key, uploaded an off-site copy, or completed a restore drill. Production readiness requires the exact artifact checks listed below.

## Automated Backup System

**Location:** `server/src/launcher.rs` - `start_backup_worker()`

**Implementation:**
- Uses `tokio-cron-scheduler` for a minute-level backup checker
- Default daily schedule expression: `0 2 * * *` (2:00 AM daily)
- Runs every minute to check whether the configured daily HH:MM backup time matches current local time
- Loads backup settings from `store_settings.backup_settings` JSONB field
- Performs automatic cleanup of old backups (default 30 days retention)
- Records catalog-verified success evidence separately from scheduler/failure timestamps in `store_backup_health`
- Supports cloud sync and replication targets if configured

**Safety Features:**
- Heartbeat monitoring via `WorkerHealth::mark_heartbeat("backup")`
- Error logging with detailed context
- Automatic retry on next scheduled run if failed

**Source Status:** Implemented and locally validated. Confirm the scheduled worker and current verified artifact on the production Main Hub.

## Manual Backup System

**Location:** `server/src/api/settings.rs` - `create_backup()`

**Implementation:**
- REST endpoint: `POST /api/settings/backups/create`
- Requires `SETTINGS_ADMIN` permission
- Loads backup settings from database
- Creates immediate backup using `BackupManager::create_backup_with_settings()`
- Uses `RIVERSIDE_BACKUP_DATABASE_URL` for complete-schema PostgreSQL access when configured; the Main Hub installer derives it from the protected PostgreSQL administrator configuration
- Records the verified archive timestamp, final filename, verification method, byte length, and SHA-256 in `store_backup_health`
- Automatically triggers cloud sync and replication if configured

**Safety Features:**
- Permission-based access control
- Error handling with detailed logging
- Health status tracking
- Optional cloud upload with bounded-memory size and SHA-256 read-back verification
- Fails closed instead of excluding schemas that the configured backup connection cannot read

**Source Status:** Implemented and locally validated. The 2026-07-24 production exercise confirmed the installed server still used the limited application connection and failed on `ros_repair_backup`; a fixed Main Hub installation and a newly verified artifact are still required.

## Backup Restore System

**Location:** `server/src/api/settings.rs` - `restore_backup()`

**Implementation:**
- REST endpoint: `POST /api/settings/backups/restore/{filename}`
- Requires `SETTINGS_ADMIN` permission
- Multi-stage validation before restore:
  1. Confirmation filename matching
  2. Environment validation (live production restore is always unavailable; live non-production drills require explicit enablement)
  3. Register session blocker (no open registers allowed)
  4. Catalog membership verification (backup must exist in local catalog)
  5. Pre-restore backup creation (automatic safety snapshot)

**Safety Features:**
- **Confirmation Required:** User must type exact backup filename to confirm
- **Production Lock:** Strict production cannot be unlocked for live restore; `RIVERSIDE_ALLOW_LIVE_RESTORE=true` is non-production-drill only
- **Register Blocker:** Prevents restore if any register sessions are open
- **Pre-Restore Backup:** Automatically creates a verified backup with the effective encryption/replication settings before a drill restore attempt
- **Atomic Replay + Validation:** `pg_restore --single-transaction` prevents partial archive replay; the packaged server validates its schema contract in-process without repository scripts
- **Encryption Support:** Handles encrypted backup archives with key validation

**Source Status:** Implemented and locally validated. Restore must be proven only through an approved non-production drill.

The repository restore drill compares the complete migration ledger (including stored migration checksums) and core table counts between source and restored databases. It does not pin a historical migration number, so the proof remains valid as append-only migrations advance.

## Backup Manager Core

**Location:** `server/src/logic/backups.rs`

**Key Functions:**
- `create_backup()` - Creates a uniquely named PostgreSQL custom-format dump through a non-catalog partial file
- `create_backup_with_settings()` - Verifies the archive catalog, atomically publishes it, and applies configured bounded-memory encryption
- `restore_backup()` - Restores from backup file with pre/post SQL
- `list_backups()` - Lists available backup files
- `perform_auto_cleanup()` - Removes backups older than retention period
- `sync_to_cloud()` - Streams fixed-size buffers to configured OpenDAL cloud storage, reads the finalized object back in bounded chunks, and accepts it only when its byte length and SHA-256 match the uploaded stream
- `replicate_to_targets()` - Copies to local/external filesystem targets

**Supported Destinations:**
- Local filesystem (primary)
- S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO)
- OneDrive
- Google Drive
- Dropbox
- SMB/NAS shares
- External drives

**Encryption:**
- New archives use versioned `ROSBAK2` ChaCha20-Poly1305 encryption with independently authenticated 1 MiB chunks and a unique 64-bit random archive nonce prefix
- Existing `ROSBAK1` archives remain readable for restore compatibility; create a new backup before relying on readiness proof
- 32-character minimum key requirement
- `.dump.enc` file extension for encrypted archives
- Key stored in `RIVERSIDE_BACKUP_ENCRYPTION_KEY` environment variable

**Source Status:** Implemented and locally validated. Encryption-key custody and destination access remain production operational checks.

## Health Monitoring

**Location:** `server/src/logic/backups.rs` & `server/src/logic/notifications_jobs.rs`

**Health Tracking:**
- `store_backup_health` records legacy scheduler outcomes separately from catalog-verified local evidence
- Tracks: verified timestamp/final filename/method/size/SHA-256, read-back-verified cloud backup time, and failure states
- Readiness rechecks that the exact recorded local file still exists, matches its stored size and SHA-256, has a valid archive header, and can use the configured encryption key. Deleting or retention-cleaning that file clears its evidence in the same serialized operation.
- Backup downloads and cloud uploads stream fixed-size buffers instead of loading the complete archive into server memory.
- Admin notifications sent when:
  - Scheduled/manual local backup fails
  - Cloud upload fails (if enabled)
  - No catalog-verified backup exists or the last verified backup is older than `RIVERSIDE_BACKUP_OVERDUE_HOURS` (default 30)

**Source Status:** Implemented and locally validated. Production readiness must still expose a current matching artifact and healthy worker.

## Recommendations for Production

1. **Environment Variables:**
   - Set `RIVERSIDE_BACKUP_DIR` to a dedicated backup directory
   - Set `RIVERSIDE_BACKUP_ENCRYPTION_KEY` for encrypted backups (32+ chars)
   - Configure cloud storage credentials if using off-site backup
   - Set `RIVERSIDE_BACKUP_OVERDUE_HOURS` for alert threshold

2. **Backup Settings:**
   - Configure `schedule_cron` as `minute hour * * *`; full cron semantics are not supported by the backup checker
   - Set `auto_cleanup_days` for retention policy
   - Enable `cloud_storage_enabled` for off-site redundancy
   - Configure `replication_targets` for local filesystem copies

3. **Testing:**
   - Perform periodic restore drills on non-production database
   - Verify cloud storage credentials and connectivity
   - Test encryption key rotation procedure
   - Validate replication target paths and permissions

4. **Monitoring:**
   - Monitor `store_backup_health` table for failure states
   - Review admin notifications for backup alerts
   - Check backup directory for expected file count and sizes
   - Verify cloud storage for successful uploads

## Current Verification Boundary

The source candidate implements scheduled and manual backups, guarded non-production restore drills, cloud and filesystem replication, authenticated encryption, health monitoring, and explicit failure handling. It must not be described as a verified production backup until all of the following are observed on the Main Hub:

1. `/api/ready` identifies the exact installed build and a current local backup artifact.
2. The recorded filename, byte length, SHA-256, archive catalog, and encryption-key check match the file still present on disk.
3. Any configured off-site object has passed the post-upload size and SHA-256 read-back check; any filesystem replica has passed its local SHA-256 check.
4. Backup-worker heartbeats and failure notifications are current.
5. An approved non-production restore drill completes with schema validation.

Until those checks pass, backup capability exists in source but production recoverability remains unverified. No backup design can honestly guarantee zero data-loss risk.
