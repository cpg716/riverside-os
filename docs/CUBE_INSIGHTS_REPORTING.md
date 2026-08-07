# Native Insights: ROSIE and Cube Core

Riverside OS uses a native reporting workspace instead of an embedded BI login. Staff ask ROSIE for a report in plain language; ROSIE returns a constrained semantic report specification; the Rust API validates that specification against a fixed catalog and the signed-in staff member; Cube Core executes the resulting read-only query against **`reporting.*`** views.

The browser and language model cannot submit SQL. Application writes remain in established Riverside services.

## Request path

```text
Insights workspace
  -> POST /api/insights/reports/ask
  -> local Gemma report tool call
  -> Rust ReportSpec validation and Riverside RBAC
  -> signed request to loopback Cube Core
  -> cube/model/cubes/riverside_insights.yml
  -> PostgreSQL reporting.* through cube_ro
```

Follow-up prompts include the current validated report specification so staff can say “change this to recognized revenue” or “group by salesperson.” A direct period change uses **`POST /api/insights/reports/run`** with the existing specification and a replacement date range.

## Business semantics

Booked and recognized reporting are separate datasets. They are never implemented as a hidden toggle:

- **`booked_transactions`** and **`booked_items`** use the governed Transaction booking business date.
- **`recognized_transactions`** and **`recognized_items`** use the governed fulfillment or pickup recognition business date.

The remaining modeled datasets cover Fulfillment Orders, weddings, payments, inventory, loyalty customers, alterations, shipments, and daily sales with weather. The server catalog is authoritative for which measures, dimensions, filters, and time dimensions staff may request. Cost, profit, and margin members are marked Admin-only in the server catalog.

Update the Cube model and the Rust semantic catalog together. Do not expose a Cube member that bypasses the catalog validator or Riverside permissions.

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
| **`GET /cube-health`** | Check the configured loopback Cube service without exposing secrets. |

The server accepts table, bar, line, area, and pie visualization kinds. Limits are clamped to the configured maximum; Settings allows 25–500 rows, with 500 as the default ceiling.

## Deployment

Root **`docker-compose.yml`** runs the pinned Cube image on **`127.0.0.1:4000`** and mounts **`cube/`** read-only. The public ROS service is the only supported staff-facing gateway. Do not expose Cube directly to the store network.

Set one long random shared secret in both places:

```text
root .env:    CUBEJS_API_SECRET=...
server/.env: RIVERSIDE_CUBE_API_SECRET=...
```

The Rust server uses **`RIVERSIDE_CUBE_UPSTREAM`** when set and otherwise uses **`http://127.0.0.1:4000`**.

Cube does not fall back to the application database owner. Set a password on the migration-provisioned role, then configure:

```text
RIVERSIDE_CUBE_REPORTING_DB_USER=cube_ro
RIVERSIDE_CUBE_REPORTING_DB_PASSWORD=...
```

Migration 185 creates or upgrades **`cube_ro`** as a login role when the migration owner is privileged, grants database connect plus read access to **`reporting.*`**, revokes access to **`public.*`**, and sets a 20-second statement timeout. Set the role password outside migrations. If migrations run without PostgreSQL role-management privileges, create the role as an administrator and rerun the grants.

The Windows Main Hub installer keeps migration-owned tables and views under the normal PostgreSQL app role. For migration 185 only, it grants the app role the required role-management authority inside the same database transaction, runs the migration with **`SET ROLE`**, and restores the app role's prior privileges before commit. A migration or cleanup failure rolls back both the schema work and the temporary authority.

## Operations

- Cube readiness: **`GET http://127.0.0.1:4000/readyz`** on the Main Hub.
- Staff-safe status: **`GET /api/insights/cube-health`**.
- Settings: **Settings → Integrations → Insights** shows secret/readiness status, maximum rows, archive age, and staff guidance.
- ROS Dev Center reports Cube upstream and secret readiness without returning either secret.

Changing a setting does not restart Cube. Restart or redeploy the Cube service only under the normal production-change process.

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
