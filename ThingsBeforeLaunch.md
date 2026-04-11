# Things before launch

Running list of items to **check** or **enact** before a Riverside OS go-live (production cutover, new store launch, or major release). **Add new sections and bullets here** as decisions are made; link out to full specs where they live.

Use `- [ ]` for work not yet done and `- [x]` when complete (optional).

---

## Database and migrations

- [x] **PostgreSQL** running with a production-appropriate **`DATABASE_URL`** (Compose local dev: **`localhost:5433`** → container **5432** — do not aim the API at the wrong port/instance; **`DEVELOPER.md`**).
- [x] **All migrations applied** in numeric order through the latest **`migrations/NN_*.sql`** (repo tracks **00–131** as of 2026-04; includes Stripe integration migrations **`129_stripe_high_level_integration.sql`**, **`130_stripe_reporting_reconciliation.sql`**, **`131_stripe_vault_and_credits.sql`**, plus **`128_commission_spiff_program.sql`** and **`01b_utility_functions.sql`**). **Docker dev:** `./scripts/apply-migrations-docker.sh` from repo root (ledger in **`ros_schema_migrations`**). **Drift / QA:** `./scripts/migration-status-docker.sh` vs **`scripts/ros_migration_build_probes.sql`**. **Prod:** run the same ordered DDL + ledger procedure your ops use; do not skip files.
- [x] **Final Migration Consistency Check:** Confirm ledger is at **131** and no mismatches exist in critical schema probes (e.g. `is_internal` on `order_items`, Stripe vault/credit tables, and reporting reconciliation columns).
- [ ] **SQLx query metadata freshness:** run `cargo sqlx prepare` after any `query!`/`query_as!` macro changes and ensure `.sqlx` artifacts are committed for CI parity.
- [ ] **Staff RBAC schema (migration 97):** Confirm **`staff_permission`**, **`staff.max_discount_percent`**, employment / **`employee_customer_id`** columns exist or the server will fail startup / staff routes — **`docs/STAFF_PERMISSIONS.md`**.
- [ ] **Backup drill** on a **non-production** copy: **`BACKUP_RESTORE_GUIDE.md`** (restore confidence before you need it).

---

## Server environment and security

- [ ] **Secrets** set on the server only (DB, Stripe if used, QBO if used, integration tokens). Nothing sensitive in client env except allowed **`VITE_*`** (see **`DEVELOPER.md`** env table).
- [ ] **`RIVERSIDE_CORS_ORIGINS`** set to real browser origins when staff use HTTPS hostnames or multiple entry URLs (avoid accidental wide-open CORS in production).
- [ ] **`RIVERSIDE_HTTP_BIND`** aligned with your TLS/reverse-proxy plan (**`docs/STORE_DEPLOYMENT_GUIDE.md`**, **`REMOTE_ACCESS_GUIDE.md`**).
- [ ] **Staff auth:** No dev bypasses; PINs and RBAC match store policy (**`docs/STAFF_PERMISSIONS.md`**).
- [ ] **Stripe PCI safeguards enforced:** ROS never stores raw PAN/CVC; Stripe Elements + SetupIntents only; only non-sensitive metadata persisted (brand/last4/expiry/intents).

---

## Store settings (in-app)

- [ ] **Receipt settings:** Store name, **IANA timezone** (drives receipts, register “store day,” and **`reporting`** business dates — Settings → Receipt).
- [ ] **Staff roster:** Roles and permissions; **change default/bootstrap credentials** if the DB still uses dev seeds (**`docs/STAFF_PERMISSIONS.md`**, migration **53** on greenfield). After migration **97**, effective Back Office keys live in **`staff_permission`**; role-wide templates are under **Settings → Staff access defaults**.
- [ ] **Commission Roster (v0.1.8):** Audit Sales Rep base rates in the **Staff -> Commission** ledger and initialize overrides for high-priority products/variants — **`docs/COMMISSION_AND_SPIFF_OPERATIONS.md`**.

---

## Clients (Tauri + PWA)

