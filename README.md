# Riverside OS

**Riverside OS (ROS)** is a production-grade desktop ERM/POS platform for formalwear and wedding retail. It bundles a full-feature POS, inventory management, wedding-party workflow, CRM, commission accounting, and QuickBooks Online bridge into a single Tauri 2 desktop application.

Current Version: **v0.1.9** (See [CHANGELOG.md](CHANGELOG.md))

## Stack

| Layer | Technology |
|---|---|
| API server | Rust · Axum 0.8 · sqlx · PostgreSQL |
| Frontend | React 19 · TypeScript · Tailwind CSS · Vite |
| Desktop shell | Tauri 2 |
| Logging / traces | `tracing` + `tracing-subscriber` (`RUST_LOG`); optional **OpenTelemetry OTLP** — [`docs/OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md`](docs/OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md) |
| Timezone | `chrono-tz` (IANA; configurable per store in receipt settings) |
| Money | `rust_decimal` only — no f32/f64 for currency anywhere |

## Quick start

Local PostgreSQL is managed via **OrbStack** (recommended) or Docker Desktop. The **`db` service** in [`docker-compose.yml`](docker-compose.yml) is published on **`localhost:5433`** so it does not conflict with a system Postgres on **5432**. See [**`docs/ORBSTACK_GUIDE.md`**](docs/ORBSTACK_GUIDE.md) for setup and performance tuning.

The **`db` image** is **`pgvector/pgvector:pg16`** (PostgreSQL 16; image includes **pgvector**). If switching engines, run **`docker compose up -d --build`** to ensure a fresh build on the new optimization layer.

```bash
# 1. Start Postgres (and optional Meilisearch sidecar on :7700) and apply migrations (from repo root; skips files already in ros_schema_migrations)
docker compose up -d
./scripts/apply-migrations-docker.sh
# Optional: ./scripts/migration-status-docker.sh  (ledger vs schema probes)
# Existing DB without ledger rows: ./scripts/backfill-migration-ledger-docker.sh then apply again

# 2. API server (http://127.0.0.1:3000) — from repo root, prefer npm (`dev-server.sh` / `cargo-server.sh` put Rust 1.88 first on PATH when Homebrew rustc shadows rustup):
npm run dev:server

# 3. Web client (http://localhost:5173)
cd client && npm install && npm run dev

# 4. Desktop (Tauri)
cd client && npm run tauri:dev
```

Environment variables:

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:password@localhost:5433/riverside_os` | Must match Docker `db` host port (**5433** avoids conflict with native Postgres on 5432; see `server/.env.example`) |
| `STRIPE_SECRET_KEY` | dummy | Stripe client |
| `VITE_API_BASE` | `http://127.0.0.1:3000` | API origin for client |
| `VITE_POS_OFFLINE_CARD_SIM` | _(unset)_ | When **`true`**, register **Credit Card** tender can open the **training** reader simulation if **`POST /api/payments/intent`** fails — **`docs/ORDERS_AND_WEDDING_ORDERS.md`** |
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
| `RIVERSIDE_MEILISEARCH_URL` | _(unset)_ | Optional; e.g. `http://127.0.0.1:7700` when **`docker compose`** **`meilisearch`** is up — enables fuzzy catalog/CRM/inventory/order search with SQL hydration + fallback — **`docs/SEARCH_AND_PAGINATION.md`**, **`server/.env.example`** |
| `RIVERSIDE_MEILISEARCH_API_KEY` | _(unset)_ | Optional; Meilisearch master/API key when the instance requires auth (match **`MEILI_MASTER_KEY`** in Compose for local dev) |
| `RIVERSIDE_LLAMA_UPSTREAM` | _(unset)_ | **Planned** (**ROSIE**): Axum BFF upstream for **`POST /api/help/rosie/v1/chat/completions`** — **`docs/PLAN_LOCAL_LLM_HELP.md`** § Ship decision |
| `VITE_ROSIE_LLM_DIRECT` / `VITE_ROSIE_LLM_HOST` / `VITE_ROSIE_LLM_PORT` | _(unset)_ | **Planned** (**ROSIE**): Tauri **direct** loopback vs **Axum** fallback — same doc; full table **`DEVELOPER.md`** |
| `RIVERSIDE_MORNING_DIGEST_HOUR_LOCAL` | `7` | Optional; local hour (0–23) for admin morning notification digest — **`DEVELOPER.md`**, **`docs/PLAN_NOTIFICATION_CENTER.md`** |

