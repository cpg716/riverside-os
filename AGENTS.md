# AGENTS.md — Riverside OS

Instructions for coding agents (Cursor Agent, Codex, etc.) working in this repository.

## Read first

1. **`.cursorrules`** — Non-negotiable project rules (Rust/Axum/sqlx/money/handler thinness).
2. **`README.md`** — Documentation catalog (all first-party Markdown paths and roles).
3. **`CHANGELOG.md`** — Detailed version history and baseline (v0.1.0).
4. **`DEVELOPER.md`** — Full architecture, folder map, runbooks, API overview.
5. **`docs/STAFF_PERMISSIONS.md`** — Staff RBAC: keys, `staff_role_permission` / overrides, middleware, client `backofficeHeaders` + sidebar maps.
5. **`REMOTE_ACCESS_GUIDE.md`** — Setup and security for PWA/Tailscale access.
6. **`docs/PWA_AND_REGISTER_DEPLOYMENT_TASKS.md`** — Checklist for shipping PWA (primary) + Tauri register (desktop).
7. **`INVENTORY_GUIDE.md`** — Detailed scanning engine & physical inventory logic.
8. **`docs/APPOINTMENTS_AND_CALENDAR.md`** — ROS Appointments vs Wedding Manager, shared `wedding_appointments` API, migration 33, customer search when booking.
9. **`BACKUP_RESTORE_GUIDE.md`** — DB maintenance, pg_dump, and cloud sync setup.
10. **`docs/SPECIAL_AND_WEDDING_ORDERS.md`** — Rules around non-takeaway fulfillment, deposit liabilities vs revenue, and reserving stock pending arrival.
10. **`docs/DEPOSIT_OPERATIONS.md`** — Complete deposit lifecycle: layaway / special / wedding / split / open deposit types, POS register keypad flow, deposit-only completion, mixed carts, interim payments, fulfillment release, forfeiture, QBO journal mappings (`liability_deposit`, `income_forfeited_deposit`).
11. **`docs/CATALOG_IMPORT.md`** — `POST /api/products/import`, Lightspeed preset vs universal map, body limits, `supplier` / `supplier_code` → vendor + `vendor_code`, migration **35**.
11. **`docs/CUSTOMERS_LIGHTSPEED_REFERENCE.md`** — Customer CRM vs Lightspeed (merge, groups, bulk import/export, delete rules); ROS `customer_code` and import paths.
12. **`docs/CUSTOMER_HUB_AND_RBAC.md`** — Relationship Hub API ↔ **`customers.hub_view`**, **`hub_edit`**, **`timeline`**, **`measurements`**, **`orders.view`** (migrations **63**–**64** for hub keys + cashier **`customers_duplicate_review`** / **`customers.merge`** defaults); client gating in **`CustomerRelationshipHubDrawer`**.
13. **`docs/ORDERS_RETURNS_EXCHANGES.md`** — Refund queue, `orders.*` RBAC, line returns, exchange link, register `register_session_id` read path.
14. **`docs/SEARCH_AND_PAGINATION.md`** — Customer `browse` / `search` (`limit`/`offset`) and inventory **control-board** (optional **`product_id`** filter; **text `search`** ranked by **45-day parent-product units sold** before name/SKU; migrations **81–82** index **`order_items`** for aggregates); optional **Meilisearch** hybrid search (env **`RIVERSIDE_MEILISEARCH_*`**, `server/src/logic/meilisearch_*.rs`), SQL fallback, **Settings → Integrations** reindex, large-catalog UI (POS, CRM, appointments, Procurement Hub, `/shop` PLP). In-app Help full-text: index **`ros_help`**, **`GET /api/help/search`** — manuals = **`client/src/assets/docs/*-manual.md`** + **`npm run generate:help`** (optional **`npm run generate:help:components`** scaffolds stubs; **`npm run generate:help:components:rescan`** syncs `source` / link block for `auto-scaffold` manuals + warns orphans) — **`docs/MANUAL_CREATION.md`**, **`PLAN_HELP_CENTER.md`**. Planned local assistant **ROSIE** (**RiversideOS Intelligence Engine**), Help **Ask ROSIE**: **`docs/PLAN_LOCAL_LLM_HELP.md`** (PWA/Tauri parity, **`RIVERSIDE_LLAMA_UPSTREAM`**, **`VITE_ROSIE_LLM_*`**, Tauri **`RIVERSIDE_LLAMA_*`** — **`DEVELOPER.md`** Environment variables; **not shipped**); retirement pointer **`ROS_AI_INTEGRATION_PLAN.md`**.
15. **`docs/BOOKED_VS_FULFILLED.md`** — **Revenue recognition clock:** why NYS tax and commissions are **fulfilled-only**.
16. **`docs/LAYAWAY_OPERATIONS.md`** — **Layaway lifecycle:** deposits, inventory tracking as `on_layaway`, and revenue realization upon physical pickup.
17. **`docs/PRODUCT_ROADMAP_MENS_WEDDING_RETAIL.md`** — Men’s / wedding retail fit: strengths, **completed roadmap** vs optional backlog (purchase model).
16. **`docs/OFFLINE_OPERATIONAL_PLAYBOOK.md`** — What works offline (checkout queue), what does not, and floor procedure.
17. **`docs/WEATHER_VISUAL_CROSSING.md`** — Visual Crossing integration, migrations **46–48**, public `/api/weather/*`, EOD snapshot refresh, daily pull cap env vars, optional **`RIVERSIDE_VISUAL_CROSSING_API_KEY`** / **`RIVERSIDE_VISUAL_CROSSING_ENABLED`** (override DB `weather_config`; never log the key).
18. **`docs/PLAN_NOTIFICATION_CENTER.md`** — Shipped: PostgreSQL notification center + hourly generators + **admin morning digest** (**bundled** **`morning_*_bundle`** rows + refund summary; migrations **51–52**, env **`RIVERSIDE_MORNING_DIGEST_HOUR_LOCAL`**) + **`task_due_soon_bundle`** reminders (migration **56**). High-volume jobs **upsert** one **`app_notification`** per day (or per assignee+day for tasks); client **compact** inbox + expand/navigate — **`notificationBundle.ts`**, **`notificationDeepLink.ts`**. **Podium messaging** fan-out, **`read-all`**, **`messaging_unread_nudge`** — **`docs/PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md`**. **Backup + integration/PIN generators:** migrations **60–61** — **`docs/NOTIFICATION_GENERATORS_AND_OPS.md`**.
19. **`docs/PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md`** — **Master tracker:** Shippo labels/hub + **Podium CRM** (**99**+ threads, inbox, hub Messages, reply) + notification semantics + **reviews** (partial). Deep Podium env/receipt/widget: **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`**.
20. **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`** — Podium operational SMS (**`logic/podium.rs`**, **`messaging.rs`**, **`logic/podium_webhook.rs`**, **`logic/podium_inbound.rs`**, **`logic/podium_messaging.rs`**, **`api/webhooks.rs`**): migrations **70–71** + **99** (conversations/messages); Settings → **Integrations**; **Operations → Inbox** + hub **Messages**; env **`RIVERSIDE_PODIUM_*`**, **`VITE_STOREFRONT_EMBEDS`**.
21. **`docs/PLAN_PODIUM_REVIEWS.md`** — **Partial:** **`review_policy`**, receipt opt-out, **`POST /api/orders/{id}/review-invite`**, **Operations → Reviews**; **live** Podium review API TBD (**`read_reviews`** / **`write_reviews`** — verify current docs).
22. **`docs/STAFF_TASKS_AND_REGISTER_SHIFT.md`** — Recurring staff checklists (**`/api/tasks/*`**), lazy materialization, **`register_sessions.shift_primary_staff_id`**, **`register.shift_handoff`**, POS/Staff UI — migrations **55–56**.
23. **`docs/STAFF_SCHEDULE_AND_CALENDAR.md`** — Floor staff weekly + day exceptions, PostgreSQL **`staff_effective_working_day`**, **`/api/staff/schedule`**, morning-compass **`today_floor_staff`** — migrations **57–58**.
24. **`docs/REGISTER_DASHBOARD.md`** — POS **Dashboard** (default on register session open), **`GET /api/staff/self/register-metrics`**, **`weddings.view`** on morning-compass / activity-feed, notification **archive** (Dismiss).
25. **`docs/TILL_GROUP_AND_REGISTER_OPEN.md`** — Multi-lane register (**66**), till close group / combined Z-close (**67**), admin open-register UX, BO register gate — pair with **`docs/STAFF_PERMISSIONS.md`** till paragraph. **Parked cart + R2S ledger (migrations 68–69):** **`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`** (Z-close purges parked rows; **`rms_r2s_charge`** for **charge** tenders; **payment** line + **`customers.rms_charge`** admin list; QBO **`RMS_R2S_PAYMENT_CLEARING`**).
26. **`docs/RETIRED_DOCUMENT_SUMMARIES.md`** — Summaries of removed Markdown files (append-only).
27. **`docs/staff/README.md`** — Staff-facing how-to index; cross-cutting docs: **`GLOSSARY.md`**, **`FAQ.md`**, **`ERROR-AND-TOAST-GUIDE.md`**, **`EOD-AND-OPEN-CLOSE.md`**, **`PII-AND-CUSTOMER-DATA.md`**, **`STORE-SOP-TEMPLATE.md`**, **`abstracts/*.md`**. **Curated Reports:** **`docs/staff/reports-curated-manual.md`**, **`docs/staff/reports-curated-admin.md`**; in-app Help **`client/src/assets/docs/reports-manual.md`**. When you change **user-visible** workflows (new tab, renamed subsection, new cashier step), update the matching **`docs/staff/*.md`** in the same PR when practical (external manuals / training — not indexed in-app).
28. **`docs/AI_REPORTING_DATA_CATALOG.md`** — Reporting / **`/api/insights/*`** parameters, other read APIs, permission gates; keep in sync when adding analytics endpoints. Metabase + Insights shell: **`docs/PLAN_METABASE_INSIGHTS_EMBED.md`**, Phase 1 vs 2 data access: **`docs/METABASE_REPORTING.md`**. Booked vs fulfilled semantics: **`docs/REPORTING_BOOKED_AND_FULFILLED.md`** (migrations **106**–**107** for Metabase line margin columns).
29. **`docs/CLIENT_UI_CONVENTIONS.md`** — Client primitives, **`useDialogAccessibility`**, lazy Back Office tabs in **`App.tsx`**, density rules, embedded Wedding Manager (**`client/src/components/wedding-manager/`**) — wiring + explicit **`type`** on **`<button>`**; tab map in **`client/UI_WORKSPACE_INVENTORY.md`**. Root **`UI_STANDARDS.md`** covers zero-browser-dialog patterns. Full-app typography/theme sweep + Phase 5 QA: **`docs/ROS_UI_CONSISTENCY_PLAN.md`** (**Phases 1–5** complete, 2026-04-08; guest **`/shop`** deferred).
30. **`docs/SHIPPING_AND_SHIPMENTS_HUB.md`** — Shippo (**`SHIPPO_API_TOKEN`**), migrations **74**–**75**, **`/api/shipments`**, **`POST /api/pos/shipping/rates`**, **`POST /api/store/shipping/rates`**, Customers → Shipments + hub tab; labels/webhooks roadmap in **`docs/PLAN_SHIPPO_SHIPPING.md`**.
31. **`docs/ONLINE_STORE.md`** — Public **`/shop`**, **`GET/POST /api/store/*`** (catalog, pages, cart session, coupons, tax preview, **`/account/*`** JWT customer accounts + rate limits), **`/api/admin/store`** (**`online_store.manage`**), Settings → **Online store** + **GrapesJS Studio SDK** (**`VITE_GRAPESJS_STUDIO_LICENSE_KEY`**). Roadmap: **`docs/PLAN_ONLINE_STORE_MODULE.md`**.
32. **`docs/RECEIPT_BUILDER_AND_DELIVERY.md`** — Settings **Receipt Builder** persistence, **`receipt.html`** merge, thermal modes (**ZPL** / **escpos_raster** / **studio_html**), Podium **email** (inline HTML) + **SMS/MMS** (PNG attachment vs plain text); pair with **`PLAN_GRAPESJS_RECEIPT_BUILDER.md`**, **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`**.
33. **`docs/PLAN_BUG_REPORTS.md`** — **Shipped:** in-app staff bug reports (**`staff_bug_report`**, migrations **101**–**103**; correlation id, **`dismissed`**, triage fields, admin notifications, retention, optional **`VITE_SENTRY_DSN`**): **`POST /api/bug-reports`**, Settings → **Bug reports** (**`settings.admin`**), Header + POS bug trigger — see plan for API + file map. **Staff-facing:** **`docs/staff/bug-reports-submit-manual.md`**, **`docs/staff/bug-reports-admin-manual.md`**.
34. **`docs/OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md`** — Server **`tracing`** subscriber (**`RUST_LOG`**), optional **OpenTelemetry OTLP** traces (**`OTEL_*`**, **`RIVERSIDE_OTEL_ENABLED`**), **`ServerLogRing`** + **`TraceLayer`**, shutdown; independent of client Sentry.
35. **`docs/WISEPOS_E_SETUP_STRIPE.md`** — Stripe Terminal WisePOS E reset and server-driven flow.

## What this repo is

**Riverside OS** = PostgreSQL + **Rust Axum API** (`server/`) + **React/Vite UI** (`client/`) packaged with **Tauri 2** (`client/src-tauri/`). Primary codepaths: **POS**, **inventory**, **weddings**, **customers**, **sessions**.
Tauri 2 is utilized directly for native **Hardware Bridging** (e.g., async TCP ESC/POS thermal printing via `src-tauri/src/hardware.rs`).

**`NexoPOS-master/`**, **`odoo-19.0/`**, and **`riverside-wedding-manager/`** are **not** part of the minimal workspace (see root **`.gitignore`**). Clone those upstream projects only when a task explicitly needs them for comparison or porting; they are **not** ROS build dependencies.

## Where to make changes

| Task | Likely locations |
|------|------------------|
| New REST endpoint | `server/src/api/<module>.rs`, register in `server/src/api/mod.rs` |
| Business / tax / pricing rules | `server/src/logic/`, `server/src/services/` — **not** inside handlers |
| SQL types / enums | `server/src/models/mod.rs` + matching PostgreSQL enums |
| New UI screen / tab | `client/src/App.tsx` + `client/src/components/...` + `Sidebar.tsx` if new tab |
| Reporting / Metabase Insights / commission payouts | `server/src/api/insights.rs`, `server/src/logic/margin_pivot.rs` (Admin-only gross margin pivot), `server/src/api/metabase_proxy.rs`, `client/src/components/layout/InsightsShell.tsx`, `client/src/components/reports/ReportsWorkspace.tsx`, `client/src/lib/reportsCatalog.ts`, `client/src/components/staff/CommissionPayoutsPanel.tsx` |
| POS / checkout UX | `client/src/components/pos/` — includes **`PosSaleCashierSignInOverlay`**, **`ReceiptSummaryModal`**, **`Cart.tsx`**, **`NexoCheckoutDrawer.tsx`** |
| **Register (POS) dashboard** | `client/src/components/pos/RegisterDashboard.tsx`, `PosShell.tsx` (default tab on new session), `PosSidebar.tsx` (**Dashboard** rail); `GET /api/staff/self/register-metrics` — `server/src/logic/register_staff_metrics.rs`, `server/src/api/staff.rs`; **`BackofficeAuthContext`** **`staffRole`**. See **`docs/REGISTER_DASHBOARD.md`**. |
| **Till group / multi-lane Z** | `server/src/api/sessions.rs` (`open_session`, `build_reconciliation`, `close_session`, `list_open_sessions`); `client/src/components/pos/RegisterOverlay.tsx`, `CloseRegisterModal.tsx`, `zReportPrint.ts`; `client/src/context/RegisterGateContext.tsx`, `client/src/components/layout/RegisterRequiredModal.tsx`. Migrations **66–67**. See **`docs/TILL_GROUP_AND_REGISTER_OPEN.md`**. |
| **Parked sales + R2S charges / payments** | `server/src/logic/pos_parked_sales.rs`, `server/src/logic/pos_rms_charge.rs`, `server/src/api/pos_parked_sales.rs` (under **`/api/sessions`**), `server/src/api/pos.rs` (**`/api/pos/rms-payment-line-meta`**), checkout in `server/src/logic/order_checkout.rs`, **`server/src/logic/qbo_journal.rs`** (**`RMS_R2S_PAYMENT_CLEARING`**), ad-hoc tasks in `server/src/logic/tasks.rs`; **`GET /api/insights/rms-charges`**, **`GET /api/customers/rms-charge/records`** (`customers.rs`). Client: `posParkedSales.ts`, **`Cart.tsx`** (**`PAYMENT`** search injection), **`NexoCheckoutDrawer.tsx`** (cash/check-only payment mode + **check** tender), **`RmsChargeAdminSection.tsx`**. Migrations **68–69**. See **`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`**. |
| Shell / drawers / backdrop | `client/src/components/layout/` |
| Register session bootstrap (till hydrate + admin shell routing) | `client/src/components/layout/RegisterSessionBootstrap.tsx` — **`applyShellForLoggedInRole`** only when register **`session_id` changes**; **`docs/ROS_UI_CONSISTENCY_PLAN.md`** Phase 5 |
| UX density / primitives | `client/src/index.css`, `client/tailwind.config.js`, `client/src/App.tsx`; conventions in **`docs/CLIENT_UI_CONVENTIONS.md`**, tab map **`client/UI_WORKSPACE_INVENTORY.md`** |
| Client modal a11y hook | `client/src/hooks/useDialogAccessibility.ts` (focus trap, restore, optional Escape) — see **`docs/CLIENT_UI_CONVENTIONS.md`** |
| Embedded Wedding Manager (JSX) | `client/src/components/wedding-manager/**` — preserve look/feel; **`ModalContext`**, **`GlobalModal`**, explicit **`type`** on buttons — **`docs/CLIENT_UI_CONVENTIONS.md`**. **Action Dashboard** loads **`GET /api/weddings/actions`** (embedded WM **`useDashboardActions`**) — rows include **`party_balance_due`**; quick **Done** uses **emerald terminal** styling (POS parity). **Party detail** measure/fitting gates use **scoped appointment fetch** + cache (`PartyDetail.jsx`). |
| Schema change | New file in `migrations/` (ordered prefix `NN_description.sql`), then align Rust models |
| Admin auth | `server/src/middleware/mod.rs` + `server/src/auth/pins.rs` |
| Receipt config / Receipt Builder / Podium receipt send | `server/src/api/settings.rs` → **`ReceiptConfig`**; merge **`receipt_studio_html.rs`**; orders **`receipt.html`**, **`receipt/send-email`**, **`receipt/send-sms`**; client **`ReceiptBuilderPanel`**, **`ReceiptStudioEditor`**, **`ReceiptSummaryModal`** — **`docs/RECEIPT_BUILDER_AND_DELIVERY.md`** |
| **Weather / Visual Crossing** | `server/src/logic/weather.rs`, `server/src/api/weather.rs`, `server/src/api/settings.rs` (weather endpoints + `weather_config` + effective settings after env); UI **`SettingsWorkspace`** Integrations; **`docs/WEATHER_VISUAL_CROSSING.md`** |
| **Podium SMS + CRM threads + storefront widget** | `server/src/logic/podium.rs`, `podium_webhook.rs`, `podium_inbound.rs`, `podium_messaging.rs`, `messaging.rs`, `server/src/api/settings.rs`, `webhooks.rs`, `public_api.rs`, customer podium routes in `customers.rs`; migrations **70–71**, **99**; client Settings + **`StorefrontEmbedHost`** + **Operations → Inbox** + hub Messages; env **`RIVERSIDE_PODIUM_*`**, **`VITE_STOREFRONT_EMBEDS`** — **`docs/PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md`**, **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`**, **`docs/PODIUM_STOREFRONT_CSP_AND_PRIVACY.md`** |
| **Meilisearch (optional fuzzy search)** | `server/src/logic/meilisearch_client.rs`, `meilisearch_documents.rs`, `meilisearch_search.rs`, `meilisearch_sync.rs`, **`help_corpus.rs`** (`ros_help`); hooks in `products.rs`, `customers.rs`, `orders.rs`, `weddings.rs`, `store_catalog.rs`; **`GET /api/settings/meilisearch/status`**, **`POST /api/settings/meilisearch/reindex`**, **`GET /api/help/search`** (`api/help.rs`); Docker Compose **`meilisearch`**; client **`SettingsWorkspace`** Integrations card, **`HelpCenterDrawer`** + **`client/src/lib/help/**`; **`scripts/ros-meilisearch-reindex-local.sh`** — **`docs/SEARCH_AND_PAGINATION.md`**, **`docs/MANUAL_CREATION.md`**, **`docs/STORE_DEPLOYMENT_GUIDE.md`** |
| **Online store (public `/shop` + CMS)** | `server/src/api/store.rs` (**`/api/store`**, **`/api/admin/store`**), `server/src/api/store_account.rs`, `server/src/api/store_account_rate.rs`, `server/src/logic/store_catalog.rs`, `store_promotions.rs`, `store_tax.rs`; client **`PublicStorefront.tsx`** (`/shop`, `/shop/account/*`), **`main.tsx`**, **`ui-shadcn/`**, **`OnlineStoreSettingsPanel.tsx`**, **`StorePageStudioEditor.tsx`** (**`@grapesjs/studio-sdk`**, lazy); migrations **73**, **76**–**77**; **`online_store.manage`** — **`docs/ONLINE_STORE.md`**, **`docs/PLAN_ONLINE_STORE_MODULE.md`** |
| Database / Backups | `server/src/api/settings.rs`, `server/src/logic/backups.rs` |
| Physical Inventory | `server/src/api/physical_inventory.rs`, `server/src/logic/physical_inventory.rs` |
| **Orders refunds / returns / exchanges** | `server/src/api/orders.rs`, `server/src/logic/order_recalc.rs`, `server/src/logic/order_returns.rs`, `server/src/logic/gift_card_ops.rs`; UI `client/src/components/orders/OrdersWorkspace.tsx`; see **`docs/ORDERS_RETURNS_EXCHANGES.md`** |
| **Catalog CSV import** | `server/src/logic/importer.rs`, `server/src/api/products.rs` (`POST /import`); UI `client/src/components/inventory/UniversalImporter.tsx`; see **`docs/CATALOG_IMPORT.md`** |
| **Appointments (store calendar)** | `client/src/components/scheduler/` — `SchedulerWorkspace.tsx`, `AppointmentModal.tsx`; API `client/src/lib/weddingApi.ts` + `POST/GET /api/weddings/appointments`. See **`docs/APPOINTMENTS_AND_CALENDAR.md`**. |
| **Inventory list (Back Office)** | `client/src/components/inventory/InventoryControlBoard.tsx`, `InventoryWorkspace.tsx`, **`ProductHubDrawer.tsx`** / **`MatrixHubGrid.tsx`** (template + per-SKU **`track_low_stock`**) — shared **`ui-input`** / app tokens for filters and table edits; **`GET /api/inventory/control-board`** paging via `limit`/`offset` (**`docs/SEARCH_AND_PAGINATION.md`**). **`ReceivingBay`**: **Post inventory** = **`bg-emerald-600`** + **`border-b-8 border-emerald-800`** (terminal completion pattern). Migration **52** + **`docs/PLAN_NOTIFICATION_CENTER.md`**. |
| Customers CRM (browse, add, hub, duplicate queue, RMS charge, shipments) | `client/src/components/customers/CustomersWorkspace.tsx`, `DuplicateReviewQueueSection.tsx`, `CustomerRelationshipHubDrawer.tsx`, **`RmsChargeAdminSection.tsx`** (**Customers → RMS charge**, **`customers.rms_charge`**), **`ShipmentsHubSection.tsx`** (**Customers → Shipments**, **`shipments.view`** / **`shipments.manage`**; hub **Shipments** tab). Browse uses **`GET /api/customers/browse`** with **`limit`/`offset`** (**Load more**). Hub + **Duplicate review** (sidebar): **`docs/CUSTOMER_HUB_AND_RBAC.md`**, **`customers_duplicate_review`**; migrations **63**–**65**, **69** (**`customers.rms_charge`**), **75** (**`shipment`** / **`docs/SHIPPING_AND_SHIPMENTS_HUB.md`**). Wire **`onNavigateSubSection`** from `App.tsx` → `AppMainColumn` → `CustomersWorkspace` so sidebar **Add Customer** stays in sync when the slideout closes. |
| **Notification center** | `server/src/api/notifications.rs` (incl. **`POST /.../archive`** user dismiss), `server/src/logic/notifications.rs` (**`upsert_app_notification_by_dedupe`**, **`delete_app_notification_by_dedupe`**), `server/src/logic/notifications_jobs.rs` (**`*_bundle`** hourly sweeps); client `NotificationCenterContext.tsx`, `notifications/*`, **`lib/notificationBundle.ts`**, **`lib/notificationDeepLink.ts`**, bell on **`Header`**, **`PosShell`**, **`WeddingShell`**; compact preview on **`RegisterDashboard`**. Migrations **51** (inbox tables + RBAC), **52** (low-stock flags + **`morning_digest_ledger`**), **56** (**`task_due_soon_bundle`**), **60** (`store_backup_health`), **61** (`integration_alert_state`, `staff_auth_failure_event`). Checkout-driven **`rms_r2s_charge`** for **RMS/RMS90 charge** tenders (migration **68**); **payment** collections use **tasks** (migration **69**) — **`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`**. See **`docs/PLAN_NOTIFICATION_CENTER.md`** and **`docs/NOTIFICATION_GENERATORS_AND_OPS.md`**. |
| **Staff tasks & register shift** | `server/src/api/tasks.rs`, `server/src/logic/tasks.rs`; `client/src/components/tasks/*`, **Staff → Tasks**, **Operations** My tasks, **PosSidebar → Tasks**; **`RegisterShiftHandoffModal`**. Migrations **55–56**. See **`docs/STAFF_TASKS_AND_REGISTER_SHIFT.md`**. |
| **Staff schedule (floor)** | `server/src/logic/staff_schedule.rs`, `server/src/api/staff_schedule.rs` (nested under **`/api/staff/schedule`**); **Staff → Schedule**; Operations **Today’s floor team** via **`morning-compass.today_floor_staff`**. Migrations **57–58**. See **`docs/STAFF_SCHEDULE_AND_CALENDAR.md`**. |
| **Staff help docs (reference)** | `docs/staff/*.md` (task guides), hub [`docs/staff/README.md`](docs/staff/README.md). Keep in sync with [`Sidebar.tsx`](client/src/components/layout/Sidebar.tsx) / [`PosSidebar.tsx`](client/src/components/pos/PosSidebar.tsx) labels when workflows change. |
| **Reporting data catalog** | [`docs/AI_REPORTING_DATA_CATALOG.md`](docs/AI_REPORTING_DATA_CATALOG.md) — document new **`/api/insights/*`** query params and analytics-related routes when shipping report features. Metabase + Insights: [`docs/PLAN_METABASE_INSIGHTS_EMBED.md`](docs/PLAN_METABASE_INSIGHTS_EMBED.md), [`docs/METABASE_REPORTING.md`](docs/METABASE_REPORTING.md). |
| **Staff bug reports** | `server/src/api/bug_reports.rs`, `server/src/logic/bug_reports.rs`; **`server/src/observability/server_log_ring.rs`**; retention cron in **`main.rs`** (`RIVERSIDE_BUG_REPORT_RETENTION_DAYS`); **`POST /api/bug-reports`**, **`GET`/`PATCH /api/settings/bug-reports*`**; notifications to **`settings.admin`**; client **`BugReportFlow`** (+ optional **`@sentry/react`**), **`BugReportsSettingsPanel`**; migrations **101**–**103** — **`docs/PLAN_BUG_REPORTS.md`**. |
| **Tracing + optional OTLP** | **`server/src/observability/otel.rs`**, **`server/src/observability/server_log_ring.rs`**, **`init_tracing_with_optional_otel`** + **`TraceLayer`** + OTLP shutdown in **`server/src/main.rs`** — **`docs/OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md`**. |
| Schema change (ceiling) | **Migration 113** — See `migrations/` for full set; use probes in `scripts/ros_migration_build_probes.sql` |

## Invariants (enforceable — never break these)

- **Money on server**: `rust_decimal::Decimal` — never `f32`/`f64` for currency.
- **Axum state**: `build_router()` returns `Router<AppState>`; **only `main.rs`** calls `.with_state(state)` before `serve`.
- **sqlx**: Prefer `query_as` + `bind`. For "not found", use explicit matching / domain errors — do not blindly `?` `sqlx::Error` into generic 500s when a 404 is correct.
- **Handlers**: Parse input, call service/DB, return JSON — no embedded tax tables or employee pricing math.
- **No `eprintln!`**: Use `tracing::error!` / `tracing::warn!` with structured key-value pairs (`error = %e`).
- **Transactions**: Any handler that does >1 mutation must use `db.begin()` _before_ the first mutation and `tx.commit()` at the end. Never call `.execute(&state.db)` between transaction steps.
- **Zero-Browser-Dialog**: **Mandatory**. Never use `alert()`, `confirm()`, or `prompt()`. Use `useToast()` for feedback and `ConfirmationModal` / `PromptModal` for user intent.
- **Client API usage**: Prefer native `fetch` over `axios` for all new endpoints to maintain zero-dependency consistency.
- **React Hooks**: All hooks (`useState`, `useEffect`, `useMemo`, `useCallback`, `useRef`, etc.) MUST be declared at the top level of the component function, *before* any conditional `return` statements or logic. `eslint-plugin-react-hooks` is enabled in `client/` to enforce this.
- **Hook Stability**: All async functions in `useEffect` MUST be wrapped in `useCallback`.
- **Zero-Error Baseline**: Code must pass `npm run lint` with 0 Errors.
- **Fast Refresh / Logic Separation**: Files containing React components should strictly only export the component(s). Move shared logic, types, and constants to dedicated `.ts` logic files (e.g., `ComponentLogic.ts`). **Context providers** must be split from their context/hooks into a `*Logic.ts` sibling to maintain zero lint warnings.
- **Versioning**: All modules (`client`, `server`, `tauri`) must stay synchronized with the version in the root `package.json`. Follow [SemVer](https://semver.org) for all tags and releases.
- **No dev bypasses**: Auth middleware and PIN verification are production-enforced. Do not re-add `let _ = pin;` or similar shortcuts.

## Auth model (do not modify without understanding)

```
Back Office gated routes:
  Header: x-riverside-staff-code   (required)
  Header: x-riverside-staff-pin    (required when pin_hash is set for that staff member)
  Permission: route-specific key checked by middleware::require_staff_with_permission
  Admin role: DbStaffRole::Admin implies full permission catalog (cannot lock out via empty role rows)

POS routes:
  authenticate_pos_staff() — verifies cashier_code + PIN when present
```

## Special / custom order stock model

```
Checkout         →  stock_on_hand unchanged for special_order / wedding_order / layaway lines (legacy `custom` merged into special_order; not offered in UI)
PO receipt       →  stock_on_hand += qty  AND  reserved_stock += min(qty, open_special_qty)
Pickup (fulfill) →  stock_on_hand -= qty  AND  reserved_stock -= qty (if reserved) OR on_layaway -= qty (if layaway)
available_stock  =  stock_on_hand - reserved_stock - on_layaway (computed in services/inventory.rs)
```

Do not write code that decrements `stock_on_hand` at checkout time for `DbFulfillmentType::SpecialOrder` or `DbFulfillmentType::Custom`.

## Wedding Group Payments (Disbursements)

All multi-member group payments are handled via the `wedding_disbursements` array in the `CheckoutRequest`.

```rust
// Disbursement structure
struct WeddingDisbursement {
    wedding_member_id: Uuid,
    amount: Decimal,
}

// Logic:
// 1. Primary payment_transaction is created for the Payer.
// 2. Individual payment_allocation rows are created for each beneficiary in the disbursements array.
// 3. Beneficiary order balance_due is updated via `recalc_order_totals`.
```

**Checkout contract:** `total_price` on `CheckoutRequest` is **lines + shipping only**; **do not** add `wedding_disbursements` amounts into `total_price`. Collected `amount_paid` funds both the order (`amount_paid` − sum(disbursements) toward `total_price`) and party payouts. If a beneficiary has **no** open order, the disbursement amount is **credited** to **`customer_open_deposit_*`** (migration **83**) instead of skipped.

Do not manually decrement balances without creating the corresponding `payment_allocation` entry.

## Axum Static Gateway
The backend serves the built `client/dist` folder via `tower-http` Fallback.
- **Rules**: Never add `127.0.0.1` hardcodes to the server listener; always use `0.0.0.0` or an environment-driven IP to enable Tailscale/PWA mesh access.
- **SPA Routing**: All non-API routes must serve `index.html` to allow React Router to handle deep links.

## Observability pattern

```rust
// Error logging
tracing::error!(error = %e, "Descriptive message about where/what failed");

// Audit / business events
tracing::info!(staff_id = %id, event = "commission_finalize", "Finalized payout");

// Webhooks
// All external system syncing (e.g. order checkouts) run asynchronously via `tokio::spawn` and `reqwest::Client`.
```

## Messaging & Notifications

Automated customer pings are handled by `MessagingService` in `server/src/logic/messaging.rs`.

- **Trigger**: Hooked into `mark_order_pickup` and status changes in `orders.rs`.
- **Logic**: Async dispatcher (`handle_status_change`) checks `marketing_sms_opt_in` / `marketing_email_opt_in` before logging/sending.
- **Provider**: Currently uses structured tracing logs; upgrade to Twilio/Resend by providing keys in `.env`.

## Logistics & Printing (ZPL)

The system supports multiple thermal print modes via `orders::build_receipt_zpl`.

- **Receipt**: Standard customer copy.
- **Bag Tag**: `?mode=bag-tag` generates 2x1 labels for every physical item in the order (customer name, SKU, order ref).
- **Zebra Layouts**: Optimized for 203dpi/300dpi thermal heads at 400px width.

## Commands

```bash
npm run check:server   # or: cd server && rustup run 1.88 cargo check (requires clippy/rustfmt components)
npm run bump           # node scripts/bump-version.mjs <new_version> (updates all modules)
cd client && npm run build
# Local dev (Postgres must be up: docker compose up -d): from repo root, after `npm install` once at root:
npm run dev
# Optional Meilisearch: docker compose up -d meilisearch — set RIVERSIDE_MEILISEARCH_* in server/.env, then:
# ./scripts/ros-meilisearch-reindex-local.sh   # or Settings → Integrations → Rebuild search index
```

E2E / snapshots:

```bash
cd client
npm run test:e2e -- --list
E2E_BASE_URL="http://localhost:5173" npm run test:e2e
E2E_BASE_URL="http://localhost:5173" npx playwright test --workers=1   # recommended full-suite ordering
E2E_BASE_URL="http://localhost:5173" npm run test:e2e:update-snapshots
```

**Regression map:** **`docs/E2E_REGRESSION_MATRIX.md`** lists every Playwright spec, **`api-gates`** checks, workspace gaps, and CI notes — **update it when you add or change E2E coverage**.

Back Office Playwright specs must pass **`signInToBackOffice`** from **`client/e2e/helpers/backofficeSignIn.ts`** when the UI shows **Sign in to Back Office** (unless **`E2E_STAFF_CODE`** / **`E2E_STAFF_PIN`** headers already satisfy the shell). Keypad default staff code is **`1234`** or **`E2E_BO_STAFF_CODE`**; match migration **`53_default_admin_chris_g_pin.sql`** / **`docs/STAFF_PERMISSIONS.md`**. **`NumericPinKeypad`** exposes **`data-testid`** values **`pin-key-0`…`pin-key-9`** and **`pin-key-del`** for E2E. If QBO or Staff nav flakes with an **open till**, confirm **`RegisterSessionBootstrap`** only reapplies the admin “Operations home” shell when the register **`session_id`** changes — **`docs/ROS_UI_CONSISTENCY_PLAN.md`** Phase 5.

Database: **Local dev** uses Docker Compose **`db`** ([`docker-compose.yml`](docker-compose.yml)); the image is **`pgvector/pgvector:pg16`** so migration **62** can install **`vector`** (migration **78** may drop **`vector`** when AI tables are retired — follow probes). The same Compose file defines optional **`meilisearch`** (**`localhost:7700`**) for fuzzy search when **`RIVERSIDE_MEILISEARCH_URL`** is set — **`docs/SEARCH_AND_PAGINATION.md`**. **`DATABASE_URL` must use `localhost:5433`** (Compose maps host **5433** → container **5432**) so the API does not connect to a native Postgres on **5432** by mistake. **`public.ros_schema_migrations`** records applied files (basename = `migrations/NN_*.sql`). From repo root: `./scripts/apply-migrations-docker.sh` applies only files not in the ledger; `./scripts/migration-status-docker.sh` compares ledger vs schema probes; `./scripts/backfill-migration-ledger-docker.sh` adds ledger rows where probes pass (existing DBs that predate the ledger). Bootstrap is `migrations/00_ros_migration_ledger.sql`. Current migration files: **00–106** (see `migrations/`; **33** = general / walk-in appointments + `customer_id` on `wedding_appointments`; **34** = staff phone/email + `staff_role_permission` / `staff_permission_override`; **35** = **`vendors.vendor_code`**; **36** = **`orders.*` permission seeds**; **37** = **`order_return_lines`**, **`orders.exchange_group_id`**; **38** = **`register_sessions.pos_api_token`**, **`orders.checkout_client_id`** + idempotency index; **39** = extended **`staff_role_permission`** seeds — **`catalog.*`**, **`procurement.*`**, **`settings.admin`**, **`gift_cards.manage`**, **`loyalty.program_settings`**, **`weddings.*`**, **`register.reports`**; **40** = **`staff_role_pricing_limits`**; **41** = **`discount_events`** + **`discount_event_variants`**; **42** = roadmap batch (**`alteration_orders`**, customer groups, **`product_bundle_components`**, store credit); **43** = **`customer_measurements`** retail columns, **`products.is_bundle`**, RBAC seeds; **44** = **`discount_event_usage`**, **`wedding_insight_saved_views`**, **`alteration_activity`**; **45** = drop **`staff_mfa_sessions`** and staff **`mfa_*`** columns; **46** = **`store_settings.weather_config`**; **47** = **`weather_snapshot_finalize_ledger`**; **48** = **`weather_vc_daily_usage`**; **49** = **`orders.void_sale`** RBAC seed; **50** = **`suit_component_swap_events`**, **`orders.suit_component_swap`**, **`register.open_drawer`** seeds; **51** = **`app_notification`**, **`staff_notification`**, **`staff_notification_action`**, **`notifications.view`** / **`notifications.broadcast`** seeds; **52** = **`products.track_low_stock`**, **`product_variants.track_low_stock`**, **`morning_digest_ledger`**; **53** = default admin **Chris G** bootstrap, **`cashier_code` 1234**, Argon2 PIN hash for **1234**; **54** = **`staff.avatar_key`** for bundled profile icons; **55** = **`register_sessions.shift_primary_staff_id`**, **`register.shift_handoff`**; **56** = staff recurring tasks, **`tasks.*`**, **`task_due_soon`**; **57** = staff schedule tables + **`staff_effective_working_day`**; **58** = SQL **`COMMENT ON`** for schedule objects; **59** = **`store_settings.staff_sop_markdown`** store staff playbook for Settings + **`GET /api/staff/store-sop`**; **60** = **`store_backup_health`** singleton for backup success/failure timestamps + admin notifications; **61** = **`integration_alert_state`**, **`staff_auth_failure_event`** for integration + PIN-failure notification generators; **62** = ROS **AI** platform (**pgvector**, **`ai_doc_chunk`** incl. **`embedding vector(384)`** filled at reindex via **`fastembed`**, **`ai_saved_report`**, **`customer_duplicate_review_queue`**, RBAC **`ai_assist`**, **`ai_reports`**, **`customers_duplicate_review`**) — **`docs/ROS_AI_HELP_CORPUS.md`**; **63** = customer hub RBAC (**`customers.hub_view`**, **`customers.hub_edit`**, **`customers.timeline`**, **`customers.measurements`**); **64** = **`salesperson`** / **`sales_support`** **`customers_duplicate_review`** + **`customers.merge`**; **65** = **`pg_trgm`** + **`ai_doc_chunk`** trigram index (lexical leg of hybrid help retrieval) — **`docs/ROS_AI_HELP_CORPUS.md`**; **66** = **`register_sessions.register_lane`**, **`register.session_attach`**; **67** = **`register_sessions.till_close_group_id`**, combined Z-close / satellite lanes — **`docs/TILL_GROUP_AND_REGISTER_OPEN.md`**; **68** = **`pos_parked_sale`** (+ audit), **`pos_rms_charge_record`**, checkout **RMS** / **RMS90** → **`rms_r2s_charge`** notifications — **`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`**; **69** = R2S **payment** line (**`pos_line_kind`**), **`record_kind`**, **`customers.rms_charge`**, QBO **`RMS_R2S_PAYMENT_CLEARING`**, ad-hoc tasks — **`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`**; **70** = **`store_settings.podium_sms_config`** (Podium operational SMS + storefront widget) — **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`**; **71** = **`customers.transactional_sms_opt_in`**, **`podium_webhook_delivery`** (inbound webhook idempotency) — **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`**; **72** = **`transactional_email_opt_in`**, **`podium_conversation_url`**; **73** = online store (**`sale_channel`**, pages, coupons, **`online_store.manage`**) — **`docs/PLAN_ONLINE_STORE_MODULE.md`**; **74** = Shippo columns + **`shippo_config`** + **`store_shipping_rate_quote`**; **75** = **`shipment`**, **`shipment_event`**, **`shipments.view`** / **`shipments.manage`** — **`docs/SHIPPING_AND_SHIPMENTS_HUB.md`**; **76** = **`store_guest_cart`**, **`store_media_asset`** — **`docs/ONLINE_STORE.md`**; **77** = **`customers.customer_created_source`**, **`customer_online_credential`**, public **`/api/store/account/*`** (JWT + rate limits) — **`docs/ONLINE_STORE.md`**; **78** = retire ROS-AI DB artifacts (**`ai_doc_chunk`**, **`ai_saved_report`**, **`vector`**, **`ai_assist`** / **`ai_reports`** RBAC rows); **79** = **`help_manual_policy`** + **`help.manage`** (Help Center overrides / visibility). Weather integration and pull limits: **`docs/WEATHER_VISUAL_CROSSING.md`**. Notification center + morning digest + task reminders: **`docs/PLAN_NOTIFICATION_CENTER.md`**, **`docs/STAFF_TASKS_AND_REGISTER_SHIFT.md`**. Staff schedule + morning dashboard floor list: **`docs/STAFF_SCHEDULE_AND_CALENDAR.md`**. **`scripts/ros_migration_build_probes.sql`** includes probes through **106** for **`migration-status-docker.sh`**. **80** = internal **`pos_gift_card_load`** catalog line; **81** = **`idx_order_items_variant_id`**; **82** = **`idx_order_items_product_id`** (parent-product popularity for **`control-board?search=`**) — **`docs/SEARCH_AND_PAGINATION.md`**; **83** = **`customer_open_deposit_accounts`** + ledger — party deposits / **`open_deposit`** checkout — **`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`**; **84** = **Counterpoint sync extended**: **`counterpoint_bridge_heartbeat`**, **`counterpoint_sync_request`**, **`counterpoint_sync_issue`**, **`orders.counterpoint_ticket_ref`** (unique), **`orders.is_counterpoint_import`**, mapping tables (`counterpoint_category_map`, `counterpoint_payment_method_map`, `counterpoint_gift_reason_map`) — **`docs/PLAN_COUNTERPOINT_ROS_SYNC.md`**; **85** = **Counterpoint provenance**: widen **`customers.customer_created_source`** CHECK to include **`counterpoint`**; add **`products.data_source`** (`NULL` = ROS-native, `'counterpoint'` = Counterpoint import). **86**–**97** (Counterpoint staff + catalog extensions, **`reporting`** / Metabase views, employee-pricing scopes, staging UI, business-day reporting, **`staff_permission`** + per-staff discount — **97**) — full rows in **`DEVELOPER.md`**. **98**–**106**: Shippo label rate reference on **`shipment`**, Podium messaging + review invite columns/RBAC (**99**), **`store_settings.review_policy`** (**100**), **`staff_bug_report`** + triage/retention (**101**–**103** — **`docs/PLAN_BUG_REPORTS.md`**), **`podium_message.podium_sender_name`** (**104** — **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`**), **`store_register_eod_snapshot`** (**105**), **`reporting.order_recognition_at`** + recognition views (**106** — **`docs/REPORTING_BOOKED_AND_RECOGNITION.md`**, **`docs/METABASE_REPORTING.md`**). **108**: **NuORDER integration** — `store_settings.nuorder_config`, `vendors.nuorder_brand_id`, `nuorder.manage` / `nuorder.sync` RBAC — **`docs/NUORDER_INTEGRATION.md`**.

**Counterpoint sync**: Server env `COUNTERPOINT_SYNC_TOKEN` enables `/api/sync/counterpoint/*` for the Windows bridge in [`counterpoint-bridge/`](counterpoint-bridge/) (see also `tools/counterpoint-bridge/` if present). Roadmap: [`docs/PLAN_COUNTERPOINT_ROS_SYNC.md`](docs/PLAN_COUNTERPOINT_ROS_SYNC.md). Do not log the token; prefer HTTPS when ROS is not localhost. **Migration 84** adds `counterpoint_bridge_heartbeat` (singleton), `counterpoint_sync_request`, `counterpoint_sync_issue`, `orders.counterpoint_ticket_ref` (unique), `orders.is_counterpoint_import`, and mapping tables (`counterpoint_category_map`, `counterpoint_payment_method_map`, `counterpoint_gift_reason_map`). M2M ingest endpoints: `POST .../heartbeat`, `catalog`, `gift-cards`, `tickets`, `ack-request`, `complete-request`. Staff-gated Settings endpoints: `GET /api/settings/counterpoint-sync/status`, `POST .../request-run`, `PATCH .../issues/:id/resolve`, staging queue + map CRUD under the same router. M2M: `GET /api/sync/counterpoint/health` exposes `counterpoint_staging_enabled`; `POST .../staging` accepts `{ entity, payload }` when staging is on (bridge **0.7.0+**). UI: Settings → Integrations → Counterpoint hub (`CounterpointSyncSettingsPanel.tsx`) — status, inbound queue, category/payment/gift maps, staff links. **Migration 95**: `counterpoint_staging_batch` + `store_settings.counterpoint_config.staging_enabled`. **Migration 96**: `reporting.effective_store_timezone()` + business-day **`daily_order_totals`**, enriched **`orders_core`** / **`order_lines`** (customer ZIP/city/state, names, loyalty points; staff names), **`reporting.loyalty_point_ledger`**, **`order_loyalty_accrual`**, **`loyalty_reward_issuances`** — **`docs/METABASE_REPORTING.md`**. **Migration 97**: **`staff_permission`** (effective Back Office keys per non-admin staff), per-staff **`max_discount_percent`**, employment dates, **`employee_customer_id`**; **`staff_role_permission`** remains the Settings template for new hires / **Apply role defaults** — **`docs/STAFF_PERMISSIONS.md`**. **Migration 85** widens `customers.customer_created_source` to accept `'counterpoint'` and adds `products.data_source` for provenance. **Migration 86** adds `counterpoint_staff_map` (CP `USR_ID`/`SLS_REP`/`BUYER_ID` → `staff.id`), `staff.data_source`/`counterpoint_user_id`/`counterpoint_sls_rep`, `customers.preferred_salesperson_id`, `orders.processed_by_staff_id`; M2M: `POST .../staff`. **87** = `products.tax_category`; **88** = `vendors.payment_terms`; **89** = `vendor_supplier_item` (`PO_VEND_ITEM`) + idempotent `loyalty_point_ledger` index for `PS_LOY_PTS_HIST`; M2M: `POST .../vendor-items`, `POST .../loyalty-hist`. End-to-end usage: [`docs/COUNTERPOINT_SYNC_GUIDE.md`](docs/COUNTERPOINT_SYNC_GUIDE.md).

**Customers**: `customers.customer_code` is **required** on every row (unique). New customers get a server-allocated code; Lightspeed CSV import upserts on `customer_code`. Do not add client-only or duplicate Lightspeed-specific code columns for matching.

## Client API base URL

`import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000"` — use the same pattern for new `fetch` calls. Prefer `fetch` for new endpoints. `axios` and `socket.io-client` already exist in `client/package.json` for legacy code; do not expand axios usage for new features without a deliberate reason.

**Staff-or-POS routes (e.g. `GET /api/sessions/current`):** under **`BackofficeAuthProvider`**, use **`mergedPosStaffHeaders(backofficeHeaders)`** (the root shell’s initial poll is **`RegisterSessionBootstrap`**, which does this). Use **`sessionPollAuthHeaders()`** only where context is unavailable (`client/src/lib/posRegisterAuth.ts`). Omitting both staff and POS credentials yields **401**; valid staff and no open till → **404** (“no active session”). **`RegisterSessionBootstrap`** calls **`applyShellForLoggedInRole`** (e.g. admin → Back Office **Operations**) only when the hydrated register **`session_id`** **changes**, not on every bootstrap re-run, so **QBO / Staff / Settings** navigation is not reset while the same till stays open.

## UX Alignment notes (current)

- **Surface mode**: each workspace tagged `POS-Core` (speed, density) or `BackOffice` (clarity, reviewability).
- **Unified Shell Integration**: Register and Weddings modules are embedded directly in the core Back Office shell (Sidebar + AppMainColumn). Do not re-introduce aggressive redirects to external shells on tab change.
- **POS navigation**: The Back Office sidebar item **POS** is the launchpad into **`PosShell`**; subsection **Register** opens the launchpad view (**Enter POS**). Inside POS mode, the left-rail tab **Register** is the **selling** surface (**`Cart.tsx`**). Do not label the whole shell “Register” in new copy.
- **Intelligent Search**: POS search in `Cart.tsx` MUST use the multi-threaded resolution strategy (Direct SKU match → **`/api/products/control-board?search=`** with enough **`limit`** for **parent-grouped** dropdown rows → **VariantSelectionModal** when the product has multiple SKUs). Server sorts text search by **45-day parent-product unit volume** (see **`docs/SEARCH_AND_PAGINATION.md`**). Never use simplified fuzzy-only or SKU-only lookups in the register. **Exception:** exact query **`PAYMENT`** (case-insensitive) injects the internal **RMS CHARGE PAYMENT** line via **`GET /api/pos/rms-payment-line-meta`** — see **`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`**. **`VariantSelectionModal.tsx`** must reset option state when **`product_id`** changes so a second matrix item does not reuse the prior selection. **Cart line title:** when the line’s product has multiple variants, open **`control-board?product_id=`** then the picker to **replace** the line’s variant (single-variant lines still open **ProductIntelligenceDrawer**). **`ProductIntelligenceDrawer`**: resolve adds via **`GET /api/inventory/scan/{sku}`** when the SKU is not in current **`searchResults`**.
- **Register draft cart (local)**: **`Cart.tsx`** persists the in-progress sale to **`localforage`** (**`ros_pos_active_sale`**, keyed with **`sessionId`**) **only when the cart has at least one line item**; empty carts do not persist a draft (refresh returns to **Cashier for this sale**). Writes run only after hydrate completes (see **`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`** vs **Park**). Cashiers verify **before ringing** (**Cashier for this sale**); do not add a second operator gate at payment in **`NexoCheckoutDrawer.tsx`**.
- **PWA/Remote** = Use `sm:`, `md:`, and `lg:` Tailwind breakpoints aggressively to ensure complex analytics and operations reflow gracefully for 5" and 6" iPhone/Android displays. Always provide a Sidebar toggle (`Menu` icon) in the `Header` when screen width < 1024px.
- **POS Design Invariants**:
  - **Emerald Green Action Pattern**: All terminal completion actions (Complete Sale, Add to Sale) MUST use `bg-emerald-600` with `border-b-8 border-emerald-800`.
  - **Zero-Scroll Discipline**: POS drawers must be designed for zero-scrolling on 1080p. Consolidate redundant price headers into compact pills and ensure the active footer is always pinned/visible.
  - **Price Intelligence**: Variant selection confirmation MUST include the integrated 12-key numpad with `%` discount and `$` price-override modifiers.
  - **Hardware Mocking**: Payment terminals MUST include a high-fidelity simulation overlay (animated connecting/authorization states) before finalizing tenders.
  - **Zero-Browser-Dialog Architecture**: All operational workspaces (CRM, Settings, QBO, Insights, Gift Cards) have been refactored to 100% non-blocking. This is an enforceable invariant.
- Sidebar profile line: **`cashierName`** and **`isRegisterOpen`** come from live **`App.tsx`** register-session state (never hardcoded). When there is no open register session, the primary label falls back to **`staffDisplayName`** (server **`full_name`** from **`GET /api/staff/effective-permissions`**, held in **`BackofficeAuthContext`**); only if both are empty does it show **“No Active Session”**. The status line shows **Till open** / **Till closed** (Back Office sidebar). The circular portrait uses **`staffAvatarUrl`** (**`staffAvatarKey`** from the same response, or register **`cashierAvatarKey`** when the till is open). **`PosSidebar`** uses the same rules (drawer active / closed).
- **Wedding Pipeline Restoration**: Always use `weddingPipelineLogic.ts` for member transition rules. Legacy iframe/external bridges are deprecated.
- **Customers (Back Office)**: Keep the browse **list scrollable** — the list card `section` must be `flex flex-col min-h-0 flex-1` with the table region `min-h-0 flex-1 overflow-auto` under `ui-page`. **Add customer** is a **`DetailDrawer`** slideout (not a centered full-screen modal). Use **`theme.colors.app`** in Tailwind (`accent`, `accent-2`, `accent-hover`) for `bg-app-accent` / confirm buttons; see `client/src/index.css` for paired `shadow-app-accent/*` utilities when used with `shadow-lg`.
- **Form controls (light/dark)**: Prefer **`ui-input`** (and CSS vars `--app-input-border`, `--app-input-bg`) for text fields and selects so contrast stays consistent app-wide. Tailwind: `border-app-input-border` where a one-off border is needed (`tailwind.config.js` extends `theme.colors.app`).
- **Appointments (sidebar)**: Treat as the **store** schedule; wedding-party linkage is **optional** in `scheduler/AppointmentModal.tsx` (see **`docs/APPOINTMENTS_AND_CALENDAR.md`**).
- **Sidebar**: Collapsed icon rail uses **`SidebarRailTooltip`** ([`client/src/components/ui/SidebarRailTooltip.tsx`](client/src/components/ui/SidebarRailTooltip.tsx)) in [`Sidebar.tsx`](client/src/components/layout/Sidebar.tsx) and [`PosSidebar.tsx`](client/src/components/pos/PosSidebar.tsx). **Back Office**: **double-click** a primary nav icon (or the **collapsed** profile avatar) **toggles** expand vs collapsed; clicking the main column (including **Header**) collapses an expanded sidebar (`AppMainColumn` root `onClick`); the mobile **Menu** button uses **`stopPropagation`** so it can open the drawer without the parent immediately collapsing. **POS**: clicking the workspace body (below the top bar) collapses an expanded POS sidebar ([`PosShell.tsx`](client/src/components/layout/PosShell.tsx)).

## QBO bridge notes (current)

- Keep QBO handlers thin; mapping/audit events are already in `server/src/api/qbo.rs`.
- Do not bypass access-log expectations for write actions (mapping save, approve, sync).
- For ledger signals:
  - gift card `sub_type` is mandatory when `payment_method=gift_card`
  - `applied_deposit_amount` is validated and used for deposit release journal logic.

## User-visible copy

## Joint Couple Account Pattern (migration **110**)

```
Linking     →  Two customers join via `couple_id`. Loyalty is merged to `couple_primary_id`.
Checkout    →  Redirect `orders.customer_id` to the Primary's ID for centralized revenue/debt/loyalty.
Hub Stats   →  Sum(Spend, Balance, Points, Parties) for both partners.
Timeline    →  Union of joint orders and payments; individual notes and measurements stay separate.
UI          →  Switch partners via the Relationship tab to access individual fitting context.
```

When adding customer-facing features, always check for `couple_id`. If present, financial activity must use `resolve_effective_customer_id()`, while "fitting" or "personal" data (measurements, phone, email) stays per-person.