- [ ] **`VITE_API_BASE`** correct **per build** (LAN hostname, Tailscale name, or HTTPS origin) — **`client/.env.register`**, **`client/.env.pwa`**, not `127.0.0.1` unless the API is truly local to that device.
- [ ] **Production artifacts:** Server serves **`client/dist`**; Register/Back Office PCs run **Tauri** build; iPad/phones use **PWA** build — **`docs/STORE_DEPLOYMENT_GUIDE.md`**, **`docs/PWA_AND_REGISTER_DEPLOYMENT_TASKS.md`**.
- [ ] **Register 1 (Tauri):** Thermal printer path validated (**TCP** target as deployed).
- [ ] **Shared devices:** Train staff: log out / close register when unattended on PWA (**`docs/PWA_AND_REGISTER_DEPLOYMENT_TASKS.md`**).

---

## Network, TLS, and remote access

- [x] **HTTPS** (or store-approved private mesh) for staff-facing browser/Tailscale access; **no plain HTTP on the public internet** for the app — **`REMOTE_ACCESS_GUIDE.md`**, **`docs/REMOTE_ACCESS_USER_GUIDE.md`**.
- [ ] **Tailscale / firewall** rules match who should reach the ROS origin and Metabase (if separate).

---

## Register operations (training)

- [ ] **Multi-lane / till group:** If using Register #2+, staff understand **one drawer on #1** and combined **Z-close** — **`docs/TILL_GROUP_AND_REGISTER_OPEN.md`**.
- [ ] **Parked sales / RMS charge lines** (if you use them): cashiers and Sales Support trained — **`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`**.

---

## Metabase / Insights (reporting)

**Policy (OSS baseline):** Prefer Metabase **Open Source** — **`RIVERSIDE_METABASE_JWT_SECRET`** unset and Metabase **Authentication → JWT** off unless you deliberately adopt **paid** Metabase for SSO. **Riverside `insights.view`** only opens the **Insights** shell; **margin and private data in Metabase** are controlled by **which Metabase user** logs in, not by staff PIN.

**Pair with Riverside:** **`DEVELOPER.md`** — **Back Office → Reports** (curated **`/api/insights/*`** tiles; **Margin pivot** = **Riverside Admin role** API-enforced). **Insights** = Metabase iframe — enforce sensitivity with Metabase accounts below.

- [ ] **Postgres:** **`reporting`** views require **`90`**, **`96`**, **`106`**, and **`107`** (margin / cost columns on **`reporting.order_lines`** for Metabase admin content); the live app needs **all** migrations through latest (**`DEVELOPER.md`**). Role **`metabase_ro`** exists with a **strong password** (`ALTER ROLE ... PASSWORD`).
- [ ] **Metabase connection:** DB **`riverside_os`**, user **`metabase_ro`**, schema **`reporting`** only; sync schema after deploy.
- [ ] **Booked vs completed (revenue / tax / commission alignment):** Use **`reporting.orders_core` / `reporting.order_lines`**: **`order_business_date`** = sale booked day; **`order_recognition_at`** / **`order_recognition_business_date`** = completed-revenue day (**pickup / in-store takeaway:** `fulfilled_at`; **ship:** first `label_purchased` or manual **in_transit** / **delivered** note on **`shipment_event`** — same rules as **`/api/insights`** NYS audit + commission finalize). For day totals: **`daily_order_totals`** = booked; **`daily_order_totals_recognized`** = completed. Replicate or filter in Metabase questions accordingly.
- [ ] **Online store backlog:** Full “picked up vs shipped” product workflow (customer-visible states, optional dedicated **`shipped_at`**, carrier webhooks) is **not** fully built; recognition for ship rows depends on shipment hub events today — extend when **`/shop`** fulfillment is hardened (**`docs/ONLINE_STORE.md`**, **`docs/SHIPPING_AND_SHIPMENTS_HUB.md`**).
- [ ] **Metabase logins — Staff vs Admin (required for margin / private cuts):**
  - [ ] Create at least **two Metabase groups** (e.g. **Reporting – Staff** and **Reporting – Admin**, or use Metabase **Administrators** for the second).
  - [ ] **Staff-class Metabase users** (per person or a small shared login per store policy): **View** only on a **Staff / Approved** (or similarly named) collection — dashboards and questions **without** margin / cost / exploratory drafts. **No access** (or minimal) to folders that hold questions on **`line_gross_margin_pre_tax`**, **`unit_cost`**, or other sensitive **`reporting.order_lines`** columns from **107**.
  - [ ] **Admin-class Metabase users** (owners, finance, IT): access to **margin** dashboards, draft collections, and ad-hoc exploration as policy allows. **Do not** reuse the admin Metabase password as the “everyone” login for all staff who have **`insights.view`** in Riverside.
  - [ ] **Collections:** Keep **Staff / Approved** curated; put margin-heavy and experimental content in **admin-only** collections with **No access** for **Reporting – Staff**.
  - [ ] **Train:** On shared PCs, **log out** of Metabase when switching between staff and admin Metabase identities (or use separate browser profiles).
  - [ ] **Document:** **Settings → Integrations → Insights** — optional Markdown **Staff note** + **Collections / groups** ops note so trainers know who gets which Metabase login (**`InsightsIntegrationSettings.tsx`** / **`GET/PATCH /api/settings/insights`**).
