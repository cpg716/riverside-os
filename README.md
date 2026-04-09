<<<<<<< HEAD
# riverside-os
Riverside OS is a private custom POS system built for Riverside Men's Shop
=======
# Riverside OS

**Riverside OS (ROS)** is a production-grade desktop ERM/POS platform for formalwear and wedding retail. It bundles a full-feature POS, inventory management, wedding-party workflow, CRM, commission accounting, and QuickBooks Online bridge into a single Tauri 2 desktop application.

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

Local PostgreSQL is only the **Docker Compose `db` service** ([`docker-compose.yml`](docker-compose.yml)), published on **`localhost:5433`** so it does not fight a system Postgres on **5432**. `server/.env` must set `DATABASE_URL` with **port 5433** like [`server/.env.example`](server/.env.example).

The **`db` image** is **`pgvector/pgvector:pg16`** (PostgreSQL 16; image includes **pgvector** for environments that applied older migrations). Migration **62** historically added **`vector`** for ROS-AI; migration **`78_retire_ros_ai_tables.sql`** drops **`ai_doc_chunk`** and **`DROP EXTENSION IF EXISTS vector`** when applied — see **`ROS_AI_INTEGRATION_PLAN.md`**. If you upgrade from plain **`postgres:16`**, run **`docker compose pull`** then **`docker compose up -d`** before **`./scripts/apply-migrations-docker.sh`**.

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
| `VITE_POS_OFFLINE_CARD_SIM` | _(unset)_ | When **`true`**, register **Credit Card** tender can open the **training** reader simulation if **`POST /api/payments/intent`** fails — see **`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`** |
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

```bash
npm run check:server              # cargo check with Rust 1.88 (avoids Homebrew rustc shadowing rust-toolchain)
cd client && npm run build        # tsc --noEmit + vite build
```

**Reporting routes:** when adding **GET** APIs used by **Insights**, **Metabase**, or other analytics surfaces, refresh **`docs/AI_REPORTING_DATA_CATALOG.md`** (hint: `python3 scripts/scan_axum_get_routes_hint.py`). **Pair that file** with **`docs/AI_CONTEXT_FOR_ASSISTANTS.md`** (routing, RBAC safety, Help vs reporting, **ROSIE** launch posture — **`docs/PLAN_LOCAL_LLM_HELP.md`**, **`ThingsBeforeLaunch.md`** § LLM). Booked vs recognition semantics: **[`docs/BOOKED_VS_FULFILLED.md`](docs/BOOKED_VS_FULFILLED.md)** and **`docs/REPORTING_BOOKED_AND_RECOGNITION.md`**. Layaway lifecycle: **[`docs/LAYAWAY_OPERATIONS.md`](docs/LAYAWAY_OPERATIONS.md)**. Ops model: **`docs/METABASE_REPORTING.md`**, **`docs/PLAN_METABASE_INSIGHTS_EMBED.md`**.

## E2E tests (Playwright)

```bash
cd client
npm run test:e2e -- --list
E2E_BASE_URL="http://localhost:5173" npm run test:e2e
E2E_BASE_URL="http://localhost:5173" npx playwright test --workers=1
E2E_BASE_URL="http://localhost:5173" npm run test:e2e:update-snapshots
```

> Use `localhost` for `E2E_BASE_URL` — `127.0.0.1` may fail browser tests. Full-suite CI-style runs: **`--workers=1`** (see **`docs/ROS_UI_CONSISTENCY_PLAN.md`** Phase 5).

## Migrations

