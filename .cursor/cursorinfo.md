# Cursor project info — Riverside OS

This file orients **Cursor** (and similar tools) to the active application in this workspace.

## Primary application

- **Backend**: `server/` — Rust crate `riverside-server`, Axum (listens `0.0.0.0:3000` by default; clients often use `127.0.0.1:3000` in dev)
- **Frontend**: `client/` — React 19 + Vite + Tailwind + Tauri 2
- **Database**: PostgreSQL 16 in Docker (`docker compose` service `db`); host **`localhost:5433`** → container **5432** (avoids native Postgres on **5432**). `DATABASE_URL` in `server/.env` must use **5433**. Apply DDL via `./scripts/apply-migrations-docker.sh`; ledger + probes via `./scripts/migration-status-docker.sh`. Numbered files **00–106**, see `DEVELOPER.md`
- **Spec**: `Riverside_OS_Master_Specification.md` (domain vocabulary and product requirements)

## Documentation map

Full table (path, role, audience): **`README.md`** § **Documentation catalog**. Retired files: **`docs/RETIRED_DOCUMENT_SUMMARIES.md`**.

| Doc | Purpose |
|-----|---------|
| `README.md` | Overview, quick start, doc catalog |
| `DEVELOPER.md` | Architecture, API surface, migration table, runbooks |
| `AGENTS.md` | Agent invariants, where to edit, commands |
| `docs/STAFF_PERMISSIONS.md` | Staff RBAC: permission keys, migration 34, middleware, Staff API, `BackofficeAuthContext` |
| `docs/STORE_DEPLOYMENT_GUIDE.md` | Production topology, hardware, builds |
| `docs/LOCAL_UPDATE_PROTOCOL.md` | Offline / no-GitHub version upgrades |
| `REMOTE_ACCESS_GUIDE.md` | Tailscale, TLS, PWA |
| `BACKUP_RESTORE_GUIDE.md` | Backups, restore, cloud sync |
| `docs/PWA_AND_REGISTER_DEPLOYMENT_TASKS.md` | PWA + Tauri shipping checklist |
| `docs/OFFLINE_OPERATIONAL_PLAYBOOK.md` | Offline behavior, floor procedure |
| `INVENTORY_GUIDE.md` | Scanning, physical inventory |
| `docs/AI_INTEGRATION_OUTLOOK.md` | AI product intent (not a build spec) |
| `ROS_AI_INTEGRATION_PLAN.md` | AI implementation roadmap (technical) |
| `docs/APPOINTMENTS_AND_CALENDAR.md` | Store vs WM calendar, `wedding_appointments`, migration 33, `weddingApi` |
| `docs/CATALOG_IMPORT.md` | `POST /api/products/import`, Lightspeed vs universal CSV, body limits, vendor / `vendor_code`, migration 35 |
| `docs/WEATHER_VISUAL_CROSSING.md` | Visual Crossing, `weather_config` (46), EOD finalize (47), daily pull cap (48), public `/api/weather/*`, env **`RIVERSIDE_VISUAL_CROSSING_API_KEY`** / **`RIVERSIDE_VISUAL_CROSSING_ENABLED`** |
| `docs/PLAN_NOTIFICATION_CENTER.md` | Shipped: notification inbox (51), admin morning digest + **`track_low_stock`** (52), **`task_due_soon`** hourly reminders (56), env **`RIVERSIDE_MORNING_DIGEST_HOUR_LOCAL`** |
| `docs/NOTIFICATION_GENERATORS_AND_OPS.md` | Migrations **60–61**, generator env vars, integration/PIN security ops, code map, deep links |
| `docs/STAFF_TASKS_AND_REGISTER_SHIFT.md` | Recurring checklists, **`shift_primary_staff_id`**, **`register.shift_handoff`**, **`/api/tasks/*`** — migrations **55–56** |
| `docs/STAFF_SCHEDULE_AND_CALENDAR.md` | **`staff_effective_working_day`**, **`/api/staff/schedule`**, **`morning-compass.today_floor_staff`** — **57–58** |
| `docs/REGISTER_DASHBOARD.md` | POS **Dashboard** tab, **`/api/staff/self/register-metrics`**, **`weddings.view`** on compass/feed, notification **archive** |
| `docs/TILL_GROUP_AND_REGISTER_OPEN.md` | Lanes (**66**), **`till_close_group_id`** / combined Z (**67**), admin open flow, BO register gate |
| `docs/POS_PARKED_SALES_AND_RMS_CHARGES.md` | Migration **68**: server parked cart, Z-close purge, **`pos_rms_charge_record`**, **`rms_r2s_charge`**, **`GET /api/insights/rms-charges`**, **`VITE_POS_OFFLINE_CARD_SIM`** |
| `docs/ORDERS_RETURNS_EXCHANGES.md` | Refunds, line returns, exchange link, `orders.*` RBAC, migrations 36–37 |
| `docs/SEARCH_AND_PAGINATION.md` | Customer browse/search + inventory control-board; optional Meilisearch; POS/CRM/appointments, `/shop` PLP, admin reindex |
| `docs/CUSTOMERS_LIGHTSPEED_REFERENCE.md` | Customer CRM vs Lightspeed X-Series (merge, groups, bulk, reporting) |
| `docs/CUSTOMER_HUB_AND_RBAC.md` | Relationship Hub routes ↔ **`customers.hub_view`**, **`hub_edit`**, **`timeline`**, **`measurements`**, **`orders.view`** (migrations **63**–**64**) |
| `docs/WEDDING_GROUP_PAY_AND_RETURNS.md` | Wedding disbursements, returns |
| `docs/QBO_JOURNAL_TEST_MATRIX.md` | QBO journal test matrix |
| `docs/SUIT_OUTFIT_COMPONENT_SWAP_AND_QBO.md` | Suit component swap, migration 50 |
| `docs/PRODUCT_ROADMAP_MENS_WEDDING_RETAIL.md` | Men’s / wedding retail roadmap notes |
| `docs/PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md` | Master tracker: Shippo + Podium CRM + notifications + reviews (shipped / partial / deferred) |
| `docs/PLAN_PODIUM_SMS_INTEGRATION.md` | Podium SMS (**70–71**) + two-way CRM (**99**+); deep spec — pair with master plan above; **`docs/PODIUM_STOREFRONT_CSP_AND_PRIVACY.md`** |
| `docs/PLAN_BUG_REPORTS.md` | **Shipped:** **`staff_bug_report`** + snapshots/triage (**101**–**103**), **`POST /api/bug-reports`**, Settings → Bug reports (**`settings.admin`**) |
| `docs/OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md` | **`tracing`**, optional OTLP, bug-report ring, HTTP **`TraceLayer`**, env vars |
| `docs/PLAN_SHIPPO_SHIPPING.md` | **Partial:** rates, shipments hub, label purchase — **`docs/SHIPPING_AND_SHIPMENTS_HUB.md`**; roadmap (webhooks, web checkout binding) in plan |
| `docs/PLAN_ONLINE_STORE_MODULE.md` | **Partial:** public **`/shop`**, cart, CMS — **`docs/ONLINE_STORE.md`**; roadmap (Stripe checkout, ship-to paid orders) in plan |
| `docs/PLAN_CONSTANT_CONTACT_INTEGRATION.md` | Future: Constant Contact |
| `.cursorrules` | Strict coding rules (must follow on every change) |
| `docs/CLIENT_UI_CONVENTIONS.md` | Client primitives, `useDialogAccessibility`, lazy `App.tsx`, Wedding Manager embed; see `client/UI_WORKSPACE_INVENTORY.md` |
| `docs/ROS_UI_CONSISTENCY_PLAN.md` | Staff/POS/WM token + theme alignment; **Phases 1–5** complete (2026-04-08); Phase 5 = build, Playwright, visual snapshots, **`RegisterSessionBootstrap`** session-id gate |
| `.cursor/cursorinfo.md` | This file — quick index |

