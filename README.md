# Riverside OS

**Riverside OS (ROS)** is a production-grade desktop ERM/POS platform for formalwear and wedding retail. Version 0.4.0 is the deployment-audit release candidate for the store rollout model: Backoffice / Server PC, Register #1 Windows Tauri, Register #2 iPad PWA, and Windows laptop PWA/optional Tauri clients. It keeps the v0.3 financial, inventory, staff, and UI hardening work while making deployment status and station setup explicit.

Current Version: **v0.4.0** (See [CHANGELOG.md](CHANGELOG.md))

## Stack

| Layer | Technology |
|---|---|
| API server | Rust · Axum 0.8 · sqlx · PostgreSQL |
| Frontend | React 19 · TypeScript · Tailwind CSS · Vite |
| Desktop shell | Tauri 2 |
| Architecture | **Unified Hybrid Model** (New in v0.2.1) — Embedding the backend engine in the desktop shell for one-click updates. |
| Logging / traces | `tracing` + `tracing-subscriber` (`RUST_LOG`); optional **OpenTelemetry OTLP** — [`docs/OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md`](docs/OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md) |
| Timezone | `chrono-tz` (IANA; configurable per store in receipt settings) |
| Money | `rust_decimal` only — no f32/f64 for currency anywhere |

## Runtime shell behavior

Riverside has one parent Back Office app shell with three embedded runtime shells:

- **POS shell** for Register, Dashboard, and mirrored POS workspaces
- **Wedding shell** for full Wedding Manager workflows
- **Insights shell** for embedded Metabase analytics

Current runtime contract:

- entering **POS**, **Weddings**, or **Insights** transfers shell ownership to that embedded shell
- while a valid shell is active, the app should stay in that shell until the user takes an explicit exit path
- child-shell tab changes must not silently bounce the user back to Back Office
- invalid shell state should fall back cleanly only when the owning shell is no longer valid

## Quick start

Local PostgreSQL is managed via **OrbStack** (recommended) or Docker Desktop. The **`db` service** in [`docker-compose.yml`](docker-compose.yml) is published on **`localhost:5433`** so it does not conflict with a system Postgres on **5432**. See [**`docs/ORBSTACK_GUIDE.md`**](docs/ORBSTACK_GUIDE.md) for setup and performance tuning.

The **`db` image** is **`pgvector/pgvector:pg16`** (PostgreSQL 16; image includes **pgvector**). If switching engines, run **`docker compose up -d --build`** to ensure a fresh build on the new optimization layer.

```bash
# 0. Install JS dependencies used by root scripts (dev:e2e, test:e2e:*, pack) and client scripts
npm install

# 1. Start Postgres (and optional Meilisearch sidecar on :7700) and apply migrations (from repo root; skips files already in ros_schema_migrations)
docker compose up -d
./scripts/apply-migrations-docker.sh
# Optional: ./scripts/migration-status-docker.sh  (ledger vs schema probes)
# Existing DB without ledger rows: ./scripts/backfill-migration-ledger-docker.sh then apply again

# 2. Server env: copy server/.env.example -> server/.env for local runs.
#    DATABASE_URL must point at localhost:5433 (the repo Docker Postgres), not localhost:5432.
#    If you expect automatic Metabase sign-in in local/RC runs, server/.env must also carry the
#    local RIVERSIDE_METABASE_* shared-auth values (or export them in your shell).
#
# 3. API server (http://127.0.0.1:3000) — from repo root, prefer npm (`dev-server.sh` / `cargo-server.sh` put Rust 1.88 first on PATH when Homebrew rustc shadows rustup):
npm run dev:server

# 4. Web client (http://localhost:5173)
cd client && npm install && npm run dev

# 5. Desktop (Tauri)
cd client && npm run tauri:dev
```

## Local Runtime Prerequisites (RC parity)

For this repo to behave the same way in a local RC worktree as it does in the validated release flow, the following are effectively required:

