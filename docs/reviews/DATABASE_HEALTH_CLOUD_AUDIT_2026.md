# Audit Report: Database, Health & Cloud Infrastructure
**Date:** 2026-04-08
**Status:** High-Availability / Self-Healing
**Auditor:** Antigravity

## 1. Executive Summary
Riverside OS treats the database not just as a storage engine, but as an active participant in system health. The infrastructure combines PostgreSQL's transactional rigors with automated backup workers, cloud-tier synchronization, and real-time integrity monitoring.

## 2. Database & Schema Management

### 2.1 Evolutionary Schema (Migrations)
- **Scale**: The system currently runs on **111 coordinated migrations**, ensuring that schema evolution is deterministic and reproducible across all developer and production instances.
- **Integrity Guards**: Migrations include constraints and triggers that enforce business logic at the storage tier (e.g., `Migration 38` for checkout idempotency).

### 2.2 Connection Management
- **Axum Integration**: The system uses `PgPoolOptions` for connection pooling. 
- **Self-Diagnostics**: At startup (`main.rs:53`), the system runs a connection diagnostic to verify PostgreSQL version and connectivity before the server accepts its first request.

## 3. High-Reliability Backup Strategy

### 3.1 Tiered Backup Worker (`start_backup_worker`)
The system runs a background "Guardian" worker that manages three critical tasks:
1. **Local Dumps**: Uses `pg_dump` with custom binary format (`-F c`) for compressed, high-fidelity archives.
2. **Cloud Tiering (S3/R2)**: Uses the `opendal` abstraction to sync local dumps to cloud buckets. This supports Amazon S3, Cloudflare R2, and Backblaze B2 interchangeably via environment variables.
3. **Auto-Cleanup**: A retention service automatically purges local and cloud-staged dumps (default 30 days) to prevent disk exhaustion.

### 3.2 Health Observability (`store_backup_health`)
- **Success/Failure Tracking**: Every backup attempt (local or cloud) is recorded with a timestamp and status.
- **Error Capturing**: On failure, the system captures and clips the specific CLI error from `pg_dump` or `pg_restore`, storing it in the health table for staff triage via the notification center.

## 4. Cloud Integration & Real-time Sync
- **External Bridge Persistence**: Background workers handle token-refresh for cloud services like QuickBooks Online (QBO), ensuring that the financial Cloud Bridge never "stalls" due to expired OAuth credentials.
- **Real-time Event Bus**: The system uses a specialized `WeddingEventBus` (SSE) to push database-driven changes to all frontend clients without requiring manual refreshes.

## 5. Findings & Recommendations
1. **Infrastructure Maturity**: The decision to use `pg_dump -F c` (binary format) instead of plain SQL for backups is a significant technical win, as it allows for much safer and faster restorations.
2. **Cloud Versatility**: The `opendal` implementation provides excellent "Cloud Neutrality," allowing the store to switch storage providers in seconds without any code changes.
3. **Observation**: The current `main.rs` connection pool is set to `max_connections(5)`. **Recommendation**: For high-traffic retail environments, this should be scaled up to 20-50 based on the underlying hardware to handle peak POS traffic during holiday rushes.

## 6. Conclusion
The Riverside OS Database & Cloud subsystem is **exceptionally robust**. It prioritizes data safety and system uptime through multiple layers of automated maintenance and cloud-tier redundancy.