## Large non-app directories (do not treat as ROS source)

- `NexoPOS-master/`, `odoo-19.0/`, `riverside-wedding-manager/` — **not** in the default checkout (root **`.gitignore`**); clone upstream only when a task needs legacy comparison.

## Router / API entry

- `server/src/api/mod.rs` — `build_router()` nests `/api/*` modules (includes `/api/weather`, `/api/hardware` for reporting context and server-side thermal print dispatch)
- `server/src/main.rs` — **`init_tracing_with_optional_otel`** (optional OTLP + fmt + **`ServerLogRing`**), **`TraceLayer`**, CORS, **`with_state`**, `serve`, **`shutdown_tracer_provider`**
- `server/src/observability/` — **`otel.rs`**, **`server_log_ring.rs`** — **`docs/OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md`**

## UI entry

- `docs/CLIENT_UI_CONVENTIONS.md` — where to document or look up tab density, lazy imports, modal a11y, Wedding Manager button `type` rules
- `client/src/App.tsx` — tabs, shell backdrop, global search drawers; **`RegisterSessionBootstrap`** (under **`BackofficeAuthProvider`**) hydrates **`GET /api/sessions/current`** with **`mergedPosStaffHeaders`**. It applies **`applyShellForLoggedInRole`** (e.g. admin → Operations) **only when the open register `session_id` changes**, so Back Office tabs (QBO, Staff, etc.) are not reset on every poll. See **`docs/ROS_UI_CONSISTENCY_PLAN.md`** Phase 5. Back Office **Customers** passes `setActiveSubSection` as `onNavigateSubSection` for add-customer slideout ↔ sidebar sync
- `client/src/components/customers/CustomersWorkspace.tsx` — customer browse (scrollable list card pattern), `DetailDrawer` add flow, Lightspeed import confirm
- `client/src/components/scheduler/` — **Appointments** tab (store calendar); `client/src/lib/weddingApi.ts` for `searchCustomers(q, opts?)` + appointment CRUD (snake_case payloads)