- Run **`npm install`** from the repo root. Root scripts such as **`npm run dev:e2e`**, **`npm run test:e2e:*`**, and **`npm run pack`** depend on root package binaries being present in this worktree.
- Run **`cd client && npm install`** for the Vite/Playwright client toolchain.
- Keep a real **`server/.env`** for local parity (copy from **`server/.env.example`**). The server can boot with fallbacks, but validated local behavior depends on that file.
- For local Docker Postgres, **`DATABASE_URL`** must use **`postgresql://postgres:password@localhost:5433/riverside_os`**.
- If you expect automatic Metabase login in local/RC runs, **`server/.env`** must also define the local **`RIVERSIDE_METABASE_ADMIN_*`** and **`RIVERSIDE_METABASE_STAFF_*`** shared-auth values.
- Expected local services and ports:
  - Postgres: **`localhost:5433`**
  - API: **`127.0.0.1:3000`**
  - Vite dev UI: **`localhost:5173`**
  - Deterministic E2E API/UI: **`127.0.0.1:43300`** / **`localhost:43173`**
  - Metabase: **`localhost:3001`**
  - Meilisearch when used: **`localhost:7700`**
- Expected local DB/application state:
  - **`store_settings`** row **`id = 1`**
  - seeded E2E staff accounts **`1234`** (Admin) and **`5678`** (non-Admin) for the release-focused browser/API suites
- **`npm run pack`** is expected to work directly from the repo root on a normal install; release validation should not rely on borrowed `node_modules` or symlinks from another checkout.

