# ROS Dev Center

ROS Dev Center is Riverside OS's operational command center for developers/admins.

In v1 (v0.2.1), it is shipped as an embedded Back Office workspace at **Settings → ROS Dev Center**. It provides centralized ops visibility and guarded maintenance actions while keeping ROS Bug Manager as the source of truth.

---

## Purpose

- Track system health (API/DB + key integrations).
- Consolidate owner-facing readiness answers for daily opening and production/go-live certification.
- Monitor all register workstations as a fleet.
- Surface and triage operational alerts with acknowledgement state.
- Execute sensitive maintenance actions through audited guardrails.
- Correlate Bug Manager reports with operational incidents.

---

## Access model

- `ops.dev_center.view`: required for all read surfaces.
- `ops.dev_center.actions`: required for guarded mutations.
- Default role seed (migration 149):
1. `admin` = allowed
2. `salesperson` = denied
3. `sales_support` = denied

All guarded mutations require both:
1. Dual confirmation flags (`confirm_primary=true` and `confirm_secondary=true`)
2. A non-empty `reason` string (max 500 chars)

Every guarded action writes an immutable row to `ops_action_audit`.

---

## Current architecture (v1)

- Client UI:
1. `client/src/components/settings/RosDevCenterPanel.tsx`
2. mounted under `SettingsWorkspace` subsection `ros-dev-center`

- API:
1. `server/src/api/ops.rs`
2. mounted under `/api/ops/*`

- Domain logic:
1. `server/src/logic/ops_dev_center.rs`

- Persistence:
1. migration `149_ros_dev_center_v1.sql`
2. reporting follow-up: migration `150_reporting_order_lines_margin_restore.sql`

- Standalone Companion App (macOS):
1. Client UI and native shell: `ros-dev/`
2. Key tools: Native keychain storage, high-performance subnet/Tailscale discovery sweep, ROSIE Gemma LLM local integration.
3. Status Alignment: Implements the identical WowDash styling and 4 health status pillars (Integrations, Updates, POS, Back Office) matching the primary client app.
4. Native Tailscale CORS Bypass: Queries the local API CGNAT endpoint natively from the Rust backend (`check_tailscale_status`) to prevent browser-engine CORS blocks in WebViews.
5. Connectivity Logs & Heartbeat: Supports manual triggers for active probe checks (`POST /api/ops/audit-probes`) and tracks state transition logs in real-time.

---

## Security & Performance Hardening (v0.80.0+)

To ensure maximum operational security and performance, the Dev Center includes three specific hardening components:

### 1. Keychain Integration
Staff Access PINs (`staffCode`) are no longer serialized to plaintext `localStorage` on disk.
* **Storage Provider**: Native macOS/OS Keychain via the Rust `keyring` crate.
* **Service Name**: `com.riverside.ros-dev-center`.
* **Flow**: Plaintext credentials are deleted from `localStorage` immediately during initialization. When profile editing or selection happens, the app fetches and stores the PIN dynamically in system memory using Tauri commands.

### 2. High-Performance Subnet & Tailscale Discovery
Instead of using slow, serial, or resource-heavy Javascript fetch loops, server discovery is delegated to a concurrent native Rust sweep.
* **Concurrency**: Powered by `tokio::task::JoinSet`.
* **Guardrails**: Limits maximum concurrent connections to `40` via a semaphore to avoid system socket starvation.
* **Method**: Resolves local subnet prefix and queries local Tailscale status (`100.100.100.100:8080/localapi/v0/status`). Sweeps open ports (port `3000`), verifies the server is a valid Riverside OS instance via `GET /api/health`, and returns results sorted by latency.

### 3. Local & Tailscale Route Shielding
To prevent administration routes from being exposed to the internet, all `/api/ops/*` routes are protected on the Axum server.
* **Shielding Middleware**: `ops_shield_middleware` parses the request's origin IP address from the `X-Forwarded-For` header or TCP connection info extensions (`ConnectInfo<SocketAddr>` / `SocketAddr`).
* **Permitted Networks**: Requests are rejected with a `403 Forbidden` unless the source IP address lies in:
  - Loopback (`127.0.0.1`, `::1`)
  - RFC 1918 Private space (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)
  - Tailscale IP space (`100.64.0.0/10` IPv4, and `fd7a:115c:a1e0::/48` IPv6)

---

## API contracts

Base path: `/api/ops`

### Read endpoints (`ops.dev_center.view`)

