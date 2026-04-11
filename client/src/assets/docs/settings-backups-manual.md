# Data Lifecycle & Backups

Riverside OS includes an enterprise-grade backup and restoration system designed to ensure data integrity across local and cloud environments.

## 1. Local Snapshots
Snapshots are full PostgreSQL dumps stored in the `backups/` directory on the server.

### Automatic Backups:
*   **Cron Schedule**: Configurable via **System Control → Cloud Backups**. Default is `0 2 * * *` (2:00 AM daily).
*   **Retention**: The system automatically cleans up snapshots older than the configured "Retention Policy" (default: 30 days).

### Manual Trigger:
You can trigger an immediate backup via the **Manual Trigger** button. This is recommended before performing major catalog imports or schema updates.

## 2. Universal Docker Fallback
To ensure high availability, the Riverside server (v0.1.8+) implements a **Universal Docker Fallback** for database operations.

### How it works:
1.  **Direct Mode**: The server first attempts to use the host's `pg_dump` or `psql` binaries.
2.  **Fallback Mode**: If host binaries are missing or version-mismatched, the server automatically spawns a transient Docker container (`postgres:latest`) to execute the backup/restore command.
3.  **Zero-Configuration**: This ensures that backups work out-of-the-box on macOS, Linux, and Windows (assuming Docker/OrbStack is running), regardless of local Postgres installation state.

## 3. Restoration Procedure
Restoring a backup will **overwrite all current data** in the PostgreSQL database.

1.  Select a snapshot from the **Local Snapshots** table.
2.  Click the **Restore (Play)** icon.
3.  Confirm the action in the prompt.
4.  **Application Restart**: The application will automatically reload once the restore is complete to ensure all cached data is synchronized.

> [!CAUTION]
> Always perform a manual backup immediately before restoring an older snapshot. Restoration is an irreversible operation.