## Current schema version

**Recent migrations:** **59** — **`store_settings.staff_sop_markdown`** + **`GET /api/staff/store-sop`**. **60–61** — backup health timestamps + integration/PIN notification support — **`docs/NOTIFICATION_GENERATORS_AND_OPS.md`**, **`docs/PLAN_NOTIFICATION_CENTER.md`**, **`BACKUP_RESTORE_GUIDE.md`**. **57–58** — staff schedule + SQL comments — **`docs/STAFF_SCHEDULE_AND_CALENDAR.md`**. **55–56** — register shift primary + staff recurring tasks + **`task_due_soon`** — **`docs/STAFF_TASKS_AND_REGISTER_SHIFT.md`**. **51–53** — notification center + **`morning_digest_ledger`** / low-stock catalog flags (**`docs/PLAN_NOTIFICATION_CENTER.md`**, **`INVENTORY_GUIDE.md`**); **53** default admin bootstrap (**`AGENTS.md`**). **46–48** — Visual Crossing **`weather_config`**, EOD snapshot ledger, **`weather_vc_daily_usage`** pull counter; optional env overrides — **`docs/WEATHER_VISUAL_CROSSING.md`**. **38–39** — **`pos_api_token`**, **`checkout_client_id`**, extended RBAC seeds (**`docs/STAFF_PERMISSIONS.md`**). **36–37** — `orders.*` seeds, returns (**`docs/ORDERS_RETURNS_EXCHANGES.md`**). **35** — `vendors.vendor_code` (**`docs/CATALOG_IMPORT.md`**). **34** — staff RBAC. **33** — appointments (**`docs/APPOINTMENTS_AND_CALENDAR.md`**). **62** — AI platform (pgvector, **`ai_doc_chunk`** + **`embedding`**, saved reports, duplicate review — **`DEVELOPER.md`**, **`ROS_AI_INTEGRATION_PLAN.md`**, **`docs/ROS_AI_HELP_CORPUS.md`**). **63** — Customer Relationship Hub RBAC — **`docs/CUSTOMER_HUB_AND_RBAC.md`**. **64** — **`salesperson`** / **`sales_support`**: **`customers_duplicate_review`**, **`customers.merge`**. **65** — **`pg_trgm`** + **`ai_doc_chunk`** (hybrid help retrieval). **66–67** — register lanes + till close group / combined Z — **`docs/TILL_GROUP_AND_REGISTER_OPEN.md`**. **68** — parked sales + RMS charge ledger + **`rms_r2s_charge`** — **`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`**. **98**–**103** — Shippo rate ref on shipment, Podium CRM/reviews schema + RBAC, **`review_policy`**, **`staff_bug_report`** + triage/retention (**`docs/PLAN_BUG_REPORTS.md`**). Full list: **`DEVELOPER.md`**.

## Key invariants for every edit

- **Money**: `rust_decimal::Decimal` only — never `f32`/`f64`
- **Handlers thin**: tax/commission math lives in `server/src/logic/`
- **Logging**: `tracing::error!` / `tracing::warn!` — no `eprintln!`
- **Auth**: no dev bypasses; admin middleware and PIN verification are always enforced
- **Transactions**: multi-step mutations always use `db.begin()` + `tx.commit()`
- **Special orders**: checkout does NOT decrement `stock_on_hand`; PO receipt increments `reserved_stock`; pickup decrements both

When suggesting refactors, keep **handlers thin** and **money in `rust_decimal`** per `.cursorrules`.
