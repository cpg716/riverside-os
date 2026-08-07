# Native Insights: ROSIE and Governed Riverside Reports

Riverside OS uses a native reporting workspace instead of an embedded BI login or separate reporting service. Staff ask ROSIE for a report in plain language; ROSIE returns a constrained semantic report specification; the Rust API validates that specification against a fixed catalog and the signed-in staff member; the Riverside server executes a bounded read-only query against approved **`reporting.*`** views.

The browser and language model cannot submit SQL. Every query member and source column comes from static server mappings, the reporting transaction is read-only, and each query has a 20-second statement timeout. Application writes remain in established Riverside services.

## Request path

```text
Insights workspace
  -> POST /api/insights/reports/ask
  -> local Gemma report tool call
  -> Rust ReportSpec validation and Riverside RBAC
  -> static server-side dataset/member mapping
  -> read-only PostgreSQL reporting.* query
```

Follow-up prompts include the current validated report specification so staff can say “change this to recognized revenue” or “group by salesperson.” A direct period change uses **`POST /api/insights/reports/run`** with the existing specification and a replacement date range.

## Business semantics

Booked and recognized reporting are separate datasets. They are never implemented as a hidden toggle:

- **`booked_transactions`** and **`booked_items`** use the governed Transaction booking business date.
- **`recognized_transactions`** and **`recognized_items`** use the governed fulfillment or pickup recognition business date.

The remaining modeled datasets cover Fulfillment Orders, weddings, payments, inventory, loyalty customers, alterations, shipments, and daily sales with weather. The server catalog is authoritative for which measures, dimensions, filters, and time dimensions staff may request. Cost, profit, and margin members are marked Admin-only in the server catalog.

Update the Rust semantic catalog and its static query-member mapping together. Do not expose a member that bypasses the catalog validator or Riverside permissions.

## Favorites, history, and archive

Migration **`185_cube_insights_and_saved_reports.sql`** adds:

- **`insight_report_favorites`** — staff-owned, named, validated report definitions.
- **`insight_report_history`** — an automatic entry for every successful generation or rerun.

These tables store the question, validated specification, run metadata, and row count. They intentionally do not store result-row snapshots. Reopening an entry reruns the definition against current authoritative reporting data and updates **`last_accessed_at`**.

When history is listed, inactive entries older than **`history_archive_days`** are assigned **`archived_at`**. The default is **180 days** and Settings constrains it to 30–730 days. An archive entry can be restored or rerun. Favorites are not auto-archived.

## API routes

All routes are below **`/api/insights`** and require **`insights.view`** through the normal staff middleware.

| Route | Purpose |
|---|---|
| **`POST /reports/ask`** | Build, validate, run, and record a report from a natural-language question. |
| **`POST /reports/run`** | Validate and rerun an existing specification, optionally with a new date range or history ID. |
| **`GET /reports/favorites`** | List the signed-in staff member's favorites. |
| **`POST /reports/favorites`** | Save or replace a named validated favorite. |
| **`DELETE /reports/favorites/{id}`** | Delete the signed-in staff member's favorite. |
| **`GET /reports/history?archived=false`** | Auto-archive expired entries and list active or archived history. |
| **`POST /reports/history/{id}/archive`** | Archive a history entry. |
| **`POST /reports/history/{id}/restore`** | Restore a history entry and mark it accessed. |
| **`GET /semantic-catalog`** | Return the staff-visible governed datasets and members. |
| **`GET /health`** | Verify that the approved Riverside reporting views are installed and return staff guidance. |

The server accepts table, bar, line, area, and pie visualization kinds. Limits are clamped to the configured maximum; Settings allows 25–500 rows, with 500 as the default ceiling.

## Deployment

Native Insights ships inside the normal Riverside server and requires no extra container, login, shared API secret, reporting database password, port, or supervised service. The standard Main Hub migration/update path installs the reporting views and saved-report tables. Existing Riverside Staff Access and **`insights.view`** remain the only reporting authentication boundary.

Migration 185 originally provisioned a separate **`cube_ro`** role while the first native implementation evaluated a Cube sidecar. The embedded reporting engine does not use that role. The migration remains immutable for checksum compatibility; no new deployment credential should be created for it.

## Operations

- Staff-safe status: **`GET /api/insights/health`**.
- Settings: **Settings → Integrations → Insights** shows a simple ready/update-required status, maximum rows, archive age, and guidance shown in the Insights workspace.
- ROS Dev Center reports whether the approved reporting views are installed.
- If status is not ready, use the normal Riverside Main Hub update or repair process. Staff should never enter or manage a reporting secret.

## Export and print

The native workspace makes every successful result available as CSV and through Riverside's professional table print path. Printing includes the report title, period, generation time, basis explanation, and returned rows; the operating-system dialog can print to paper or PDF.

## Validation

When this system changes, run at minimum:

```bash
scripts/validate_migration_layout.sh
cargo fmt --all -- --check
cargo check -p riverside-server
npm run typecheck
npm run check:help-impact
docker compose config --quiet
```

Also run the targeted Rust tests for **`cube_insights`** and **`insights_config`**. Changes to the staff workflow require the Insights Help manual and staff guide to remain aligned.