Environment variables:

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:password@localhost:5433/riverside_os` | Must match Docker `db` host port (**5433** avoids conflict with native Postgres on 5432; see `server/.env.example`) |
| `STRIPE_SECRET_KEY` | dummy | Stripe secret key for server payment calls. Local dev may use the dummy/test fallback; when **`RIVERSIDE_STRICT_PRODUCTION=true`**, startup requires a valid live **`sk_live_...`** key. |
| `STRIPE_PUBLIC_KEY` | unset | Stripe publishable key served by **`GET /api/payments/config`** for Elements/vaulting flows. Local dev may leave it unset; when **`RIVERSIDE_STRICT_PRODUCTION=true`**, startup requires a valid live **`pk_live_...`** key. |
| `STRIPE_WEBHOOK_SECRET` | unset | Optional Stripe webhook signing secret for **`POST /api/webhooks/stripe`** fee reconciliation. Startup warns when unset because reconciliation stays disabled; in strict production any configured value must look like **`whsec_...`**. |
| `QBO_TOKEN_ENC_KEY` | unset | Required before QBO credentials can be activated. Must be non-default and at least 32 characters; strict production startup refuses missing/default values. New QBO OAuth tokens are stored with authenticated `v2:` wrapping. |
| `RIVERSIDE_BACKUP_DIR` | `backups` | Local backup directory. Strict production requires this to be set to an absolute, durable path; Settings and ROS Dev Center show the effective path. |
| `VITE_API_BASE` | unset → same-origin in browser/PWA, else `http://127.0.0.1:3000` fallback for non-HTTP shells | API origin for client; set explicitly for production when UI and API are on different origins |
| `VITE_POS_OFFLINE_CARD_SIM` | _(unset)_ | When **`true`**, register **Credit Card** tender can open the **training** reader simulation if **`POST /api/payments/intent`** fails — **`docs/TRANSACTIONS_AND_WEDDING_ORDERS.md`** |
| `VITE_STOREFRONT_EMBEDS` | _(unset)_ | When **`true`**, loads **`GET /api/public/storefront-embeds`** once (Podium widget when configured) — public storefront builds only — **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`** |
| `VITE_PODIUM_OAUTH_REDIRECT_URI` | _(unset)_ | Optional. Override Podium OAuth callback URL (must match Podium app); default is **`${origin}/callback`** — **`client/.env.example`**, **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`** |
| `RIVERSIDE_PODIUM_CLIENT_ID` | _(unset)_ | Podium OAuth client id; pair with secret + refresh token — **`DEVELOPER.md`**, **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`** |
| `RIVERSIDE_PODIUM_CLIENT_SECRET` | _(unset)_ | Podium OAuth client secret (never log) |
| `RIVERSIDE_PODIUM_REFRESH_TOKEN` | _(unset)_ | Podium OAuth refresh token (never log) |
| `RIVERSIDE_PODIUM_OAUTH_TOKEN_URL` | _(unset)_ | Optional; defaults to **`{RIVERSIDE_PODIUM_API_BASE or https://api.podium.com}/oauth/token`** — **`DEVELOPER.md`**, **`server/.env.example`** |
| `RIVERSIDE_PODIUM_API_BASE` | _(unset)_ | Optional REST API origin (no trailing slash); default **`https://api.podium.com`** — **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`** |
| `RIVERSIDE_PODIUM_WEBHOOK_SECRET` | _(unset)_ | **`POST /api/webhooks/podium`** HMAC secret when set — **`server/.env.example`** |
| `RIVERSIDE_PODIUM_WEBHOOK_ALLOW_UNSIGNED` | _(unset)_ | Dev only: accept unsigned webhooks when secret unset — **`server/.env.example`** |
| `RIVERSIDE_PODIUM_INBOUND_DISABLED` | _(unset)_ | When truthy, **`POST /api/webhooks/podium`** skips CRM ingest (threads + notifications); idempotent webhook ledger still accepts deliveries — **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`** |
| `RUST_LOG` | `riverside_server=info,warn` | Structured log level |
| `OTEL_*` / `RIVERSIDE_OTEL_ENABLED` | _(unset)_ | Optional **OTLP** distributed traces — [`docs/OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md`](docs/OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md), [`server/.env.example`](server/.env.example) |
| `RIVERSIDE_MAX_BODY_BYTES` | _(unset)_ | Optional cap override for large **`POST /api/products/import`** bodies (`DEVELOPER.md`, **`docs/CATALOG_IMPORT.md`**) |
| `RIVERSIDE_VISUAL_CROSSING_API_KEY` | _(unset)_ | Optional; overrides DB weather key — see **`docs/WEATHER_VISUAL_CROSSING.md`**, **`server/.env.example`** |
| `RIVERSIDE_VISUAL_CROSSING_ENABLED` | _(unset)_ | Optional; force live weather on/off — see **`docs/WEATHER_VISUAL_CROSSING.md`** |
| `RIVERSIDE_MEILISEARCH_URL` | _(unset)_ | Optional; e.g. `http://127.0.0.1:7700` when **`docker compose`** **`meilisearch`** is up — enables fuzzy catalog/CRM/inventory/transaction search with SQL hydration + fallback — **`docs/SEARCH_AND_PAGINATION.md`**, **`server/.env.example`** |
| `RIVERSIDE_MEILISEARCH_API_KEY` | _(unset)_ | Optional; Meilisearch master/API key when the instance requires auth (match **`MEILI_MASTER_KEY`** in Compose for local dev) |
| `RIVERSIDE_METABASE_ADMIN_EMAIL` / `RIVERSIDE_METABASE_ADMIN_PASSWORD` | _(unset)_ | Optional local shared-auth credentials used by **`/api/insights/metabase-launch`** when JWT SSO is off. Put these in **`server/.env`** if you expect automatic Metabase sign-in for Admin staff in local/RC runs. |
| `RIVERSIDE_METABASE_STAFF_EMAIL` / `RIVERSIDE_METABASE_STAFF_PASSWORD` | _(unset)_ | Optional local shared-auth credentials used by **`/api/insights/metabase-launch`** when JWT SSO is off. Put these in **`server/.env`** if you expect automatic Metabase sign-in for staff-class Metabase sessions in local/RC runs. |
| `RIVERSIDE_LLAMA_UPSTREAM` | _(unset)_ | **Planned** (**ROSIE**): Axum BFF upstream for **`POST /api/help/rosie/v1/chat/completions`** — **`docs/PLAN_LOCAL_LLM_HELP.md`** § Ship decision |
| `VITE_ROSIE_LLM_DIRECT` / `VITE_ROSIE_LLM_HOST` / `VITE_ROSIE_LLM_PORT` | _(unset)_ | **Planned** (**ROSIE**): Tauri **direct** loopback vs **Axum** fallback — same doc; full table **`DEVELOPER.md`** |
| `RIVERSIDE_MORNING_DIGEST_HOUR_LOCAL` | `7` | Optional; local hour (0–23) for admin morning notification digest — **`DEVELOPER.md`**, **`docs/PLAN_NOTIFICATION_CENTER.md`** |

Production browser releases require **`RIVERSIDE_STRICT_PRODUCTION=true`** together with **`RIVERSIDE_CORS_ORIGINS`**, **`RIVERSIDE_STORE_CUSTOMER_JWT_SECRET`**, an explicit **`FRONTEND_DIST`**, a live **`STRIPE_SECRET_KEY`**, a live **`STRIPE_PUBLIC_KEY`**, an absolute **`RIVERSIDE_BACKUP_DIR`**, and a non-default **`QBO_TOKEN_ENC_KEY`** before QBO activation. Local development may use the permissive defaults, but RC/production signoff should treat those envs as mandatory. **`STRIPE_WEBHOOK_SECRET`** remains optional unless that deployment expects signed Stripe webhook reconciliation.

## Quality checks

Refer to **[`docs/CI_CD_AND_CODE_HYGIENE_STANDARDS.md`](docs/CI_CD_AND_CODE_HYGIENE_STANDARDS.md)** for detailed linting, hook stability, and GitHub CLI maintenance standards.

```bash
npm run check:server              # cargo check with Rust 1.88 (avoids Homebrew rustc shadowing rust-toolchain)
npm run bump <version>            # Cross-platform synchronize versions (JSON/TOML/README)
cd client && npm run lint        # ESLint check
cd client && npm run build       # tsc --noEmit + vite build
```

**Reporting routes:** when adding **GET** APIs used by **Insights**, **Metabase**, or other analytics surfaces, refresh **`docs/AI_REPORTING_DATA_CATALOG.md`** (hint: `python3 scripts/scan_axum_get_routes_hint.py`). **Pair that file** with **`docs/AI_CONTEXT_FOR_ASSISTANTS.md`** (routing, RBAC safety, Help vs reporting, **ROSIE** launch posture — **`docs/PLAN_LOCAL_LLM_HELP.md`**, **`ThingsBeforeLaunch.md`** § LLM). Booked vs recognition semantics: **[`docs/BOOKED_VS_FULFILLED.md`](docs/BOOKED_VS_FULFILLED.md)** and **`docs/REPORTING_BOOKED_AND_RECOGNITION.md`**. Layaway lifecycle: **[`docs/LAYAWAY_OPERATIONS.md`](docs/LAYAWAY_OPERATIONS.md)**. Ops model: **`docs/METABASE_REPORTING.md`**, **`docs/PLAN_METABASE_INSIGHTS_EMBED.md`**. Order and Wedding Order rules: **[`docs/TRANSACTIONS_AND_WEDDING_ORDERS.md`](docs/TRANSACTIONS_AND_WEDDING_ORDERS.md)**.

## E2E tests (Playwright)

```bash
# Root shortcuts (recommended)
npm run test:e2e:list
npm run test:e2e:release
npm run test:e2e:visual
npm run test:e2e:high-risk
npm run test:e2e:phase2
npm run test:e2e:tender
npm run test:e2e:v020

# Direct client commands
cd client
npm run test:e2e -- --list
E2E_BASE_URL="http://localhost:43173" E2E_API_BASE="http://127.0.0.1:43300" npm run test:e2e
E2E_BASE_URL="http://localhost:43173" E2E_API_BASE="http://127.0.0.1:43300" npx playwright test --workers=1
E2E_BASE_URL="http://localhost:43173" E2E_API_BASE="http://127.0.0.1:43300" npm run test:e2e:update-snapshots
```

> Use `npm run dev:e2e` for the local deterministic browser stack. It serves the UI on `http://localhost:43173` and the API on `http://127.0.0.1:43300` so release-gate runs do not collide with an ordinary `npm run dev` session on `5173/3000`. Use `localhost` for `E2E_BASE_URL` — `127.0.0.1` may fail browser tests. Full-suite CI-style runs: **`--workers=1`** (see **`docs/ROS_UI_CONSISTENCY_PLAN.md`** Phase 5).
> Root shortcuts like `npm run dev:e2e`, `npm run test:e2e:*`, and `npm run pack` require a real repo-root `npm install`; they should not depend on borrowed `node_modules` from another worktree.

Current CI note:

- The POS UI subset (`phase2-tender-ui`, `pos-golden`, `tax-exempt-and-stripe-branding`, and the UI-open path in `exchange-wizard`) is back in the release gate. The old `ROS_QUARANTINE_UNSTABLE_POS_E2E=1` quarantine has been removed after adding explicit POS readiness contracts.
- Production hardening coverage now includes checkout tender, tax, commission, inventory, offline recovery, register close, and QBO audit contracts. The latest local full release run on 2026-04-25 reported **181 passed, 7 skipped, 0 failed**.
- See [`docs/E2E_REGRESSION_MATRIX.md`](docs/E2E_REGRESSION_MATRIX.md), [`docs/POS_E2E_TESTABILITY_FOLLOWUP.md`](docs/POS_E2E_TESTABILITY_FOLLOWUP.md), and [`docs/PRODUCTION_DEPLOYMENT_GO_NO_GO_CHECKLIST.md`](docs/PRODUCTION_DEPLOYMENT_GO_NO_GO_CHECKLIST.md).

For complete pre-release validation (service boot order, lint/build gates, and E2E checklist), see **`docs/RELEASE_QA_CHECKLIST.md`**.

## Migrations

Apply via **`./scripts/apply-migrations-docker.sh`** (ledger in `migrations/00_ros_migration_ledger.sql`). Compare ledger vs schema: **`./scripts/migration-status-docker.sh`** (probes in **`scripts/ros_migration_build_probes.sql`**, maintained through the latest numbered file). Full table: **`DEVELOPER.md`**. Latest numbered files currently extend through **`163_dashboard_read_path_indexes.sql`** (see `migrations/`). Duplicate numeric prefixes exist in this repo, so migration comparisons must use full filenames, not just numeric ceilings. Feature migrations **51–52**: **`docs/PLAN_NOTIFICATION_CENTER.md`**; weather **46–48**: **`docs/WEATHER_VISUAL_CROSSING.md`**; ROS Dev Center v1 core schema: **149–150**.

| # | Highlights |
|---|------------|
| 28 | `customers.customer_code` (unique, required), profile fields |
| 117 | Inventory maintenance types |
| 123 | Reporting: Standardization of IDs and contact fields |
| 131 | Stripe Power Integration: Terminal, Vaulting, Credits |
| 135 | Schema Repair Baseline |
| 143 | **Reporting Stabilization: Transactions & Fulfillment Orders Core Views** |
| 149 | **ROS Dev Center v1** (ops telemetry, alerts, action audit, bug-incident links) |
| 150 | **Reporting order_lines margin restore** (`line_gross_margin_pre_tax`) + drift-safe probes |

### Data Provenance & Integrity
Riverside OS maintains a strict **Source of Truth** policy for Counterpoint integrations:
- **Calculation over Static Fields**: Customer **Lifetime Sales** are never pulled as a static value. They are calculated dynamically by aggregating all imported `transactions` with `booked_at >= '2018-01-01'`.
- **Current bridge default**: The shipped Counterpoint bridge now defaults **`CP_IMPORT_SINCE`** to **`2018-01-01`**. This is the accepted migration floor for historical Counterpoint data in ROS and should remain visible in bridge preflight unless operators are intentionally running a narrower rehearsal.
- **Greedy Open Docs**: The bridge captures ALL open documents (`PS_DOC`) regardless of date to ensure the non-takeaway backlog (Layaways/Quotes) is preserved.

| Path | Role | Audience |
|------|------|----------|
| `README.md` | Overview, quick start, migrations summary | Everyone |
| `CHANGELOG.md` | Detailed version history and release notes | Everyone |
| `DEVELOPER.md` | Architecture, API overview, migrations table, runbooks | Developers |
| `AGENTS.md` | Invariants, edit map, commands, migration cheat sheet | Agents / devs |
| `docs/TRANSACTIONS_AND_WEDDING_ORDERS.md` | Rules around non-takeaway fulfillment, deposit liabilities vs revenue, and reserving stock pending arrival. | Developers / ops |
| `docs/ORBSTACK_GUIDE.md` | Local Docker management, context switch, VirtioFS | Devs |
| `docs/STAFF_PERMISSIONS.md` | RBAC keys, middleware, client gating | Devs |
| `docs/ONLINE_STORE.md` | Public `/shop`, API, CMS, Studio editor | Devs / ops |
| `docs/SEARCH_AND_PAGINATION.md` | Search semantics, optional Meilisearch | Devs |
| `docs/COUNTERPOINT_SYNC_GUIDE.md` | Counterpoint one-time migration bridge, mapping, heartbeats, retirement path | Ops / devs |
| `docs/STAFF_SCHEDULE_XLSX_IMPORTER.md` | Staff Schedule Maker weekly grid + `.xlsx` import format and troubleshooting | Ops / devs |
| `docs/TRANSACTION_RETURNS_EXCHANGES.md` | Refunds, returns, exchanges | Devs |
| `docs/STAFF_TASKS_AND_REGISTER_SHIFT.md` | Checklists, tasks, register shift primary | Devs / ops |
| `docs/PLAN_BUG_REPORTS.md` | In-app bug report architecture and triage | Devs / ops |
| `docs/RECEIPT_BUILDER_AND_DELIVERY.md`| ZPL / Thermal templates and Podium delivery | Devs / ops |
| `docs/COMMISSION_AND_SPIFF_OPERATIONS.md` | Commission Manager, SPIFF rules, and combo rewards | Ops / devs |
| `docs/SHIPPING_AND_SHIPMENTS_HUB.md` | Shippo, Registry, and Hub operations | Devs / ops |
| `docs/WISEPOS_E_SETUP_STRIPE.md` | Stripe Terminal WisePOS E reset and server-driven flow | Ops / devs |
| `docs/CLIENT_UI_CONVENTIONS.md` | React primitives, modal a11y, shell wiring | Devs / agents |
| `docs/CUSTOMER_HUB_AND_RBAC.md` | Joint accounts, financial redirection, CRM RBAC | Devs / ops |
| `docs/UNIFIED_ENGINE_AND_HOST_MODE.md` | **Unified Hybrid Architecture** (v0.2.1+), Host Mode, and updates | Everyone |
| `docs/DEPLOYMENT_GUIDE_V0_2_1.md` | Installation and production setup for the Unified Model | Ops / Devs |
| `docs/ROS_DEV_CENTER.md` | ROS Dev Center architecture, API contracts, operations, and hardening model | Devs / ops |
| `INVENTORY_GUIDE.md` | Scanning engine, physical inventory sessions | Ops / devs |
| `BACKUP_RESTORE_GUIDE.md` | Maintenance, backups, cloud sync | Ops |
| `Riverside_OS_Master_Specification.md` | Product requirements and vocabulary | Product / devs |
| `docs/RETIRED_DOCUMENT_SUMMARIES.md` | Ledger of removed docs | Maintainers |
| `docs/INTELLIGENCE_LAYER_GUIDE.md` | Proactive risk & replenishment engines (logic, UI, API) | Developers / ops |
| `docs/PLAN_POST_V0.1.2_EVOLUTION.md` | Strategic growth (MTM Center, Alteration Forecast) | Product / Devs |
| `docs/CASH_ROUNDING_OPERATIONS.md` | Swedish Rounding rules, cash checkout logic, and QBO mapping | Ops / devs |
| `client/src/assets/docs/lockout-manual.md` | Restoration steps for locked-out staff and admins | Everyone |

## Command Summary

```bash
# General validation
npm run lint
npm run check:server
cd client && npm run build

# Playwright E2E
cd client && npm run test:e2e
```
