# Riverside OS

**Riverside OS (ROS)** is a production-grade desktop ERM/POS platform for formalwear and wedding retail. Version 0.70.0 is the production release for the store rollout model: Backoffice / Server PC, Register #1 Windows Tauri, Register #2 iPad PWA, and Windows laptop PWA/optional Tauri clients. It carries forward the v0.60.2 deployment baseline and tightens host selection, printer readiness, updater, Help/ROSIE, deployment, and recovery hardening.

Current Version: **v0.70.5** (See [CHANGELOG.md](CHANGELOG.md))

## Stack

| Layer | Technology |
|---|---|
| API server | Rust · Axum 0.8 · sqlx · PostgreSQL |
| Frontend | React 19 · TypeScript · Tailwind CSS · Vite |
| Desktop shell | Tauri 2 |
| Architecture | **Unified Hybrid Model** (New in v0.2.1) — Embedding the backend engine in the desktop shell for one-click updates. |
| Caching & Locking | Redis Cluster · Distributed locking · Graceful fallback |
| Job Queue | Redis-based background processing · Dead letter queues · Automatic retries |
| Metrics | Business KPIs · Technical metrics · Prometheus/JSON/InfluxDB exports |
| Monitoring | Health checks · Connection pool monitoring · WAL archiving |
| Security | Global rate limiting · System alerts · CORS protection |
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

## DevOps Center (v0.70.5+)

Riverside OS includes a comprehensive DevOps management system for monitoring, diagnostics, and release management.

### In-App DevOps Center
- **Real-time monitoring** — DB health, stations, alerts, bugs, runtime diagnostics
- **GitHub integration** — View workflow runs, releases, trigger builds with one click
- **Server diagnostics** — Version, DB pool, migrations, recent errors/warnings
- **AI-ready prompts** — Copy diagnostic data for analysis with ChatGPT/Claude/Cursor

### Standalone ROS Dev Center (macOS)
A dedicated macOS companion app in `ros-dev/` for managing ROS from anywhere:
- **Auto-discovery** — Scans Tailscale peers and local subnet for ROS servers
- **Server profiles** — Save and switch between dev/staging/production instances
- **Tailscale detection** — Shows connection status and tailnet name
- **ROSIE AI analysis** — One-click diagnostic analysis via the local Gemma LLM
- **Build**: `cd ros-dev && npm install && npm run tauri build`

## Production Features (v0.70.5+)

Riverside OS v0.70.5+ includes enterprise-grade production hardening features:

### 🏥 **Health & Monitoring**
- **Health Check Endpoints**: `/api/health`, `/api/ready`, `/api/live` for orchestration
- **Connection Pool Monitoring**: Automatic alerts when pool utilization > 80%
- **WAL Archiving**: Point-in-time recovery with monitoring and alerting
- **System Alerts**: Broadcast critical events to all admin staff

### 🚀 **Performance & Scalability**
- **Redis Cluster**: Distributed caching and locking with graceful fallback
- **Background Job Queue**: Resilient async processing with retries and dead letter queues
- **Global Rate Limiting**: IP-based and user-based DoS protection
- **Connection Pooling**: Optimized database connection management

### 📊 **Observability**
- **Business KPIs**: Revenue, customers, inventory, financial metrics
- **Technical Metrics**: System resources, database performance, API metrics
- **Multiple Export Formats**: Prometheus, JSON, InfluxDB, Graphite
- **Real-time Collection**: Configurable intervals with automatic cleanup

### 🔒 **Security**
- **Rate Limiting**: Configurable limits per IP and authenticated users
- **CORS Protection**: Production-ready cross-origin security
- **Input Validation**: Comprehensive request validation and sanitization
- **Secure Headers**: Automatic security header injection

**📖 Production Documentation**:
- [Production Hardening Guide](docs/PRODUCTION_HARDENING_GUIDE.md) - Complete production setup
- [Redis Integration Guide](docs/REDIS_INTEGRATION_GUIDE.md) - Caching and distributed locking
- [Job Queue Guide](docs/JOB_QUEUE_GUIDE.md) - Background job processing
- [Metrics System Guide](docs/METRICS_SYSTEM_GUIDE.md) - Business and technical KPIs
- [Deployment Guide](docs/DEPLOYMENT_GUIDE.md) - Production deployment procedures