Apply via **`./scripts/apply-migrations-docker.sh`** (ledger in `migrations/00_ros_migration_ledger.sql`). Compare ledger vs schema: **`./scripts/migration-status-docker.sh`** (probes in **`scripts/ros_migration_build_probes.sql`**, maintained through the latest numbered file). Full table: **`DEVELOPER.md`**. Latest numbered files: **`00`–`107`** (same as probes; **53** is a dev/bootstrap staff PIN seed — **`docs/STAFF_PERMISSIONS.md`**, Playwright notes in **`AGENTS.md`**). **55–56**: register shift primary + staff recurring tasks — **`docs/STAFF_TASKS_AND_REGISTER_SHIFT.md`**. **57–58**: staff schedule + SQL comments — **`docs/STAFF_SCHEDULE_AND_CALENDAR.md`**. **59**: **`staff_sop_markdown`** on **`store_settings`**. **60**: **`store_backup_health`** for backup notification timestamps. **61**: **`integration_alert_state`** + **`staff_auth_failure_event`** (integration health + PIN audit for generators). **62**: *(superseded at **78** for AI tables)* ROS-AI schema: **`pgvector`**, **`ai_doc_chunk`**, **`ai_saved_report`**, RBAC **`ai_assist`** / **`ai_reports`**; also **`customer_duplicate_review_queue`** (**queue remains** in DB). **63**: customer hub RBAC (**`customers.hub_view`**, **`hub_edit`**, **`timeline`**, **`measurements`**) — **`docs/CUSTOMER_HUB_AND_RBAC.md`**. **64**: **`salesperson`** / **`sales_support`**: **`customers_duplicate_review`**, **`customers.merge`** — **`docs/CUSTOMER_HUB_AND_RBAC.md`**, **`docs/STAFF_PERMISSIONS.md`**. **65**: Trigram index on **`ai_doc_chunk.content`** (lexical hybrid help — **table dropped at 78**). **66–67**: register **lanes** + **till close group** (combined Z, satellite lanes) — **`docs/TILL_GROUP_AND_REGISTER_OPEN.md`**. **68**: server **parked sales**, **`pos_rms_charge_record`**, Sales Support **`rms_r2s_charge`** notifications — **`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`**. **69**: R2S **payment** collection line (**`pos_line_kind`**), **`record_kind` charge/payment**, ad-hoc **Sales Support** tasks, **`customers.rms_charge`**, QBO **`RMS_R2S_PAYMENT_CLEARING`** — **`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`**, **`docs/STAFF_PERMISSIONS.md`**. **70**: **`store_settings.podium_sms_config`** (Podium operational SMS + storefront widget settings) — **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`**. **71**: **`customers.transactional_sms_opt_in`**, **`podium_webhook_delivery`**, **`POST /api/webhooks/podium`** — **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`**. **72**: **`customers.transactional_email_opt_in`**, **`podium_conversation_url`** — Podium transactional email + CRM link field — **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`**. **73**: online store (**`sale_channel`**, **`store_pages`**, **`store_coupons`**, **`online_store.manage`**) — **`docs/PLAN_ONLINE_STORE_MODULE.md`**. **74**–**75**: Shippo foundation on **`orders`** + **`shipment`** registry (**`shipment_event`**, **`shipments.view`** / **`shipments.manage`**) — **`docs/SHIPPING_AND_SHIPMENTS_HUB.md`**, **`docs/PLAN_SHIPPO_SHIPPING.md`**. **76**: **`store_guest_cart`**, **`store_media_asset`** — guest cart session + Studio images — **`docs/ONLINE_STORE.md`**. **77**: **`customers.customer_created_source`**, **`customer_online_credential`** — public **`/api/store/account/*`** (JWT, profile, order detail, rate limits) — **`docs/ONLINE_STORE.md`**. **78**: Retire ROS-AI DB artifacts — drops **`ai_doc_chunk`**, **`ai_saved_report`**, **`vector`**, **`ai_assist`** / **`ai_reports`** — staff help → **Help Center** / **`GET /api/help/search`** (**`79`**, **`PLAN_HELP_CENTER.md`**); see **`ROS_AI_INTEGRATION_PLAN.md`**. **83**: **`customer_open_deposit_accounts`** + **`customer_open_deposit_ledger`** (party deposits; checkout **`open_deposit`** tender) — **`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`**, **`docs/WEDDING_GROUP_PAY_AND_RETURNS.md`**. Feature migrations **51–52**: **`docs/PLAN_NOTIFICATION_CENTER.md`**; weather **46–48**: **`docs/WEATHER_VISUAL_CROSSING.md`**.

| # | Highlights |
|---|------------|
| 28 | `customers.customer_code` (unique, required), profile fields |
| 29 | Counterpoint sync columns + `counterpoint_sync_runs` |
| 30 | `fulfillment_type.wedding_order`, line backfill |
| 31 | `customers.is_active` |
| 32 | Wider `customers.phone` |
| **33** | **General appointments**: `wedding_appointments` nullable party/member + optional `customer_id` |
| **34** | Staff contacts + RBAC (`docs/STAFF_PERMISSIONS.md`) |
| **35** | **`vendors.vendor_code`** (catalog import / Vendor Hub) — see **`docs/CATALOG_IMPORT.md`** |
| **36** | **`orders.*` permission seeds** (view / modify / cancel / refund_process) |
| **37** | **`order_return_lines`**, **`orders.exchange_group_id`** — see **`docs/ORDERS_RETURNS_EXCHANGES.md`** |
| **38** | **`register_sessions.pos_api_token`**, **`orders.checkout_client_id`** (idempotent checkout) |
| **39** | Extended RBAC seeds — catalog, procurement, settings, gift cards, loyalty program, weddings, register reports (`docs/STAFF_PERMISSIONS.md`) |
| **40**–**49** | Discount events, roadmap tables, weather config, void-sale permission, etc. — **`DEVELOPER.md`** |
| **50** | Suit component swap + **`register.open_drawer`** — **`DEVELOPER.md`** |
| **51** | Notification center tables + **`notifications.view`** / **`notifications.broadcast`** — **`docs/PLAN_NOTIFICATION_CENTER.md`** |
| **52** | **`track_low_stock`** on products/variants + **`morning_digest_ledger`** — **`docs/PLAN_NOTIFICATION_CENTER.md`**, **`INVENTORY_GUIDE.md`** |
| **53** | Default admin bootstrap (**Chris G**, cashier **1234**, Argon2 PIN) — dev/E2E alignment; see **`AGENTS.md`** |
| **54** | **`staff.avatar_key`** — bundled profile icons; see **`AGENTS.md`** / **Settings → Profile** |
| **55** | **`register_sessions.shift_primary_staff_id`**, **`register.shift_handoff`** — **`docs/STAFF_TASKS_AND_REGISTER_SHIFT.md`** |
| **56** | Staff recurring tasks (`task_*` tables, **`tasks.*`** RBAC; inbox reminders via **`task_due_soon_bundle`**) — **`docs/STAFF_TASKS_AND_REGISTER_SHIFT.md`**, **`docs/PLAN_NOTIFICATION_CENTER.md`** |
| **57** | Staff weekly + day exceptions, **`staff_effective_working_day`**, `/api/staff/schedule` — **`docs/STAFF_SCHEDULE_AND_CALENDAR.md`** |
| **58** | **`COMMENT ON`** staff schedule function/tables (documentation in catalog) — **`docs/STAFF_SCHEDULE_AND_CALENDAR.md`** |
| **59** | **`store_settings.staff_sop_markdown`** — store staff playbook (Settings → General); **`GET/PUT /api/settings/staff-sop`**, **`GET /api/staff/store-sop`** |
| **60**–**61** | Backup health + integration/PIN notification tables — **`docs/NOTIFICATION_GENERATORS_AND_OPS.md`**, **`docs/PLAN_NOTIFICATION_CENTER.md`** |
| **62** | *(AI portions retired by **78**)* **`ai_doc_chunk`**, **`ai_saved_report`**, **`ai_assist`** / **`ai_reports`**; **`customer_duplicate_review_queue`** persists — **`ROS_AI_INTEGRATION_PLAN.md`** |
| **63** | Customer Relationship Hub RBAC seeds — **`docs/CUSTOMER_HUB_AND_RBAC.md`**, **`docs/STAFF_PERMISSIONS.md`** |
| **64** | **`salesperson`** / **`sales_support`**: **`customers_duplicate_review`**, **`customers.merge`** (duplicate queue + CRM merge) — **`docs/CUSTOMER_HUB_AND_RBAC.md`** |
| **65** | **`pg_trgm`** on **`ai_doc_chunk`** (removed with **`ai_doc_chunk`** at **78**) — historical; help retrieval today: **Meilisearch** + **`ros_help`** / client fallback — **`PLAN_HELP_CENTER.md`** |
| **66** | **`register_lane`**, **`register.session_attach`** — multiple open register terminals |
| **67** | **`till_close_group_id`** — one drawer, satellite lanes, combined Z-close — **`docs/TILL_GROUP_AND_REGISTER_OPEN.md`** |
| **68** | **`pos_parked_sale`**, **`pos_parked_sale_audit`**, **`pos_rms_charge_record`** — server parked cart, Z-close purge, RMS inbox + **`GET /api/insights/rms-charges`** — **`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`** |
| **69** | **`products.pos_line_kind`**, **`pos_rms_charge_record.record_kind`**, internal **RMS CHARGE PAYMENT** SKU, nullable **`task_instance.assignment_id`**, **`customers.rms_charge`**, **`GET /api/customers/rms-charge/records`**, **`GET /api/pos/rms-payment-line-meta`**, QBO **`RMS_R2S_PAYMENT_CLEARING`** seed — **`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`** |
| **70** | **`store_settings.podium_sms_config`** — Podium SMS templates, outbound toggle, **`location_uid`**, storefront widget snippet; OAuth secrets in **`RIVERSIDE_PODIUM_*`** env — **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`** |
| **71** | **`customers.transactional_sms_opt_in`**, **`podium_webhook_delivery`** — operational SMS consent vs marketing; signed **`POST /api/webhooks/podium`** + optional inbox preview — **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`**, **`docs/PODIUM_STOREFRONT_CSP_AND_PRIVACY.md`** (CSP/privacy for widget only) |
| **72** | **`customers.transactional_email_opt_in`**, **`podium_conversation_url`** — transactional email consent + optional Podium thread link on profile — **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`** |
| **73** | **`sale_channel`** on **`orders`**, **`store_pages`**, **`store_coupons`**, destination tax, **`online_store.manage`** — **`docs/PLAN_ONLINE_STORE_MODULE.md`** |
| **74** | **`orders.fulfillment_method`**, **`ship_to`**, shipping columns, **`store_settings.shippo_config`**, **`store_shipping_rate_quote`** — **`docs/SHIPPING_AND_SHIPMENTS_HUB.md`** |
| **75** | **`shipment`**, **`shipment_event`**, **`shipments.view`** / **`shipments.manage`**, backfill from ship orders — **`docs/SHIPPING_AND_SHIPMENTS_HUB.md`** |
| **76** | **`store_guest_cart`**, **`store_guest_cart_line`**, **`store_media_asset`** — **`docs/ONLINE_STORE.md`**, **`docs/PLAN_ONLINE_STORE_MODULE.md`** |
| **77** | **`customers.customer_created_source`**, **`customer_online_credential`** — storefront customer JWT + same-row CRM — **`docs/ONLINE_STORE.md`** |
| **78** | Retire ROS-AI DB artifacts — drops **`ai_doc_chunk`**, **`ai_saved_report`**, **`vector`**, **`ai_assist`** / **`ai_reports`** — **`ROS_AI_INTEGRATION_PLAN.md`**, **`DEVELOPER.md`** |
| **79** | **`help_manual_policy`**, **`help.manage`** — Help Center overrides (**`docs/MANUAL_CREATION.md`**, **`PLAN_HELP_CENTER.md`**) |
| **80** | Internal **`pos_gift_card_load`** catalog line — register gift-card load flow (**`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`**) |
| **81** | **`idx_order_items_variant_id`** — supports control-board / reporting variant lookups |
| **82** | **`idx_order_items_product_id`** — speeds **parent-product** popularity aggregate for **`control-board?search=`** — **`docs/SEARCH_AND_PAGINATION.md`** |
| **83** | **`customer_open_deposit_*`** — held party deposits + redeem at checkout — **`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`** |
| **84** | **Counterpoint sync extended** — `counterpoint_bridge_heartbeat`, `counterpoint_sync_request`, `counterpoint_sync_issue`, `orders.counterpoint_ticket_ref` (unique), `orders.is_counterpoint_import`, mapping tables — **`docs/PLAN_COUNTERPOINT_ROS_SYNC.md`**, **`docs/COUNTERPOINT_SYNC_GUIDE.md`** |
| **85** | **Counterpoint provenance** — widen `customers.customer_created_source` to accept `'counterpoint'`; `products.data_source` (`NULL` = ROS, `'counterpoint'`) — **`docs/COUNTERPOINT_SYNC_GUIDE.md`** |
| **86** | **`counterpoint_staff_map`**, staff Counterpoint provenance columns, **`customers.preferred_salesperson_id`**, **`orders.processed_by_staff_id`** — **`docs/COUNTERPOINT_SYNC_GUIDE.md`** |
| **87** | **`products.tax_category`** |
| **88** | **`vendors.payment_terms`** |
| **89** | **`vendor_supplier_item`**, loyalty ledger index for Counterpoint ingest — **`docs/COUNTERPOINT_SYNC_GUIDE.md`** |
| **90** | **`reporting`** schema + curated views (**`orders_core`**, etc.) for Metabase — **`docs/METABASE_REPORTING.md`** |
| **91** | **Counterpoint open documents** — `orders.counterpoint_doc_ref` (partial unique) + `POST /api/sync/counterpoint/open-docs` — **`docs/COUNTERPOINT_ONE_TIME_IMPORT.md`** |
| **92** | **`product_variants.counterpoint_prc_2` / `counterpoint_prc_3`** (optional CP retail tiers) |
| **93** | Per-product employee-sale markup columns; **`discount_events`** scope (**variants** / **category** / **vendor**) |
| **94** | Default **`store_settings.employee_markup_percent`** → **15%** (legacy **25%** nudged on upgrade) |
| **95** | **Counterpoint staging + hub** — `store_settings.counterpoint_config`, `counterpoint_staging_batch`, M2M `/staging` ingest, Settings hub queue/maps — **`docs/COUNTERPOINT_BRIDGE_OPERATOR_MANUAL.md`**, **`docs/COUNTERPOINT_SYNC_GUIDE.md`** |
| **96** | **`reporting.effective_store_timezone()`**, business-day **`daily_order_totals`**, enriched reporting views + loyalty tables — **`docs/METABASE_REPORTING.md`** |
| **97** | **`staff_permission`** (runtime BO keys), per-staff **`max_discount_percent`**, employment dates, **`employee_customer_id`**; clarifies role tables as Settings templates — **`docs/STAFF_PERMISSIONS.md`** |
| **98** | **`shipment.shippo_rate_object_id`** — Shippo label purchase after quote consumption — **`docs/SHIPPING_AND_SHIPMENTS_HUB.md`** |
| **99** | **`podium_conversation`**, **`podium_message`**, review invite fields + **`reviews.*`** RBAC — **`docs/PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md`**, **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`**, **`docs/PLAN_PODIUM_REVIEWS.md`** |
| **100** | **`store_settings.review_policy`** — store defaults for receipt/review invite UX — **`docs/PLAN_PODIUM_REVIEWS.md`** |
| **101** | **`staff_bug_report`** — in-app bug reports + Settings triage — **`docs/PLAN_BUG_REPORTS.md`** |
| **102** | **`staff_bug_report.server_log_snapshot`** — recent in-process API tracing lines captured at submit — **`docs/PLAN_BUG_REPORTS.md`** |
| **103** | **Bug report triage** — `dismissed` status, `correlation_id`, resolver notes + external URL, admin notification, daily retention — **`docs/PLAN_BUG_REPORTS.md`** |
| **104** | **`podium_message.podium_sender_name`** — Podium app/web sender attribution on CRM threads — **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`** |
| **105** | **`store_register_eod_snapshot`** — frozen register day summary at Z-close |
| **106** | **`reporting.order_recognition_at`**, fulfillment columns on **`orders_core`** / **`order_lines`**, **`daily_order_totals_fulfilled`** — **`docs/REPORTING_BOOKED_AND_FULFILLED.md`**, **`docs/METABASE_REPORTING.md`** |
| **107** | **`reporting.order_lines`**: **`unit_cost`**, **`line_extended_cost`**, **`line_gross_margin_pre_tax`** (Metabase parity with **`/api/insights/margin-pivot`**) — **`docs/METABASE_REPORTING.md`** |
| **108** | **NuORDER integration** — `store_settings.nuorder_config`, `vendors.nuorder_brand_id`, `products.nuorder_product_id`, `nuorder.manage` / `nuorder.sync` RBAC — **`docs/NUORDER_INTEGRATION.md`** |

## What changed — April 2026 hardening sprint

### Security
- Removed three development bypasses: admin middleware, PIN verification, and admin role gate are now fully enforced
- `begin_reconcile` requires staff authentication via `cashier_code`

### Data integrity
- `recalc_order_totals` — Fulfilled status now requires ALL items physically picked up **and** fully paid; **effective line qty** subtracts **`order_return_lines`** (migration **37**)
- `process_refund` — guarded against driving `amount_paid` negative; **`order_recalc`** after refund; optional **Stripe** / **gift card credit** / **loyalty clawback** when paid hits zero (see **`docs/ORDERS_RETURNS_EXCHANGES.md`**)
- `update_order_item` — item UPDATE and total recalc are now a single atomic transaction
- Refund queue — partial unique index keeps **one open row per order**; cancel and returns **merge** into that row
- Customer name — handles first-only or last-only names correctly

### Special / custom order inventory model
- Checkout does not decrement `stock_on_hand` for **`special_order`** lines (legacy DB may still show **`custom`**; UI treats as **`special_order`** — see **`AGENTS.md`**)
- `product_variants.reserved_stock` tracks units physically in-store but promised to a customer
- On PO receipt: if open special orders exist for a variant, received qty goes into `reserved_stock`
- At pickup: `stock_on_hand` and `reserved_stock` both decrement for those lines
- API exposes `stock_on_hand`, `reserved_stock`, and `available_stock` (= on_hand − reserved)

### Scanning & Physical Inventory
- **Unified Scanning**: `useScanner` hook for HID laser detection (<80ms) and `CameraScanner` for mobile PWA (html5-qrcode).
- **Physical Counts**: Multi-day session workflow with review, adjustment, and automatic sales-reconciliation logic.
- **Vendor UPC**: Option to prioritize vendor-proprietary barcodes over generic SKUs.

### Database & Reliability
- **Backup Engine**: Atomic pg_dump/pg_restore with 30-day auto-retention and non-blocking cleanup.
- **Cloud Sync**: S3-compatible cloud syncing using OpenDAL (AWS S3, DO Spaces, etc.).
- **Optimization**: Server-side VACUUM ANALYZE and DB stats dashboard.

### Performance
- Staff momentum API: N+1 loop (70+ queries) → 1 batch query + HashMap pivot
- Session ordinal: correlated subquery → direct `session_ordinal` column read (O(1))
- 9 new indexes on high-traffic columns (orders, order_items, payment_transactions, staff_access_log)
- Sales pivot API: returns `{rows, truncated}` wrapper (200-row cap); Back Office charting is **Metabase** in **Insights**, not a native pivot grid

### Observability
- All `eprintln!` replaced with structured `tracing::error!` / `tracing::warn!` across all 14 handler files
- `main.rs` initialises **`tracing`** via **`init_tracing_with_optional_otel`** (optional **OpenTelemetry OTLP** + fmt + bug-report **`ServerLogRing`**) — see [`docs/OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md`](docs/OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md)
- **HTTP:** **`TraceLayer::new_for_http()`** (outermost Tower layer) attaches request spans to the same subscriber
- Customer timeline notes only emit for business milestones (checkout, pickup, refund) — not internal edits

### UX / client
- **Unified Shell Integration**: Register and Weddings are now embedded directly in the core Back Office shell (Sidebar + AppMainColumn) for a seamless, integrated experience.
- **POS launchpad**: The Back Office sidebar item **POS** opens the launchpad (**Enter POS** / **Return to POS**) into the touch-optimized **`PosShell`**. The **Register** subsection is the default entry under **POS**; inside POS mode, the left-rail **Register** tab is the **selling** cart (**`Cart.tsx`**).
- **Intelligent POS Search**: Multi-threaded strategy (Direct SKU scan → **`/api/inventory/scan`** → fuzzy **`/api/products/control-board?search=`** with a **200-variant** request cap and **parent grouping** in the dropdown → **Variation Selection Panel** when a product has multiple SKUs). Text matches are ranked by **trailing parent-product unit sales** (**45 days**, excluding cancelled orders), then name/SKU — **`docs/SEARCH_AND_PAGINATION.md`**. Tapping a **cart line title** with multiple variants opens the picker to **swap size** on that row; **Product Intelligence** can **`/api/inventory/scan/{sku}`** when adding if the SKU is not in the current search results. With **`RIVERSIDE_MEILISEARCH_URL`** set, text search uses **Meilisearch** → id list → PostgreSQL hydration with the **same popularity sort**; otherwise **ILIKE** in SQL. Customer and inventory directory APIs support **`limit`/`offset`** and **Load more** in CRM, POS, appointments, and Procurement Hub — **`docs/SEARCH_AND_PAGINATION.md`**. **Settings → Integrations → Meilisearch** (**Rebuild search index**) or **`POST /api/settings/meilisearch/reindex`** for a full reindex (**`settings.admin`**).
- **Wedding UI Restoration**: Removed legacy iframe bridges; Weddings now render the native 'True Dark' Action Board and Pipeline.
- **Improved Sidebar**: Till status (**Till open** / **Till closed**) and cashier name come from live register session state held in **`App.tsx`** and hydrated by **`RegisterSessionBootstrap`** (**`GET /api/sessions/current`** with **`mergedPosStaffHeaders(backofficeHeaders)`** under **`BackofficeAuthProvider`** — see **`DEVELOPER.md`** / **`docs/STAFF_PERMISSIONS.md`**). The sidebar title prefers that cashier name; if the till is not open, it shows the signed-in staff **`full_name`** from **`GET /api/staff/effective-permissions`** (**`staffDisplayName`** in **`BackofficeAuthContext`**). The portrait uses bundled SVGs under **`/staff-avatars/`** (**`staff.avatar_key`**, migration **54**); staff pick an icon under **Settings → Profile** or admins set it in **Staff → Edit**. **Double-click** a Back Office nav icon (or the collapsed avatar) toggles expand vs collapsed rail.
- **Receipt Localization**: Timestamps use local timezone from `ReceiptConfig.timezone` (default: `America/New_York`).
- **ZPL formatting**: Professional `MM/DD/YYYY HH:MM AM/PM` receipts in accordance with formalwear retail standards.
- **Insights / Metabase:** **`/api/insights/*`** (sales pivot, staff momentum, commission ledger, etc.) stays staff- and permission-gated; Back Office **Insights** is **`InsightsShell`** + embedded **Metabase** — **`docs/PLAN_METABASE_INSIGHTS_EMBED.md`**.
- **Customers (Back Office)**: Browse list scrolls correctly inside the workspace card; **Add customer** is a right-hand **`DetailDrawer`** slideout (sectioned form, pinned footer). Sidebar “Add Customer” opens the same slideout; closing it resets the subsection to **All Customers** via **`onNavigateSubSection`**. Tailwind **`colors.app`** (`accent`, `accent-2`, `accent-hover`) fixes primary actions (e.g. Lightspeed import confirm) that use `bg-app-accent`.

### Recent (2026) — CRM, weddings, inventory UX + hub RBAC

- **Relationship Hub permissions** (**migration 63**): Fine-grained keys **`customers.hub_view`**, **`customers.hub_edit`**, **`customers.timeline`**, **`customers.measurements`** plus **`orders.view`** for the hub **Orders** tab; **`require_staff_perm_or_pos_session`** so an **open register** or staff with the key can call aligned APIs. Staff guide: **`docs/staff/customers-back-office.md`**; developer map: **`docs/CUSTOMER_HUB_AND_RBAC.md`**.
- **Cashier duplicate review + merge** (**migration 64**): **`salesperson`** and **`sales_support`** default to **`customers_duplicate_review`** and **`customers.merge`** (hub **Queue pair**, duplicate queue APIs, two-customer **Merge** in **Customers**). See **`docs/CUSTOMER_HUB_AND_RBAC.md`** and **`docs/STAFF_PERMISSIONS.md`**.
- **Wedding Manager Action Dashboard**: Quick **Done** actions use the **emerald terminal** button pattern; pipeline cards can show **party balance due** (from **`GET /api/weddings/actions`** field **`party_balance_due`**). **Party detail**: measure/fitting gating loads **scoped appointments** (event-window fetch + short cache) instead of unbounded calendar pulls.
- **Receiving**: **Post inventory** primary control uses **`bg-emerald-600`** + **`border-b-8 border-emerald-800`** (same completion affordance as POS terminal actions — **`UI_STANDARDS.md`**).
- **Customer merge (CRM)**: Confirm **Merge** uses the emerald terminal styling for a consistent “complete” action.

### Recent (2026) — UX & calendar

- **Staff tasks & register shift**: Saved checklist templates, role- or staff-based recurring assignments with **lazy** instance materialization (no rows for days off until someone opens **My tasks**). **Shift primary** on an open register (`shift_primary_staff_id`) separates “who is on register” from drawer opener and per-sale operator; **Shift handoff** in POS manager mode. API **`/api/tasks/*`**, due reminders as **`task_due_soon_bundle`** (one bundled inbox row per assignee per store day). See **`docs/STAFF_TASKS_AND_REGISTER_SHIFT.md`** (migrations **55–56**).
- **Register (POS) dashboard**: First **Dashboard** tab in POS mode; default view when a session opens (unless pending cart/order/SKU/wedding link). Tasks, **compact** notification preview (bundles → count + open inbox; read / complete / **Dismiss**), optional X-report and wedding pulse, salesperson metrics via **`GET /api/staff/self/register-metrics`**. **`BackofficeAuthContext`** exposes **`staffRole`**. Operations morning board / activity require **`weddings.view`** for compass + feed. See **`docs/REGISTER_DASHBOARD.md`**.
- **Parked sales + RMS / R2S (migrations 68–69):** Cart **Park** persists to PostgreSQL (audited); **Z-close** purges remaining parked rows for the till group. **In-progress cart** also persists **locally** in the browser (`localforage` **`ros_pos_active_sale`**, per open **`sessionId`**) so leaving POS mode or switching away from the **Register** (cart) tab does not drop lines until clear or checkout — distinct from **Park**; see **`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`**. **RMS** / **RMS90** **charge** tenders log **`pos_rms_charge_record`** (**`record_kind` = charge**) and enqueue **Submit R2S charge** notifications for **sales_support**. **R2S payment collections** use register search **`PAYMENT`** → line **RMS CHARGE PAYMENT** (cash/check only, customer required, no tax/loyalty on that line); **`record_kind` = payment** rows + ad-hoc **Post payment to R2S** tasks for **sales_support**. **Customers → RMS charge** (**`customers.rms_charge`**) lists charges and payments with filters. QBO: **`RMS_R2S_PAYMENT_CLEARING`** + **check** tender mapping. Insights **Register / sessions** includes an **RMS** table (**`/api/insights/rms-charges`**, includes **`record_kind`**). Cashier verifies **before ringing** (**`docs/staff/pos-register-cart.md`**). Optional **`VITE_POS_OFFLINE_CARD_SIM`** opens the card reader **simulation** when Stripe intent fails.
- **Appointments (sidebar)**: Books against the same `wedding_appointments` table as Wedding Manager but is framed as the **store** calendar; customer picker searches **`/api/customers/search`** (with paging); wedding-party link is **optional** (`scheduler/AppointmentModal.tsx`). See **`docs/APPOINTMENTS_AND_CALENDAR.md`**.
- **Inventory list**: Control board uses **`ui-input`** / app tokens, flexible search header, denser pricing columns; **Load more SKUs** for catalogs beyond one server page (`InventoryControlBoard.tsx`, `InventoryWorkspace.tsx`). Text **`search`** ranks rows by **trailing parent-product unit sales** (**45 days**, excluding cancelled orders), then name/SKU. Optional **Meilisearch** still resolves fuzzy matches first; SQL applies the same popularity ordering. See **`docs/SEARCH_AND_PAGINATION.md`**.
- **Form contrast (light mode)**: Shared **`ui-input`** uses **`--app-input-border`** / **`--app-input-bg`** (`client/src/index.css`); prefer this primitive for new fields.
- **Client UI reference (2026)**: Dialog focus trap (**`useDialogAccessibility`**), lazy Back Office tabs, density rules, Wedding Manager embed — **`docs/CLIENT_UI_CONVENTIONS.md`**; tab→component map — **`client/UI_WORKSPACE_INVENTORY.md`**.

## Documentation catalog

First-party Markdown only (omit `node_modules/`, vendored reference trees). **Role:** runbook, agent guide, spec, future plan, audit snapshot, or implementation roadmap.

**Freshness (2026):** Treat **`DEVELOPER.md`** (migrations **00**–**107** table + probes in **`scripts/ros_migration_build_probes.sql`**) as the **schema ground truth**. Treat **`docs/PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md`** as the **integration completion matrix** for Shippo, Podium CRM, notifications, and reviews. Other **`docs/PLAN_*.md`** files retain **long phased narratives**; if a paragraph conflicts with code or those two sources, prefer **code + tracker**.

| Path | Role | Audience |
|------|------|----------|
| `README.md` | Overview, quick start, migrations summary | Everyone |
| `ThingsBeforeLaunch.md` | Pre-launch checks and enactments (running list) | Ops / product |
| `DEVELOPER.md` | Architecture, API overview, migrations table, runbooks | Developers |
| `AGENTS.md` | Invariants, edit map, commands, migration cheat sheet | Agents / devs |
| `INVENTORY_GUIDE.md` | Scanning, physical inventory, control-board / hub | Ops / devs |
| `REMOTE_ACCESS_GUIDE.md` | PWA, Tailscale, TLS | Ops / devs |
| `BACKUP_RESTORE_GUIDE.md` | pg_dump, in-app backups, cloud sync | Ops |
| `Riverside_OS_Master_Specification.md` | Domain vocabulary, product requirements | Product / devs |
| `ROS_AI_INTEGRATION_PLAN.md` | **Retired** in-app AI stack (**78**); pointers to Help Center + Meilisearch | Devs |
| `docs/PLAN_LOCAL_LLM_HELP.md` | **Planning:** **ROSIE** — same Help UI on **PWA** and **Tauri**; **Tauri** prefers **loopback** `llama-server` sidecar, **PWA** and fallback use staff-gated **`POST /api/help/rosie/v1/chat/completions`** + **`RIVERSIDE_LLAMA_UPSTREAM`**; Windows **11**, tool policy — **not shipped** | Devs |
| `docs/API_AI.md` | Historical **`/api/ai/*`** contract (pre-**78**); not served by current server | Devs |
| `docs/ROS_AI_HELP_CORPUS.md` | Historical **`ai_doc_chunk`** / RAG notes (pre-**78**) | Devs / ops |
| `docs/ROS_GEMMA_WORKER.md` | Historical llama worker runbook (pre-**78**); optional **`tools/ros-gemma/`** in tree | Devs / ops |
| `PLAN_HELP_CENTER.md` | In-app Help Center, **`GET /api/help/search`**, manuals | Devs |
| `backend_audit_report.md` | Point-in-time backend security/integrity audit (2026-04-04) | Devs |
| `frontend_audit_report.md` | Point-in-time frontend UX/policy audit (2026-04-04) | Devs |
| `.cursorrules` | Mandatory coding constraints | Agents |
| `.cursor/cursorinfo.md` | Cursor quick index | Agents |
| `docs/RETIRED_DOCUMENT_SUMMARIES.md` | Ledger of removed docs | Maintainers |
| `docs/STORE_DEPLOYMENT_GUIDE.md` | Production topology, hardware, builds | Ops |
| `docs/LOCAL_UPDATE_PROTOCOL.md` | Offline A→B upgrades without GitHub | Ops |
| `docs/PWA_AND_REGISTER_DEPLOYMENT_TASKS.md` | PWA + Tauri shipping checklist | Ops / devs |
| `docs/OFFLINE_OPERATIONAL_PLAYBOOK.md` | What works offline, floor procedure | Ops |
| `docs/STAFF_PERMISSIONS.md` | RBAC keys, middleware, client gating | Devs |
| `docs/APPOINTMENTS_AND_CALENDAR.md` | Store calendar vs WM, migration 33 | Devs |
| `docs/CATALOG_IMPORT.md` | `POST /api/products/import` | Devs |
| `docs/CUSTOMERS_LIGHTSPEED_REFERENCE.md` | CRM vs Lightspeed | Devs / ops |
| `docs/CUSTOMER_HUB_AND_RBAC.md` | Relationship Hub routes ↔ permission keys, migration 63 | Devs / admins |
| `docs/SHIPPING_AND_SHIPMENTS_HUB.md` | Shippo env + schema (**74**–**75**), **`/api/shipments`**, POS/store rates, Customers → Shipments + hub tab | Devs / ops |
| `docs/ORDERS_RETURNS_EXCHANGES.md` | Refunds, returns, exchanges | Devs |
| `docs/BOOKED_VS_FULFILLED.md` | Revenue fulfillment clock, booked vs fulfilled | Ops / devs |
| `docs/LAYAWAY_OPERATIONS.md` | Layaway lifecycle, inventory, and forfeiture | Ops / devs |
| `docs/SEARCH_AND_PAGINATION.md` | Browse/search limits, control-board, optional **Meilisearch** hybrid search + reindex | Devs |
| `docs/MANUAL_CREATION.md` | In-app Help (`Help` in header/POS): `client/src/assets/docs/*-manual.md`, `npm run generate:help`, optional `generate:help:components` / `generate:help:components:rescan`, `ros_help`, [aidocs-cli](https://github.com/BinarCode/aidocs-cli) capture | Maintainers / devs |
| `client/src/assets/docs/insights-manual.md` | In-app Help manual **insights** (Metabase shell, Staff commission payouts); **`insights.view`** policy — pair with **`docs/staff/insights-back-office.md`** | Staff (Help) / trainers |
| `client/src/assets/docs/reports-manual.md` | In-app Help manual **reports** (curated **Reports** workspace, basis, Admin margin) — pair with **`docs/staff/reports-curated-manual.md`** and **`docs/staff/reports-curated-admin.md`** | Staff (Help) / trainers |
| `docs/WEATHER_VISUAL_CROSSING.md` | Visual Crossing, migrations 46–48 | Devs / ops |
| `docs/PLAN_NOTIFICATION_CENTER.md` | Shipped notification center, **bundled** hourly generators (`*_bundle`), morning digest, task due bundles | Reference |
| `docs/NOTIFICATION_GENERATORS_AND_OPS.md` | Migrations **60–61**, generator env vars, **`notification_bundle`** payloads, integration/PIN ops, deep-link map | Devs / ops |
| `docs/STAFF_TASKS_AND_REGISTER_SHIFT.md` | Recurring checklists, register shift primary, `/api/tasks`, RBAC **55–56** | Devs / ops |
| `docs/STAFF_SCHEDULE_AND_CALENDAR.md` | Floor staff schedule, **`staff_effective_working_day`**, `/api/staff/schedule`, morning **`today_floor_staff`** — **57–58** | Devs / ops |
| `docs/REGISTER_DASHBOARD.md` | POS **Dashboard** tab (default on session open), metrics API, wedding compass auth, compact notification preview + dismiss | Devs / ops |
| `docs/TILL_GROUP_AND_REGISTER_OPEN.md` | Till close group (**67**), lanes (**66**), combined Z, admin open-register UX, BO register gate | Devs / ops |
| `docs/POS_PARKED_SALES_AND_RMS_CHARGES.md` | Server parked sales (**68**) vs **local draft** **`ros_pos_active_sale`**; recall/delete + client **`cache: no-store`**; **`pos_rms_charge_record`** charge vs payment (**69**); **`PAYMENT`** search / cash-check collection; **`/api/customers/rms-charge/records`**; QBO **`RMS_R2S_PAYMENT_CLEARING`**; **`rms_r2s_charge`**; **`/api/insights/rms-charges`**; card sim **`VITE_POS_OFFLINE_CARD_SIM`** | Devs / ops |
| `docs/staff/pos-register-cart.md` | Staff: register cart, full-screen **Cashier for this sale**, **receipt** step after tender, local draft vs **Park**, customer strip → **relationship hub**, checkout / RMS payment line | Staff / trainers |
| `docs/AI_INTEGRATION_OUTLOOK.md` | AI product intent (not build spec) | Product / devs |
| `docs/AI_REPORTING_DATA_CATALOG.md` | NL reporting / charts: exhaustive **GET** inventory (**§0**), curated **Reports** tile map, Metabase **`reporting.*`** context, RBAC whitelist notes — **companion:** **`docs/AI_CONTEXT_FOR_ASSISTANTS.md`** | Admins / devs / AI implementers |
| `docs/PLAN_METABASE_INSIGHTS_EMBED.md` | Metabase full UI in same-origin Insights shell; Staff commission payouts; Phase 2 `metabase_ro` + views; optional static JWT appendix | Phase 1 shipped (see **DEVELOPER.md** §3c); Phase 2 planning |
| `docs/METABASE_REPORTING.md` | Phase 1 proxy + Compose vs Phase 2 **`metabase_ro`** + **`reporting.*`** views | Devs / ops |
| `docs/REPORTING_BOOKED_AND_FULFILLED.md` | Booked (`booked_at`) vs fulfilled (pickup / ship events); API + Metabase; migration **106** | Devs / ops |
| `docs/AI_CONTEXT_FOR_ASSISTANTS.md` | Single routing + safety guide for ROS-aware AI (staff corpus vs **`GET /api/help/search`** vs reporting catalog vs RBAC vs **`GET /api/staff/store-sop`**) — **companion:** **`docs/AI_REPORTING_DATA_CATALOG.md`**; **ROSIE** planning **`docs/PLAN_LOCAL_LLM_HELP.md`** | Prompt authors / implementers |
| `docs/CLIENT_UI_CONVENTIONS.md` | React client: primitives, modal a11y hook, lazy `App.tsx` splits, embedded Wedding Manager wiring; points to `UI_STANDARDS.md` + `client/UI_WORKSPACE_INVENTORY.md` | Devs / agents |
| `docs/ROS_UI_CONSISTENCY_PLAN.md` | Staff/POS/WM typography + `data-theme` / Tailwind `dark:` alignment; **Phases 1–5 complete** (2026-04-08); guest `/shop` **deferred**; Phase 5 = build + Playwright + `RegisterSessionBootstrap` shell gate | Devs / agents |
| `docs/E2E_REGRESSION_MATRIX.md` | Playwright **`client/e2e/`** specs ↔ workspaces; **`api-gates`** route smoke inventory; known coverage gaps; CI note | Devs / QA / agents |
| `docs/staff/` | Staff task guides, glossary/FAQ/error guide, EOD narrative, PII + SOP template, `abstracts/` one-pagers, coverage checklists, `CORPUS.manifest.json` for RAG | Staff / trainers / AI corpus |
| `docs/PRODUCT_ROADMAP_MENS_WEDDING_RETAIL.md` | Retail fit, completed vs backlog | Product |
| `docs/WEDDING_GROUP_PAY_AND_RETURNS.md` | Disbursements, returns | Devs |
| `docs/QBO_JOURNAL_TEST_MATRIX.md` | QBO journal scenarios | Devs / QA |
| `docs/SUIT_OUTFIT_COMPONENT_SWAP_AND_QBO.md` | Suit swap, migration 50 | Devs |
| `docs/PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md` | **Master tracker:** Shippo + Podium CRM + notification semantics + reviews (**shipped / partial / deferred**) | Planning / devs |
| `docs/PLAN_PODIUM_SMS_INTEGRATION.md` | Podium SMS + widget (**70**), webhook (**71**), two-way CRM (**99**+); deep env/receipt/widget spec — pair with master plan above | Planning / devs |
| `docs/PLAN_PODIUM_REVIEWS.md` | Review invites (receipt opt-out), Operations **Reviews** — **partial** (stub Podium API); live review API TBD | Planning / devs |
| `docs/OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md` | Server **`tracing`**, optional OTLP traces, **`ServerLogRing`**, HTTP **`TraceLayer`**, env vars; vs client Sentry | Devs / ops |
| `docs/PLAN_BUG_REPORTS.md` | **Shipped:** staff bug reports (**101**–**103**; log snapshot, correlation id, triage, retention), **`POST /api/bug-reports`**, Settings **Bug reports** (**`settings.admin`**), Header/POS capture | Devs / ops |
| `docs/PODIUM_STOREFRONT_CSP_AND_PRIVACY.md` | CSP / privacy checklist for Podium widget on public storefront | Devs / ops |
| `docs/PLAN_SHIPPO_SHIPPING.md` | Shippo roadmap (labels, webhooks, fulfillment gates); shipped baseline in **`SHIPPING_AND_SHIPMENTS_HUB.md`** | Planning + devs |
| `docs/PLAN_ONLINE_STORE_MODULE.md` | Online store roadmap (Stripe checkout, reporting, assets) vs shipped baseline | Planning + devs |
| `docs/PLAN_ONLINE_STORE_UNIFIED_CUSTOMER.md` | **Goals only:** single **`customers`** base, web match/link, receipt-grade unified purchase history, separate surfaces vs “one box”; checkout paused | Product / planning |
| `docs/PLAN_MORNING_COMPASS_PREDICTIVE.md` | **Planning:** action-first Morning Compass queue; RBAC, POS vs Operations; client vs server ranker; links to notifications/tasks/reviews | Product / planning |
| `docs/ONLINE_STORE.md` | Public **`/shop`**, **`/api/store`** (catalog, cart, tax, shipping, **`/account/*`** JWT + rate limits), CMS + Studio, env | Devs / ops |
| `PLAN_GRAPESJS_RECEIPT_BUILDER.md` | GrapesJS Studio **document** receipt designer; Settings → **Receipt Builder** (own section); template JSON persistence; HTML vs thermal (**ZPL** / ESC-POS / raster) bridge — **`docs/ONLINE_STORE.md`** (Studio license) | Planning / devs |
| `docs/RECEIPT_BUILDER_AND_DELIVERY.md` | **Shipped:** Receipt Builder persistence, `receipt.html` merge, thermal modes (**ZPL** / **escpos_raster** / **studio_html**), Podium **email** (inline HTML) + **SMS/MMS** (PNG attachment or plain text), API summary | Devs / ops |
| `docs/PLAN_CONSTANT_CONTACT_INTEGRATION.md` | Future Constant Contact | Planning |
| `docs/INTEGRATIONS_SCOPE.md` | Canonical third-party posture (Stripe, Podium, Shippo, ADP, NuORDER, analytics) — not the online store spec | Architecture / ops |
| `tools/counterpoint-bridge/README.md` | Windows Counterpoint bridge | Ops / devs |
| `docs/COUNTERPOINT_SYNC_GUIDE.md` | Counterpoint sync end-to-end: server env, bridge install, Windows SQL queries, entity mapping, Settings UI monitoring, provenance | Ops / devs |
| `docs/COUNTERPOINT_BRIDGE_OPERATOR_MANUAL.md` | Bridge + staging vs direct ingest, hub tabs, prerequisites, upgrade steps, troubleshooting (companion to sync guide) | Ops / devs |
| `docs/COUNTERPOINT_ONE_TIME_IMPORT.md` | One-time migration runbook: entity order, `CP_IMPORT_SINCE` / `__CP_IMPORT_SINCE__`, store-credit opening + PS_DOC ingest, phase-2 PO note | Ops / devs |
| `docs/PLAN_COUNTERPOINT_ROS_SYNC.md` | Counterpoint v8.2 → ROS ingest map, bridge heartbeat (ONLINE/OFFLINE/SYNCING), Settings sync console, phased checklist | Devs / ops |
| `docs/NUORDER_INTEGRATION.md` | NuORDER posture, OAuth 1.0 architecture, catalog/media/order sync workflows, management UI | Devs / ops |

## Docs (quick links)

| Doc | Purpose |
|---|---|
| `DEVELOPER.md` | Architecture, API surface, domain concepts, runbooks |
| `docs/ONLINE_STORE.md` | Public **`/shop`**, **`/api/store`**, CMS + Studio, guest cart, customer accounts, coupons (**`online_store.manage`**) |
| `docs/PLAN_ONLINE_STORE_UNIFIED_CUSTOMER.md` | Deferred goals: unified web account + purchase history (single **`customers`** base); checkout paused |
| `docs/PLAN_MORNING_COMPASS_PREDICTIVE.md` | Planned action-first Morning Compass queue (register + Operations) |
| `AGENTS.md` | Coding-agent guide: invariants, where to edit, commands |
| `docs/staff/README.md` | Staff how-to hub, glossary/FAQ/error corpus, sidebar/POS coverage checklists, AI RAG corpus index |
| `docs/APPOINTMENTS_AND_CALENDAR.md` | ROS Appointments vs WM calendar, migration 33, customer search |
| `docs/WEATHER_VISUAL_CROSSING.md` | Visual Crossing, migrations 46–48, `/api/weather`, EOD refresh, daily pull cap |
| `docs/SEARCH_AND_PAGINATION.md` | Customer browse/search and inventory control-board: SQL semantics, optional Meilisearch, limits, UI paging, admin reindex |
| `docs/MANUAL_CREATION.md` | Ship `*-manual.md` under `client/src/assets/docs/`; `generate:help` + optional `generate:help:components` / `generate:help:components:rescan`; `ros_help` + `GET /api/help/search`; aidocs-cli capture — **`PLAN_HELP_CENTER.md`** |
| `docs/PLAN_NOTIFICATION_CENTER.md` | Inbox, **bundled** generators (`*_bundle`), admin morning digest, low-stock opt-in, **`task_due_soon_bundle`** — migrations **51–52**, **56**; backup + integration/PIN — **60–61**, **`docs/NOTIFICATION_GENERATORS_AND_OPS.md`** |
| `docs/STAFF_TASKS_AND_REGISTER_SHIFT.md` | Recurring staff tasks, lazy materialization, shift handoff, POS/Staff UI — **55–56** |
| `docs/STAFF_SCHEDULE_AND_CALENDAR.md` | Staff schedule API, DB function, Operations “Today’s floor team” — **57–58** |
| `docs/METABASE_REPORTING.md` | Back Office **Insights** = Metabase; Axum **`/metabase/*`** proxy; Phase 2 read-only DB role plan |
| `docs/REGISTER_DASHBOARD.md` | Register (POS) dashboard, **`GET /api/staff/self/register-metrics`**, morning-compass + activity-feed **`weddings.view`**, compact notifications + **archive**; predictive queue → **`PLAN_MORNING_COMPASS_PREDICTIVE.md`** |
| `docs/TILL_GROUP_AND_REGISTER_OPEN.md` | Multi-lane register, **`till_close_group_id`**, combined Z-close, satellite lanes, admin POS open flow |
| `docs/POS_PARKED_SALES_AND_RMS_CHARGES.md` | Parked (**68**) vs local **`ros_pos_active_sale`** draft, R2S charges vs payments (**69**), Customers → RMS charge, QBO clearing, **`GET /api/insights/rms-charges`** (+ Metabase when modeled) |
| `docs/RECEIPT_BUILDER_AND_DELIVERY.md` | Receipt Builder, thermal modes, **`receipt.html`**, Podium email + text/MMS |
| `docs/PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md` | Shippo + Podium + notifications + reviews completion matrix |
| `docs/PLAN_PODIUM_REVIEWS.md` | Post-sale review invites + Operations Reviews — partial (stub API) |
| `docs/OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md` | OTLP + **`tracing`** subscriber, bug-report log ring, `RUST_LOG` |
| `docs/PLAN_BUG_REPORTS.md` | In-app bug reports: API, Settings triage, migrations **101**–**103** (completed plan) |
| `docs/staff/bug-reports-submit-manual.md` | Staff: **Report a bug** flow (header/POS icon), screenshot opt-out, rate limits, privacy |
| `docs/staff/bug-reports-admin-manual.md` | **settings.admin:** Settings → **Bug reports** triage, exports, Fixed / Dismissed, retention |
| `docs/staff/pos-register-cart.md` | Register cart, cashier gate, local draft, Park, **`PAYMENT`** line |
| `INVENTORY_GUIDE.md` | Scanning engine, HID/Camera logic, physical inventory sessions, product hub low-stock flags |
| `docs/CATALOG_IMPORT.md` | Product CSV import (`POST /api/products/import`), Lightspeed preset, body limits, `vendor_code` |
| `docs/ORDERS_RETURNS_EXCHANGES.md` | Refund queue, line returns, exchange link, `orders.*` RBAC, register session read path |
| `docs/CUSTOMERS_LIGHTSPEED_REFERENCE.md` | Customer CRM vs Lightspeed: merge, groups, bulk import, search/history |
| `docs/CUSTOMER_HUB_AND_RBAC.md` | Hub drawer API + **`customers.*`** / **`orders.view`** gates (migrations **63**–**64**) |
| `docs/SHIPPING_AND_SHIPMENTS_HUB.md` | **`shipment`** registry (**75**), Shippo foundation (**74**), **`shipments.*`**, **`POST /api/pos/shipping/rates`**, **`POST /api/store/shipping/rates`** — pairs with **`docs/ONLINE_STORE.md`** for web quotes |
| `BACKUP_RESTORE_GUIDE.md` | DB maintenance, automated backups, cloud sync setup |
| `docs/LOCAL_UPDATE_PROTOCOL.md` | Local/offline version upgrades: backup, migrations, deploy, Tauri/PWA, rollback |
| `backend_audit_report.md` | Backend audit snapshot (2026-04-04): RBAC, money, transactions |
| `frontend_audit_report.md` | Frontend audit snapshot (2026-04-04): dialogs, PWA, tokens |
| `.cursorrules` | Non-negotiable coding constraints |
| `Riverside_OS_Master_Specification.md` | Domain vocabulary and product requirements |
| `ROS_AI_INTEGRATION_PLAN.md` | AI implementation roadmap (technical) |
| `docs/ROS_AI_HELP_CORPUS.md` | Staff help corpus ingest, hybrid retrieval, reindex, embeddings env |
| `docs/AI_REPORTING_DATA_CATALOG.md` | Reporting data sources (**§0** route inventory, curated Reports, permissions); Metabase (**`docs/METABASE_REPORTING.md`**) — pair with **`docs/AI_CONTEXT_FOR_ASSISTANTS.md`** |
| `docs/AI_CONTEXT_FOR_ASSISTANTS.md` | Assistants: staff corpus vs help search vs this catalog, RBAC, store SOP API, **ROSIE** / **`PLAN_LOCAL_LLM_HELP.md`** (not shipped) |
| `docs/CLIENT_UI_CONVENTIONS.md` | Client primitives, `useDialogAccessibility`, lazy workspaces, Wedding Manager embed (`type` on buttons) |
| `docs/RETIRED_DOCUMENT_SUMMARIES.md` | Removed-doc summaries (append-only) |
| `docs/COUNTERPOINT_SYNC_GUIDE.md` | Counterpoint sync end-to-end: server env, bridge install, entity mapping, Settings monitoring, provenance |
| `docs/COUNTERPOINT_BRIDGE_OPERATOR_MANUAL.md` | Bridge 0.7+, staging vs direct, hub ops, upgrades, troubleshooting |
| `docs/PLAN_COUNTERPOINT_ROS_SYNC.md` | Counterpoint SQL → ROS plan: schema mapping, gift/loyalty/tickets, Settings monitoring, bridge heartbeat states |
>>>>>>> de8935f (initial: Riverside OS baseline with CI enforcement and GH best practices)