- `GET /health/snapshot`
- `GET /overview` (alias of `health/snapshot`)
- `GET /integrations`
- `GET /runtime-diagnostics`
- `GET /stations`
- `GET /alerts`
- `GET /audit-log`
- `GET /bugs/overview`

### Runtime diagnostics surface

The Dev Center also includes a read-only **Runtime Diagnostics** section for developer/admin visibility.

Current signals:
- resolved client API base
- environment mode (`Development` vs `Strict production`)
- Helcim config state, including API token readiness and Register #1/#2 terminal-code readiness
- Shippo mode
- Metabase auth mode
- search mode
- weather mode
- backup directory mode
- station lifecycle governance

Current labels:
- **Helcim**: `Configured`, `Partial`, `Not configured`
- **Shippo**: `Disabled`, `Live rates`, `Stub fallback`, `Stub mode`
- **Metabase auth**: `JWT SSO`, `Shared auth`, `Fallback login`
- **Search**: `Live search`, `Bundled fallback`
- **Weather**: `Live weather`, `Mock weather`
- **Station lifecycle**: configured offline alert window and heartbeat retention window

The panel is intentionally safe:
- no secrets are returned
- no mutations are triggered
- the client-only API base is computed in the browser; the rest comes from `/api/ops/runtime-diagnostics`

### Owner Readiness tab

The embedded Operations Center includes a read-only **Readiness** tab. It does not create a second Operations Center and does not replace deployment, backup, QBO, Counterpoint, Help Center, or staff pilot signoff evidence.

The tab answers two owner-facing questions:
- **Daily Open Readiness:** whether Riverside OS can safely open and operate today.
- **Go-Live / Production Certification:** whether this environment is certified for production rollout, a major release, or a new Register # station.

Readiness reuses existing runtime signals where available:
- `/api/ops/health/snapshot`
- `/api/ops/stations`
- `/api/ops/alerts`
- `/api/ops/runtime-diagnostics`
- existing Helcim, Counterpoint, bug-report, and integration health endpoints already loaded by `RosOperationsCenter`

Where a required check has no authoritative runtime source, it is shown as **Manual signoff required** instead of being marked ready. Examples include QBO/accounting signoff, hardware stress evidence, backup restore drill proof, Help Center freshness, and staff pilot/go-no-go approval.

Manual signoffs are persisted in `ops_readiness_signoffs` and are guarded by `ops.dev_center.actions`. A current signoff can only upgrade checks that are explicitly manual; it cannot override automated blocked/warning checks from payments, stations, alerts, Counterpoint, or database health.

The tab can navigate to source tabs, copy the current diagnostics snapshot, and record manager-reviewed manual signoff evidence. It does not perform payments, inventory posting, accounting posting, deployment actions, or destructive maintenance.

Related operator-visible fallback surfaces:
- **Insights** shows an inline warning when automatic Metabase sign-in falls back to the normal Metabase login page.
- **Help Center** shows local/manual fallback messaging when bundled search is being used instead of live search.
- **Operations** and the **Register dashboard** show a `Mock Weather` badge and short note when weather data is coming from mock mode.

### Mutation endpoints (`ops.dev_center.actions` unless noted)

- `POST /alerts/ack`
  - body: `{ "alert_id": "<uuid>" }`

- `POST /actions/{action_key}`
  - body: `{ "reason": "...", "payload": { ... }, "confirm_primary": true, "confirm_secondary": true }`

- `POST /bugs/link-alert`
  - body: `{ "bug_report_id": "<uuid>", "alert_event_id": "<uuid>", "note": "..." }`

- `POST /stations/heartbeat` (authenticated staff headers; not `ops.dev_center.actions`)
  - body: station telemetry payload (see below)

---

## Station fleet telemetry

Heartbeat writes/upserts `ops_station_heartbeat` with canonical key `station_key`.

Current heartbeat producer:
- `client/src/context/BackofficeAuthContext.tsx` (every 60s while signed in)

Payload fields:
- `station_key`, `station_label`, `app_version`
- optional: `git_sha`, `tailscale_node`, `lan_ip`
- optional update fields: `last_sync_at`, `last_update_check_at`, `last_update_install_at`
- `meta` JSON

Fleet online/offline status is derived from recency cutoffs in server logic (`last_seen_at`).

Lifecycle semantics:
- `online`: heartbeat inside the online cutoff.
- `actionable offline`: missed heartbeat inside the offline alert window. These stations count as offline in health snapshots and can open `station_offline` alerts.
- `stale history`: missed heartbeat beyond the offline alert window. These rows remain available for governance until retention cleanup, but they do not flood active alert triage.

