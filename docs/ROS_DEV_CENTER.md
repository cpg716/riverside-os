# ROS Dev Center

ROS Dev Center is Riverside OS's operational command center for developers/admins.

In v1 (v0.2.1), it is shipped as an embedded Back Office workspace at **Settings → ROS Dev Center**. It provides centralized ops visibility and guarded maintenance actions while keeping ROS Bug Manager as the source of truth.

---

## Purpose

- Track system health (API/DB + key integrations).
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
- Stripe config state
- Shippo mode
- Metabase auth mode
- search mode
- weather mode

Current labels:
- **Stripe**: `Configured`, `Partial`, `Not configured`
- **Shippo**: `Disabled`, `Live rates`, `Stub fallback`, `Stub mode`
- **Metabase auth**: `JWT SSO`, `Shared auth`, `Fallback login`
- **Search**: `Live search`, `Bundled fallback`
- **Weather**: `Live weather`, `Mock weather`

The panel is intentionally safe:
- no secrets are returned
- no mutations are triggered
- the client-only API base is computed in the browser; the rest comes from `/api/ops/runtime-diagnostics`

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

Fleet online/offline status is derived from a recency cutoff in server logic (`last_seen_at`).

---

## Guarded actions (current allow-list)

As of v0.2.1, allowed action keys are:

1. `backup.trigger_local`
2. `help.reindex_search`
3. `help.generate_manifest`

Unknown keys are rejected and API returns the current allow-list.

`backup.trigger_local` writes to the effective `RIVERSIDE_BACKUP_DIR` location. Runtime Diagnostics exposes the backup directory path and flags whether the host is using an explicit production-safe path or the local development fallback.

---

## Alert model

Alert rules are configured in `ops_alert_rule` and emitted as `ops_alert_event` rows.

Lifecycle states:
1. `open`
2. `acked`
3. `resolved`

Alert delivery attempts are logged in `ops_notification_delivery_log` with channel and status.

Seeded rule keys (migration 149):
- `integration_qbo_failure`
- `integration_weather_failure`
- `backup_overdue`
- `counterpoint_sync_stale`
- `station_offline`

---

## Bug Manager integration

Bug reports remain canonical in existing ROS bug tables/APIs.

Dev Center adds operational overlay only:
- `ops_bug_incident_link` joins bug reports to alert incidents.
- `/api/ops/bugs/overview` returns bug-centric triage data with incident linkage counts.

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
- `docs/DEPLOYMENT_GUIDE_V0_2_1.md`
- `docs/UNIFIED_ENGINE_AND_HOST_MODE.md`