## Quick start

Local PostgreSQL is managed via **OrbStack** (recommended) or Docker Desktop. The **`db` service** in [`docker-compose.yml`](docker-compose.yml) is published on **`localhost:5433`** so it does not conflict with a system Postgres on **5432**. See [**`docs/ORBSTACK_GUIDE.md`**](docs/ORBSTACK_GUIDE.md) for setup and performance tuning.

The **`db` image** is **`pgvector/pgvector:pg16`** (PostgreSQL 16; image includes **pgvector**). If switching engines, run **`docker compose up -d --build`** to ensure a fresh build on the new optimization layer.

```bash
# 0. Install JS dependencies used by root scripts (dev:e2e, test:e2e:*, pack) and client scripts
npm install

# 1. Start Postgres (and optional Meilisearch sidecar on :7700), apply the schema-contract baseline, then seed local dev data.
docker compose up -d
./scripts/apply-migrations-docker.sh
docker compose exec -T db psql -U postgres -d riverside_os -v ON_ERROR_STOP=1 < scripts/seeds/seed_core_required.sql
docker compose exec -T db psql -U postgres -d riverside_os -v ON_ERROR_STOP=1 < scripts/seeds/seed_rbac.sql
docker compose exec -T db psql -U postgres -d riverside_os -v ON_ERROR_STOP=1 < scripts/seeds/seed_dev.sql
# Optional checks:
#   ./scripts/migration-status-docker.sh
#   ./scripts/validate_schema_contract.sh

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
| `HELCIM_API_TOKEN` | unset | Deployment fallback for Helcim API token. Routine Helcim credentials should be saved in Backoffice Settings. The API token is enough for Helcim batch/transaction/fee reads. |
| `HELCIM_TERMINAL_1_DEVICE_CODE` / `HELCIM_TERMINAL_2_DEVICE_CODE` | unset | Deployment fallback for Terminal 1 and Terminal 2 Helcim device codes. Routine terminal setup should be saved in Backoffice Settings. Terminal payments use the terminal assigned to the active register session. |
| `HELCIM_WEBHOOK_SECRET` | unset | Optional deployment fallback for Helcim webhook signing secret. Required for production Helcim terminal webhooks when Helcim can reach a public ROS API URL such as `https://ros.riversidemens.com/api/webhooks/helcim`. If that URL is served through Cloudflare Tunnel, `cloudflared` must run as a supervised host service. |
| `RIVERSIDE_PUBLIC_BASE_URL` | unset | Optional public HTTPS origin used for edge/webhook diagnostics in Settings → Remote Access. Example: `https://ros.riversidemens.com` (no path). |
| `RIVERSIDE_CLOUDFLARE_TUNNEL_HOSTNAME` | unset | Optional Cloudflare Tunnel hostname hint for Settings → Remote Access. When set, the edge diagnostics expect `cloudflared` to be installed and supervised on the server PC. |
| `RIVERSIDE_CREDENTIALS_KEY` | unset | Root encryption key for Backoffice-managed integration credentials, including QBO client credentials and OAuth tokens. Must be non-default and at least 32 characters before credentials can be saved. `QBO_TOKEN_ENC_KEY` remains accepted as a transitional fallback. |
| `RIVERSIDE_BACKUP_DIR` | `backups` | Local backup directory. Strict production requires this to be set to an absolute, durable path; Settings and ROS Dev Center show the effective path. |
| `RIVERSIDE_BACKUP_ENCRYPTION_KEY` | unset | Required when Settings → Backups enables encrypted archives. Must be preserved outside Git and outside the database; losing it makes `.dump.enc` backups unrecoverable. |
| `BACKUP_S3_ACCESS_KEY` / `BACKUP_S3_SECRET_KEY` | unset | S3-compatible off-site backup credentials. Routine credentials may be saved through Backoffice Settings. |
| `BACKUP_CLOUD_ACCESS_TOKEN` / `BACKUP_CLOUD_REFRESH_TOKEN` / `BACKUP_CLOUD_CLIENT_ID` / `BACKUP_CLOUD_CLIENT_SECRET` | unset | Direct OneDrive, Google Drive, or Dropbox backup credentials. Prefer refresh token + client ID for scheduled backups. |
| `VITE_API_BASE` | unset → same-origin in browser/PWA, else `http://127.0.0.1:3000` fallback for non-HTTP shells | API origin for client; set explicitly for production when UI and API are on different origins |
| `VITE_STOREFRONT_EMBEDS` | _(unset)_ | When **`true`**, loads **`GET /api/public/storefront-embeds`** once (Podium widget when configured) — public storefront builds only — **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`** |
| `VITE_PODIUM_OAUTH_REDIRECT_URI` | _(unset)_ | Optional. Override Podium OAuth callback URL (must match Podium app); default is **`${origin}/callback`** — **`client/.env.example`**, **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`** |
| `RIVERSIDE_PODIUM_CLIENT_ID` | _(unset)_ | Deployment fallback for Podium OAuth client id; routine setup belongs in Backoffice Settings — **`DEVELOPER.md`**, **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`** |
| `RIVERSIDE_PODIUM_CLIENT_SECRET` | _(unset)_ | Deployment fallback for Podium OAuth client secret; never log. |
| `RIVERSIDE_PODIUM_REFRESH_TOKEN` | _(unset)_ | Deployment fallback for Podium OAuth refresh token; routine OAuth callback saves it through Backoffice Settings. Never log. |
| `RIVERSIDE_PODIUM_OAUTH_TOKEN_URL` | _(unset)_ | Optional; defaults to **`{RIVERSIDE_PODIUM_API_BASE or https://api.podium.com}/oauth/token`** — **`DEVELOPER.md`**, **`server/.env.example`** |
| `RIVERSIDE_PODIUM_API_BASE` | _(unset)_ | Optional REST API origin (no trailing slash); default **`https://api.podium.com`** — **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`** |
| `RIVERSIDE_PODIUM_API_VERSION` | _(unset)_ | Optional Podium `podium-version` header override; default **`2021.04.01`**. Keep pinned unless Podium requires a reviewed upgrade. |
| `RIVERSIDE_PODIUM_WEBHOOK_SECRET` | _(unset)_ | Deployment fallback for **`POST /api/webhooks/podium`** HMAC secret; routine setup belongs in Backoffice Settings. |
| `RIVERSIDE_PODIUM_WEBHOOK_ALLOW_UNSIGNED` | _(unset)_ | Dev only: accept unsigned webhooks when secret unset — **`server/.env.example`** |
| `RIVERSIDE_PODIUM_INBOUND_DISABLED` | _(unset)_ | When truthy, **`POST /api/webhooks/podium`** skips CRM ingest (threads + notifications); idempotent webhook ledger still accepts deliveries — **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`** |
| `RIVERSIDE_EMAIL_IMAP_USERNAME` / `RIVERSIDE_EMAIL_IMAP_PASSWORD` | _(unset)_ | Deployment fallback for the first-party store email inbox. Routine IONOS setup belongs in Backoffice Settings → Email — **`docs/EMAIL_MAILBOX.md`** |
| `RIVERSIDE_EMAIL_SMTP_USERNAME` / `RIVERSIDE_EMAIL_SMTP_PASSWORD` | _(unset)_ | Deployment fallback for first-party store email sending. If omitted, ROS uses the IMAP credentials for SMTP — **`docs/EMAIL_MAILBOX.md`** |
| `RIVERSIDE_EMAIL_SYNC_INTERVAL_SECS` | `300` | Background inbox sync interval, minimum 60 seconds. Disabled automatically when Settings → Email is disabled or credentials are missing. |
| `RUST_LOG` | `riverside_server=info,warn` | Structured log level |
| `OTEL_*` / `RIVERSIDE_OTEL_ENABLED` | _(unset)_ | Optional **OTLP** distributed traces — [`docs/OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md`](docs/OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md), [`server/.env.example`](server/.env.example) |
| `RIVERSIDE_MAX_BODY_BYTES` | _(unset)_ | Optional cap override for large **`POST /api/products/import`** bodies (`DEVELOPER.md`, **`docs/CATALOG_IMPORT.md`**) |
| `RIVERSIDE_DATABASE_MAX_CONNECTIONS` | `20` | Optional PostgreSQL pool cap for API + background jobs. Values outside `5..=100` fall back to `20`. |
| `RIVERSIDE_VISUAL_CROSSING_API_KEY` | _(unset)_ | Optional deployment fallback for the Weather Settings API key — see **`docs/WEATHER_VISUAL_CROSSING.md`** |
| `RIVERSIDE_VISUAL_CROSSING_ENABLED` | _(unset)_ | Optional; force live weather on/off — see **`docs/WEATHER_VISUAL_CROSSING.md`** |
| `RIVERSIDE_MEILISEARCH_URL` | _(unset)_ | Optional deployment fallback; routine Meilisearch host setup belongs in Backoffice Settings. Enables fuzzy catalog/CRM/inventory/transaction search with SQL hydration + fallback — **`docs/SEARCH_AND_PAGINATION.md`** |
| `RIVERSIDE_MEILISEARCH_API_KEY` | _(unset)_ | Optional deployment fallback for Meilisearch master/API key when the instance requires auth; routine setup belongs in Backoffice Settings. |
| `RIVERSIDE_METABASE_ADMIN_EMAIL` / `RIVERSIDE_METABASE_ADMIN_PASSWORD` | _(unset)_ | Optional local shared-auth credentials used by **`/api/insights/metabase-launch`** when JWT SSO is off. Put these in **`server/.env`** if you expect automatic Metabase sign-in for Admin staff in local/RC runs. |
| `RIVERSIDE_METABASE_STAFF_EMAIL` / `RIVERSIDE_METABASE_STAFF_PASSWORD` | _(unset)_ | Optional local shared-auth credentials used by **`/api/insights/metabase-launch`** when JWT SSO is off. Put these in **`server/.env`** if you expect automatic Metabase sign-in for staff-class Metabase sessions in local/RC runs. |
| `RIVERSIDE_LLAMA_UPSTREAM` | _(unset)_ | **Planned** (**ROSIE**): Axum BFF upstream for **`POST /api/help/rosie/v1/chat/completions`** — **`docs/PLAN_LOCAL_LLM_HELP.md`** § Ship decision |
| `VITE_ROSIE_LLM_DIRECT` / `VITE_ROSIE_LLM_HOST` / `VITE_ROSIE_LLM_PORT` | _(unset)_ | **Planned** (**ROSIE**): Tauri **direct** loopback vs **Axum** fallback — same doc; full table **`DEVELOPER.md`** |
| `RIVERSIDE_MORNING_DIGEST_HOUR_LOCAL` | `7` | Optional; local hour (0–23) for admin morning notification digest — **`DEVELOPER.md`**, **`docs/PLAN_NOTIFICATION_CENTER.md`** |

Helcim POS uses the terminal hardware path for **Card Reader**, phone-order **Manual Card** keyed entry, and terminal refunds. HelcimPay.js remains the public web-checkout/browser-hosted path, not the local POS manual-entry path.

Production browser releases require **`RIVERSIDE_STRICT_PRODUCTION=true`** together with **`RIVERSIDE_CORS_ORIGINS`**, **`RIVERSIDE_STORE_CUSTOMER_JWT_SECRET`**, an explicit **`FRONTEND_DIST`**, configured Helcim credentials through Backoffice Settings, an absolute **`RIVERSIDE_BACKUP_DIR`**, and a non-default **`RIVERSIDE_CREDENTIALS_KEY`** before integration credentials can be saved. If encrypted backups are enabled, **`RIVERSIDE_BACKUP_ENCRYPTION_KEY`** is also mandatory and must be included in the secure recovery bundle. Local development may use the permissive defaults, but RC/production signoff should treat those envs as mandatory.

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

- The POS UI subset (`phase2-tender-ui`, `pos-golden`, `tax-exempt-and-helcim-branding`, and the UI-open path in `exchange-wizard`) is back in the release gate. The old `ROS_QUARANTINE_UNSTABLE_POS_E2E=1` quarantine has been removed after adding explicit POS readiness contracts.
- Production hardening coverage now includes checkout tender, tax, commission, inventory, offline recovery, register close, QBO, Payments Operations, register reconciliation, high-risk API, intelligence/finance, and visual baseline contracts. The v0.70.0 release notes are recorded in [`docs/releases/v0.70.0-release-notes.md`](docs/releases/v0.70.0-release-notes.md), carrying forward the v0.60.2 certification baseline and adding the current deployment hotfix validation results.
- See [`docs/releases/v0.70.0-release-notes.md`](docs/releases/v0.70.0-release-notes.md), [`docs/E2E_REGRESSION_MATRIX.md`](docs/E2E_REGRESSION_MATRIX.md), [`docs/POS_E2E_TESTABILITY_FOLLOWUP.md`](docs/POS_E2E_TESTABILITY_FOLLOWUP.md), and [`docs/PRODUCTION_DEPLOYMENT_GO_NO_GO_CHECKLIST.md`](docs/PRODUCTION_DEPLOYMENT_GO_NO_GO_CHECKLIST.md).

For complete pre-release validation (service boot order, lint/build gates, and E2E checklist), see **`docs/RELEASE_QA_CHECKLIST.md`**.

## Schema Contract, Migrations, And Seeds

Fresh installs use the schema-contract baseline in **`migrations/001_core_identity_staff.sql`** through **`migrations/032_transaction_status_integrity.sql`**. The legacy pre-launch migration stream is archived under **`migrations/legacy_prelaunch_history/`** and is not part of normal fresh setup.

Apply active migrations with **`./scripts/apply-migrations-docker.sh`** or **`./scripts/apply-migrations-psql.sh`**. The ledger is the table **`public.ros_schema_migrations`** and should contain the 32 active baseline filenames after a fresh baseline build.

Seed data is separate from schema:

- **`scripts/seeds/seed_core_required.sql`** — required singleton/config rows
- **`scripts/seeds/seed_rbac.sql`** — role permission templates
- **`scripts/seeds/seed_dev.sql`** — local development Admin `1234`
- **`scripts/seeds/seed_e2e.sql`** — deterministic E2E fixtures

Guardrails:

```bash
bash scripts/validate_migration_layout.sh
RIVERSIDE_DB_NAME=riverside_os bash scripts/migration-status-docker.sh
RIVERSIDE_DB_NAME=riverside_os bash scripts/validate_schema_contract.sh
```

Full operating rules live in **[`docs/SCHEMA_CONTRACT_AND_MIGRATIONS.md`](docs/SCHEMA_CONTRACT_AND_MIGRATIONS.md)**.

### Data Provenance & Integrity
Riverside OS maintains a strict **Source of Truth** policy for Counterpoint integrations:
- **Calculation over Static Fields**: Customer **Lifetime Sales** are never pulled as a static value. They are calculated dynamically by aggregating all imported `transactions` with `booked_at >= '2018-01-01'`.
- **Current bridge default**: The shipped Counterpoint bridge now defaults **`CP_IMPORT_SINCE`** to **`2018-01-01`**. This is the accepted migration floor for historical Counterpoint data in ROS and should remain visible in bridge preflight unless operators are intentionally running a narrower rehearsal.
- **Greedy Open Docs**: The bridge captures ALL open documents (`PS_DOC`) regardless of date to ensure the non-takeaway backlog (Layaways/Quotes) is preserved.

| Path | Role | Audience |
|------|------|----------|
| **Production & Operations** |
| `docs/PRODUCTION_HARDENING_GUIDE.md` | Complete production hardening features, monitoring, security | DevOps / System Admins |
| `docs/DEPLOYMENT_GUIDE.md` | Production deployment procedures, load balancer, monitoring setup | DevOps / System Admins |
| `docs/REDIS_INTEGRATION_GUIDE.md` | Redis caching, distributed locking, performance optimization | Developers / DevOps |
| `docs/JOB_QUEUE_GUIDE.md` | Background job processing, queue management, worker configuration | Developers / DevOps |
| `docs/METRICS_SYSTEM_GUIDE.md` | Business KPIs, technical metrics, monitoring, alerting | Developers / DevOps |
| **Core Development** |
| `README.md` | Overview, quick start, production features summary | Everyone |
| `CHANGELOG.md` | Detailed version history and release notes | Everyone |
| `DEVELOPER.md` | Architecture, API overview, schema-contract workflow, runbooks | Developers |
| `AGENTS.md` | Invariants, edit map, commands, migration cheat sheet | Agents / devs |
| `docs/SCHEMA_CONTRACT_AND_MIGRATIONS.md` | Baseline migrations, seed separation, runtime validation, future migration rules | Developers / agents |
| **Business Operations** |
| `docs/TRANSACTIONS_AND_WEDDING_ORDERS.md` | Rules around non-takeaway fulfillment, deposit liabilities vs revenue, and reserving stock pending arrival | Developers / ops |
| `docs/POS_WEDDING_REGISTER_WORKFLOW.md` | Register workflow for wedding members, checklist-driven item add, measurement gating, and Wedding Manager source-of-truth rules | Ops / devs |
| `docs/HELCIM.md` | Helcim POS/Payments integration contract, provider attempts, terminal health, webhooks, settlement, refunds | Devs / ops |
| `docs/staff/payments-operations.md` | Staff guide for Helcim payment operations, reconciliation, deposits, sync health, and alerts | Ops / devs |
| `docs/COMMISSION_AND_SPIFF_OPERATIONS.md` | Commission Manager, SPIFF rules, and combo rewards | Ops / devs |
| `docs/CASH_ROUNDING_OPERATIONS.md` | Swedish Rounding rules, cash checkout logic, and QBO mapping | Ops / devs |
| **Technical Features** |
| `docs/ORBSTACK_GUIDE.md` | Local Docker management, context switch, VirtioFS | Devs |
| `docs/STAFF_PERMISSIONS.md` | RBAC keys, middleware, client gating | Devs |
| `docs/SEARCH_AND_PAGINATION.md` | Search semantics, optional Meilisearch | Devs |
| `docs/COUNTERPOINT_SYNC_GUIDE.md` | Counterpoint one-time migration bridge, mapping, heartbeats, retirement path | Ops / devs |
| `docs/WEDDING_COUNTERPOINT_CUTOVER_LINKING.md` | Mid-season wedding cutover design for linking imported parties to Counterpoint-synced customers, transactions, and item lifecycle | Ops / devs |
| `docs/TRANSACTION_RETURNS_EXCHANGES.md` | Refunds, returns, exchanges | Devs |
| `docs/RECEIPT_BUILDER_AND_DELIVERY.md`| ZPL / Thermal templates and Podium delivery | Devs / ops |
| `docs/SHIPPING_AND_SHIPMENTS_HUB.md` | Shippo, Registry, and Hub operations | Devs / ops |
| **User Interface & Client** |
| `docs/ONLINE_STORE.md` | Public `/shop`, API, CMS, Studio editor | Devs / ops |
| `docs/CLIENT_UI_CONVENTIONS.md` | React primitives, modal a11y, shell wiring | Devs / agents |
| `docs/CUSTOMER_HUB_AND_RBAC.md` | Joint accounts, financial redirection, CRM RBAC | Devs / ops |
| `docs/UNIFIED_ENGINE_AND_HOST_MODE.md` | **Unified Hybrid Architecture** (v0.2.1+), Host Mode, and updates | Everyone |
| `docs/ROS_DEV_CENTER.md` | ROS Dev Center architecture, API contracts, operations, and hardening model | Devs / ops |
| **Operations & Maintenance** |
| `INVENTORY_GUIDE.md` | Scanning engine, physical inventory sessions | Ops / devs |
| `BACKUP_RESTORE_GUIDE.md` | Maintenance, backups, cloud sync | Ops |
| `docs/STAFF_SCHEDULE_XLSX_IMPORTER.md` | Staff Schedule Maker weekly grid + `.xlsx` import format and troubleshooting | Ops / devs |
| `docs/STAFF_TASKS_AND_REGISTER_SHIFT.md` | Checklists, tasks, register shift primary | Devs / ops |
| `docs/PLAN_BUG_REPORTS.md` | In-app bug report architecture and triage | Devs / ops |
| `docs/INTELLIGENCE_LAYER_GUIDE.md` | Proactive risk & replenishment engines (logic, UI, API) | Developers / ops |
| **Reference** |
| `Riverside_OS_Master_Specification.md` | Product requirements and vocabulary | Product / devs |
| `docs/RETIRED_DOCUMENT_SUMMARIES.md` | Ledger of removed docs | Maintainers |
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