## Quality checks

Refer to **[`docs/CI_CD_AND_CODE_HYGIENE_STANDARDS.md`](docs/CI_CD_AND_CODE_HYGIENE_STANDARDS.md)** for detailed linting, hook stability, and GitHub CLI maintenance standards.

```bash
npm run check:server              # cargo check with Rust 1.88 (avoids Homebrew rustc shadowing rust-toolchain)
npm run bump <version>            # Cross-platform synchronize versions (JSON/TOML/README)
cd client && npm run lint        # ESLint check
cd client && npm run build       # tsc --noEmit + vite build
```

**Reporting routes:** when adding **GET** APIs used by **Insights**, **Metabase**, or other analytics surfaces, refresh **`docs/AI_REPORTING_DATA_CATALOG.md`** (hint: `python3 scripts/scan_axum_get_routes_hint.py`). **Pair that file** with **`docs/AI_CONTEXT_FOR_ASSISTANTS.md`** (routing, RBAC safety, Help vs reporting, **ROSIE** launch posture — **`docs/PLAN_LOCAL_LLM_HELP.md`**, **`ThingsBeforeLaunch.md`** § LLM). Booked vs recognition semantics: **[`docs/BOOKED_VS_FULFILLED.md`](docs/BOOKED_VS_FULFILLED.md)** and **`docs/REPORTING_BOOKED_AND_RECOGNITION.md`**. Layaway lifecycle: **[`docs/LAYAWAY_OPERATIONS.md`](docs/LAYAWAY_OPERATIONS.md)**. Ops model: **`docs/METABASE_REPORTING.md`**, **`docs/PLAN_METABASE_INSIGHTS_EMBED.md`**. Order and Wedding Order rules: **[`docs/ORDERS_AND_WEDDING_ORDERS.md`](docs/ORDERS_AND_WEDDING_ORDERS.md)**.

## E2E tests (Playwright)

```bash
cd client
npm run test:e2e -- --list
E2E_BASE_URL="http://localhost:5173" npm run test:e2e
E2E_BASE_URL="http://localhost:5173" npx playwright test --workers=1
E2E_BASE_URL="http://localhost:5173" npm run test:e2e:update-snapshots
```

> Use `localhost` for `E2E_BASE_URL` — `127.0.0.1` may fail browser tests. Full-suite CI-style runs: **`--workers=1`** (see **`docs/ROS_UI_CONSISTENCY_PLAN.md`** Phase 5).

For complete pre-release validation (service boot order, lint/build gates, and E2E checklist), see **`docs/RELEASE_QA_CHECKLIST.md`**.

## Migrations

Apply via **`./scripts/apply-migrations-docker.sh`** (ledger in `migrations/00_ros_migration_ledger.sql`). Compare ledger vs schema: **`./scripts/migration-status-docker.sh`** (probes in **`scripts/ros_migration_build_probes.sql`**, maintained through the latest numbered file). Full table: **`DEVELOPER.md`**. Latest numbered files: **`00`–`117`** (see `migrations/`). Feature migrations **51–52**: **`docs/PLAN_NOTIFICATION_CENTER.md`**; weather **46–48**: **`docs/WEATHER_VISUAL_CROSSING.md`**.