Fleet retention:
- `GET /stations` shows station heartbeat rows inside the configured retention window.
- Daily ops retention cleanup runs at 03:30 server time.
- Cleanup resolves stale `station_offline` alerts tied to deleted station keys before deleting stale heartbeat rows.
- Default actionable offline alert window is **24 hours**.
- Override with `RIVERSIDE_OPS_STATION_OFFLINE_ALERT_HOURS` (clamped 1-168).
- Default station heartbeat retention is **30 days**.
- Override with `RIVERSIDE_OPS_STATION_RETENTION_DAYS` (clamped 1-365).

---

## Guarded actions (current allow-list)

As of v0.70.5, allowed action keys are:

1. `backup.trigger_local`
2. `help.reindex_search`
3. `help.generate_manifest`
4. `ops.retention_cleanup`
5. `ops.restart_background_workers`
6. `ops.flush_cache`
7. `ops.clear_logs`

Unknown keys are rejected and API returns the current allow-list.

`backup.trigger_local` writes to the effective `RIVERSIDE_BACKUP_DIR` location using the same backup settings as the scheduler, including encrypted archives when enabled. Runtime Diagnostics exposes the backup directory path and flags whether the host is using an explicit production-safe path or the local development fallback.

`ops.retention_cleanup` applies the configured station and resolved-alert retention windows. It is guarded and audited like other Dev Center mutations.

`ops.restart_background_workers` logs re-initialization details and registers a signal to restart running background worker loops and job queues.

`ops.flush_cache` connects to the Redis server and flushes all keys from the cache database using the Redis `FLUSHDB` command.

`ops.clear_logs` empties all formatted tracing lines stored in the in-memory `ServerLogRing` diagnostics buffer.

---

## Alert model

Alert rules are configured in `ops_alert_rule` and emitted as `ops_alert_event` rows.

Lifecycle states:
1. `open`
2. `acked`
3. `resolved`

Alert delivery attempts are logged in `ops_notification_delivery_log` with channel and status.

Alert retention:
- `open` and `acked` alerts are active operational state and are not purged by age.
- `resolved` alerts are retained by default for **180 days**, then deleted by ops retention cleanup.
- Resolved alerts linked to bug reports are preserved so Bug Manager incident history does not lose context.
- Override with `RIVERSIDE_OPS_RESOLVED_ALERT_RETENTION_DAYS` (clamped 7-3650).

Seeded rule keys (migration 149):
- `integration_qbo_failure`
- `integration_weather_failure`
- `backup_overdue`
- `station_offline`

`counterpoint_sync_stale` is retired. Counterpoint import is a one-time go-live workflow, so stale sync state belongs in import proof/exception review before sign-off rather than recurring ops alerts.

---

## Bug Manager integration

Bug reports remain canonical in existing ROS bug tables/APIs.

Dev Center adds operational overlay only:
- `ops_bug_incident_link` joins bug reports to alert incidents.
- `/api/ops/bugs/overview` returns bug-centric triage data with incident linkage counts.
- Newly opened ops alerts are also mirrored into `staff_error_event` with source `server_ops_alert`, so **Settings → Bug reports → Error events** can package the server-side issue for Codex repair work without requiring a staff member to manually file a report.
- Core ops API failures are mirrored as `server_api_error` events when the database is still reachable; if the database itself is unavailable, the server can log the failure but cannot persist a bug-system row until database service is restored.

This keeps Bug Manager source-of-truth intact while adding ops correlation context.

---

## Database objects (migration 149)

- `ops_station_heartbeat`
- `ops_alert_rule`
- `ops_alert_event`
- `ops_action_audit`
- `ops_notification_delivery_log`
- `ops_bug_incident_link`

Migration discipline:
- add new migrations for schema changes
- keep `scripts/ros_migration_build_probes.sql` aligned to latest migration number
- verify with `./scripts/migration-status-docker.sh`

---

## Operational guidance

- Do not run guarded actions during peak sales windows.
- Require reason text that explains operational intent, not generic placeholders.
- Use Dev Center for platform operations, not transactional POS decisions.
- Keep audit trails immutable; never introduce silent mutation paths.

---

## Related docs

- `docs/STAFF_PERMISSIONS.md`
- `docs/PLAN_BUG_REPORTS.md`
- `docs/PLAN_NOTIFICATION_CENTER.md`
- `docs/HARDWARE_MANAGEMENT.md`
- `docs/STORE_DEPLOYMENT_GUIDE.md`
- `docs/UNIFIED_ENGINE_AND_HOST_MODE.md`