- [ ] **SQL / data:** Restrict **native query** for **Reporting – Staff** if they must not ad-hoc query all **`reporting.*`** objects (OSS has no row-level sandboxes from paid tiers).
- [ ] **Network:** Metabase not on a public URL; align with **LAN / Tailscale / VPN** (`REMOTE_ACCESS_GUIDE.md`, store ops).
- [ ] **OSS JWT:** Leave **`RIVERSIDE_METABASE_JWT_SECRET`** unset unless you intentionally enable JWT handoff + paid Metabase JWT (**`docs/METABASE_REPORTING.md`**).

**Full detail:** [`docs/METABASE_REPORTING.md`](docs/METABASE_REPORTING.md) — **Operational standard: Staff Metabase login vs Admin Metabase login**, Phase 2 views, and optional JWT. Staff guides: [`docs/staff/insights-back-office.md`](docs/staff/insights-back-office.md), [`docs/staff/reports-curated-admin.md`](docs/staff/reports-curated-admin.md).

---

## Integrations (only if you use them)

- [ ] **QuickBooks Online:** OAuth, mappings, staging rules — ops runbook in **`DEVELOPER.md`** / QBO docs as you use them.
- [ ] **Stripe:** **`STRIPE_SECRET_KEY`** and live vs test; terminal behavior — see server env docs.
- [ ] **Stripe cutover controls:** Verify reader locations, connection tokens, webhook secret, and refund/credit reconciliation paths before opening day.
- [ ] **Podium SMS / storefront embed / CRM threads:** **`RIVERSIDE_PODIUM_*`**, webhook secret — **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`**, completion matrix **`docs/PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md`**.
- [ ] **Shippo / shipments:** **`SHIPPO_API_TOKEN`**, rates and hub — **`docs/SHIPPING_AND_SHIPMENTS_HUB.md`**.
- [ ] **Meilisearch (optional):** **`RIVERSIDE_MEILISEARCH_*`**; **rebuild index** after major catalog deploy — **`docs/SEARCH_AND_PAGINATION.md`**.
- [ ] **OpenTelemetry (optional):** When using a trace collector or APM, configure **`OTEL_*`** / **`RIVERSIDE_OTEL_ENABLED`** on the API host and confirm egress to the collector — **`docs/OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md`**, **`docs/STORE_DEPLOYMENT_GUIDE.md`** §4.
- [ ] **Counterpoint bridge:** **`COUNTERPOINT_SYNC_TOKEN`**, bridge install, staging if enabled — **`docs/COUNTERPOINT_SYNC_GUIDE.md`**.
- [ ] **Online store (`/shop`):** JWT secret, coupons, Studio license if used — **`docs/ONLINE_STORE.md`**.
- [ ] **In-app bug reports (optional ops):** Floor staff know **Report a bug** (**`docs/staff/bug-reports-submit-manual.md`**). At least one **`settings.admin`** knows **Settings → Bug reports** triage (**`docs/staff/bug-reports-admin-manual.md`**, **`docs/staff/settings-back-office.md`**, **`docs/PLAN_BUG_REPORTS.md`**). Submissions include optional screenshot + client diagnostics + **server log snapshot** (recent API **`tracing`** only, not full host logs); **`correlation_id`** on submit; retention env **`RIVERSIDE_BUG_REPORT_RETENTION_DAYS`** (migrations **101**–**103**).

---

## LLM / staff “AI” (implementation status)

**At launch, treat this as a status check—not a feature flip** unless product has explicitly shipped a new LLM layer. **ROSIE** (**RiversideOS Intelligence Engine**) is the planned in-app assistant name; it is **not** implied by shipping Help Center alone.

- [ ] **Retired in-app AI stack:** Database has applied migration **78** (no **`ai_doc_chunk`**, **`/api/ai`**, or **`ai_assist`** keys). Do **not** expect embeddings/RAG tables or a ros-gemma worker from older docs — current pointer: **`ROS_AI_INTEGRATION_PLAN.md`**.
- [ ] **What staff use today:** **Help Center** + Markdown manuals + **`GET /api/help/search`** (optional **Meilisearch** on **`ros_help`**) — **`PLAN_HELP_CENTER.md`**, **`docs/MANUAL_CREATION.md`**. After deploy, run **`generate:help`** / reindex per your process if catalog changed.
- [ ] **ROSIE / local LLM sidecar (future, optional):** If you are **not** shipping **Ask ROSIE** or a sidecar on cutover, note **N/A** and skip tooling. If you **are** piloting: follow **`docs/PLAN_LOCAL_LLM_HELP.md`** (Windows **11** + Tauri/server expectations, Help Center integration, Axum as trust boundary, **whitelisted** read tools only—**no** model-built SQL; align with **`docs/AI_REPORTING_DATA_CATALOG.md`**). Confirm store policy for screenshots/vision and localhost ports (AV/firewall).

---

## Inventory and velocity reporting

- [x] **`GET /api/insights/best-sellers`** and **`GET /api/insights/dead-stock`** — implemented with **`basis`** (`booked` vs `completed` / recognition) aligned with sales pivots (**`server/src/logic/report_basis.rs`**, migration **106**).
- [ ] **Metabase / ops:** Use stock-on-hand and receiving views as designed; pair “sold” metrics with **`reporting.order_lines.order_recognition_business_date`** for completed-units reporting where appropriate.

---

## Weather / misc

- [ ] **Visual Crossing (optional):** API key / enabled flag if you rely on weather in app — **`docs/WEATHER_VISUAL_CROSSING.md`**.
- [ ] **Morning digest (optional):** **`RIVERSIDE_MORNING_DIGEST_HOUR_LOCAL`** if non-default — **`docs/PLAN_NOTIFICATION_CENTER.md`**.

---

<!-- Add new launch areas above this line or as new ## sections. -->

---

## Special & Custom Orders

- [x] **Custom Work Order Flow (MTM Light):**
  - [x] **SKU Trigger:** POS detects SKU starting with `CUSTOM`.
  - [x] **Selector:** Popup to pick item type (SUITS, SPORT COAT, SLACKS, INDIVIDUALIZED SHIRTS).
  - [x] **Variable Pricing:** Cashier enters `SALE` price at the time of order.
  - [x] **Deposit:** Flow must handle taking a deposit (partial payment) for these custom lines.
  - [x] **Persistence:** Backend logic updated to persist `custom_item_type`, `is_rush`, and `need_by_date` in checkout items.
  - [ ] **Cost Linkage:** Upon receiving the physical item, connect vendor `COST` to the specific order line for margin tracking.
- [x] **Rush Order & Urgency:**
  - [x] **Urgent Flag:** Ability to mark an order as "RUSH".
  - [x] **Deadline:** Mandatory `NEED BY DATE` for rush items.
  - [x] **Visibility:** Dashboard indicator for items due within 48-72 hours.

---

## Inventory & Data Integrity

- [x] **Counterpoint Bridge Sync:**
  - [x] **Concurrency Guard:** Implemented `isTickRunning` lock to prevent overlapping sync cycles.
  - [x] **Targeted Sync:** Added support for manual requests to sync specific entities (e.g., just `customers` or `vendors`).
  - [x] **Ack/Complete Handshake:** Added `ack-request` and `complete-request` callbacks for improved orchestration.
- [ ] **Opening Balance Audit:** Confirm migrated customer deposits and store credits match Counterpoint exactly.
- [ ] **Tax Rate Verification:** Final audit of NYS/NYC clothing tax rules vs Riverside logic.
- [ ] **Hardware Stress Test:** Validate thermal printing from multiple registers simultaneously.
- [ ] **Offline Drill:** Staff training on manual overrides and credit card procedures if internet/Tailscale is down.
- [ ] **Final DB Scrub:** Purge all "Test" records (customers, tickets) before the first day of real operations.
---

## Pre-Launch Polish & Possible Features

- [ ] **Gift & Packaging options:**
  - [x] **Gift Receipt:** Toggle in checkout to print price-less receipt (Implemented in ReceiptSummaryModal).
  - [ ] **Gift Wrap:** Add "Needs Gift Wrap" flag to order lines for fulfillment team.
- [ ] **Customer Measurements Alert:**
  - [ ] Trigger warning in CRM/MTM if `last_measured_at` is older than 12 months.
- [ ] **Wedding Health Heatmap:**
  - [ ] Visual color-coding in Wedding Manager (Red/Yellow/Green) based on payment status and measurement completion.
- [ ] **Staff Commission Verification:**
  - [ ] Audit Sales Rep commission percentages before the first official sale.
  - [x] **Combo Reward Integrity:** Confirm multi-item bundles require single-salesperson attribution to trigger bonuses.
  - [x] **Specificity Hierarchy:** Verify `Variant -> Product -> Category` override precedence.
- [ ] **Inventory Labeling:**
  - [ ] Validate 2x1 inventory barcode printing for all SUIT/COAT units.
- [ ] **Receipt Privacy Audit (v0.1.8):**
  - [x] **Name Masking:** Confirm salesperson appears as "First Name + Last Initial" on customer copies.
  - [x] **Internal suppression:** Confirm `is_internal = true` lines (Commission Rewards) are hidden from ZPL, Studio HTML, and SMS/Email.

---

## Remote Access & Host Security (v0.1.8)

- [x] **Native Tailscale Integration:** ROS directly manages connection/disconnection on the host machine (**`server/src/logic/remote_access.rs`**).
- [x] **Remote Safety Guards:** UI detects remote sessions and prevents accidental lockouts via confirmation dialogs (**`RemoteAccessPanel.tsx`**).
- [x] **User Guidance:** Built-in "Setup Manual" in Settings and indexable help documentation (**`docs/REMOTE_ACCESS_USER_GUIDE.md`**).
- [x] **Security Hardening Doc:** Formal security architectural review completed (**`docs/SECURITY_ARCHITECTURE.md`**).
- [ ] **Remote-Sync Verification:** Verify Counterpoint Bridge sync performance over the Tailscale tunnel from an off-site laptop.
- [ ] **Auth Key Lifecycle:** Set clear expiration/rotation policy for Tailscale Join Keys in shop SOP.

---

## Release Validation Gate (E2E + Visual Consistency)

- [ ] **Start app stack before browser E2E:** run `npm run dev` at repo root (UI + API reachable) before Playwright runs.
- [ ] **List suite inventory:** `npm run test:e2e:list` (root) or `cd client && npm run test:e2e:list`.
- [ ] **Required release E2E gate:** `npm run test:e2e:release` (root).
- [ ] **Required high-risk finance/help gate (checkout/reporting/help-admin changes):** `npm run test:e2e:high-risk`.
- [ ] **Required Phase 2 lifecycle gate (help policy persistence/revert + finance contracts):** `npm run test:e2e:phase2`.
- [ ] **Required tender contract gate (checkout/payment behavior):** `npm run test:e2e:tender`.
- [ ] **Visual suite policy:** run `npm run test:e2e:visual` only when intentionally validating/updating snapshots.
- [ ] **Canonical visual source of truth:** approve screenshot updates only from a pinned canonical environment (same OS/browser/fonts/viewport assumptions).
- [ ] **Visual deterministic defaults confirmed:** Playwright visual mode uses disabled animations + UTC timezone + en-US locale.
- [ ] **If E2E fails with `ERR_CONNECTION_REFUSED`:** treat as environment boot issue first (UI host not running), not product regression.
- [ ] **Cross-reference release runbook:** validate against `docs/RELEASE_QA_CHECKLIST.md` before final sign-off.
- [ ] **Pre-commit validation gate:** run `cargo fmt --check`, `npm run lint`, and `npm --prefix client run build`; block launch candidate if any fail.
- [ ] **Go-live cutover safeguard:** perform a timed “open register → complete sample sale → close register” dress rehearsal on production-like hardware/network before first customer.
- [ ] **Rollback readiness:** define owner + exact rollback command path (DB restore point + previous app artifact) and confirm contact chain for launch hour.

---

## Launch Day Run Sheet (Chronological Cutover + Rollback Triggers)

### T-120 to T-90 (Infrastructure lock)
- [ ] Announce **change freeze** (no ad-hoc schema/code edits during cutover).
- [ ] Confirm owner roles are assigned and reachable:
  - [ ] Launch commander
  - [ ] DB owner
  - [ ] App owner
  - [ ] Register floor lead
- [ ] Confirm production host health (CPU, disk, memory headroom) and Docker/DB service status.
- [ ] Confirm latest approved app artifact/version is staged.

### T-90 to T-60 (Database finalization)
- [ ] Run migration apply script against production DB (`./scripts/apply-migrations-docker.sh` or production equivalent).
- [ ] Run migration status script (`./scripts/migration-status-docker.sh`) and archive output.
- [ ] Verify ledger includes latest migrations (through **131** at current baseline).
- [ ] Confirm any known probe mismatches are understood/accepted per runbook policy (e.g., retired AI tables).

### T-60 to T-45 (Secrets + network readiness)
- [ ] Verify runtime env on API host:
  - [ ] `DATABASE_URL`
  - [ ] `RIVERSIDE_CORS_ORIGINS`
  - [ ] `RIVERSIDE_HTTP_BIND`
  - [ ] Integration secrets used by this store (Stripe/Podium/Shippo/QBO/Meilisearch)
- [ ] Verify TLS/reverse proxy route and LAN/Tailscale access from at least 2 staff devices.
- [ ] Verify firewall and remote-access policy for Metabase and Back Office endpoints.

### T-45 to T-30 (Build + quality gate)
- [ ] Run and capture:
  - [ ] `cargo fmt --check`
  - [ ] `npm run lint`
  - [ ] `npm --prefix client run build`
- [ ] Abort launch if any hard gate fails and move to rollback/hold decision.

### T-30 to T-20 (E2E release gate)
- [ ] Start stack (`npm run dev`) in launch environment.
- [ ] Run:
  - [ ] `npm run test:e2e:release`
  - [ ] `npm run test:e2e:high-risk`
  - [ ] `npm run test:e2e:phase2`
  - [ ] `npm run test:e2e:tender`
- [ ] Optional visual run (`npm run test:e2e:visual`) only if visual signoff is in scope.
- [ ] Capture and store E2E output for launch record.

### T-20 to T-10 (Store operations checks)
- [ ] Open Register #1 with real cashier code/PIN.
- [ ] Verify POS cashier sign-in, product search, and checkout drawer.
- [ ] Process one supervised sample sale end-to-end:
  - [ ] Cart build
  - [ ] Tender apply
  - [ ] Complete sale
  - [ ] Receipt output
- [ ] Verify reports/insights shell opens with expected permissions.
- [ ] Verify Help Center access from Back Office and POS.

### T-10 to T-0 (Go/No-Go)
- [ ] Confirm all checklist gates are green or explicitly waived by launch commander.
- [ ] Confirm rollback owner is on standby with restore instructions open.
- [ ] Launch commander announces **GO LIVE** timestamp.

### T+0 to T+30 (Hypercare)
- [ ] Monitor API logs and critical alerts (auth failures, checkout errors, payment intent failures).
- [ ] Monitor DB health and connection pool behavior.
- [ ] Confirm first real transaction completes and is visible in reporting.
- [ ] Confirm no abnormal tender/refund behavior.

### T+30 to T+120 (Stabilization)
- [ ] Spot-check:
  - [ ] POS flow
  - [ ] Back Office workspace navigation
  - [ ] Register close/reconcile flow
  - [ ] Integration health indicators
- [ ] Log all incidents with timestamp, symptom, owner, mitigation.

### Hard Rollback Triggers (Immediate No-Go / Revert)
- [ ] Migration script fails and cannot be safely corrected within launch window.
- [ ] Any required validation gate fails (fmt/lint/build/E2E release suites).
- [ ] Checkout cannot complete a supervised sample sale.
- [ ] Payment intent/tender path failure blocks transactions.
- [ ] Critical auth/RBAC failure grants or denies core access incorrectly.
- [ ] Production API unavailable or persistent 5xx on core flows.

### Rollback Execution Checklist
- [ ] Launch commander calls rollback and records timestamp/reason.
- [ ] Disable/storefront access path as needed (maintenance mode or routing block).
- [ ] Restore DB to pre-launch restore point (or execute approved rollback migration plan).
- [ ] Re-deploy previous known-good app artifact.
- [ ] Re-run minimal smoke:
  - [ ] staff sign-in
  - [ ] POS cart + checkout
  - [ ] reports access
- [ ] Announce status to store team and update incident log.

---

<!-- Add new launch areas above this line or as new ## sections. -->