| # | Highlights |
|---|------------|
| 28 | `customers.customer_code` (unique, required), profile fields |
| 29 | Counterpoint sync columns + `counterpoint_sync_runs` |
| 34 | Staff contacts + RBAC (`docs/STAFF_PERMISSIONS.md`) |
| 38 | `register_sessions.pos_api_token`, `orders.checkout_client_id` (idempotent checkout) |
| 51 | Notification center tables + `notifications.view` / `notifications.broadcast` seeds |
| 62 | *(AI portions retired by 78)* AI platform, duplicate queue |
| 73 | Online store module foundations |
| 101–103 | Staff bug reports & triage |
| 106 | Reporting: Order recognition basis |
| 108 | NuORDER integration foundations |

## Documentation catalog

First-party Markdown only. **Role:** runbook, agent guide, spec, future plan, audit snapshot, or implementation roadmap.

| Path | Role | Audience |
|------|------|----------|
| `README.md` | Overview, quick start, migrations summary | Everyone |
| `CHANGELOG.md` | Detailed version history and release notes | Everyone |
| `DEVELOPER.md` | Architecture, API overview, migrations table, runbooks | Developers |
| `AGENTS.md` | Invariants, edit map, commands, migration cheat sheet | Agents / devs |
| `docs/ORDERS_AND_WEDDING_ORDERS.md` | Rules around non-takeaway fulfillment, deposit liabilities vs revenue, and reserving stock pending arrival. | Developers / ops |
| `docs/ORBSTACK_GUIDE.md` | Local Docker management, context switch, VirtioFS | Devs |
| `docs/STAFF_PERMISSIONS.md` | RBAC keys, middleware, client gating | Devs |
| `docs/ONLINE_STORE.md` | Public `/shop`, API, CMS, Studio editor | Devs / ops |
| `docs/SEARCH_AND_PAGINATION.md` | Search semantics, optional Meilisearch | Devs |
| `docs/COUNTERPOINT_SYNC_GUIDE.md` | Counterpoint bridge, mapping, heartbeats | Ops / devs |
| `docs/ORDERS_RETURNS_EXCHANGES.md` | Refunds, returns, exchanges | Devs |
| `docs/STAFF_TASKS_AND_REGISTER_SHIFT.md` | Checklists, tasks, register shift primary | Devs / ops |
| `docs/PLAN_BUG_REPORTS.md` | In-app bug report architecture and triage | Devs / ops |
| `docs/RECEIPT_BUILDER_AND_DELIVERY.md`| ZPL / Thermal templates and Podium delivery | Devs / ops |
| `docs/COMMISSION_AND_SPIFF_OPERATIONS.md` | Commission Manager, SPIFF rules, and combo rewards | Ops / devs |
| `docs/SHIPPING_AND_SHIPMENTS_HUB.md` | Shippo, Registry, and Hub operations | Devs / ops |
| `docs/WISEPOS_E_SETUP_STRIPE.md` | Stripe Terminal WisePOS E reset and server-driven flow | Ops / devs |
| `docs/CLIENT_UI_CONVENTIONS.md` | React primitives, modal a11y, shell wiring | Devs / agents |
| `docs/CUSTOMER_HUB_AND_RBAC.md` | Joint accounts, financial redirection, CRM RBAC | Devs / ops |
| `INVENTORY_GUIDE.md` | Scanning engine, physical inventory sessions | Ops / devs |
| `BACKUP_RESTORE_GUIDE.md` | Maintenance, backups, cloud sync | Ops |
| `Riverside_OS_Master_Specification.md` | Product requirements and vocabulary | Product / devs |
| `docs/RETIRED_DOCUMENT_SUMMARIES.md` | Ledger of removed docs | Maintainers |
| `docs/PLAN_POST_V0.1.2_EVOLUTION.md` | Strategic growth (Health Heatmap, MTM Center, Alteration Forecast) | Product / Devs |

## Command Summary

```bash
# General validation
npm run lint
npm run check:server
cd client && npm run build

# Playwright E2E
cd client && npm run test:e2e
```
