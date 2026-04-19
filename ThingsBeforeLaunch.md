# Things before launch

Running list of items to **check** or **enact** before a Riverside OS go-live (production cutover, new store launch, or major release). **Add new sections and bullets here** as decisions are made; link out to full specs where they live.

Use `- [ ]` for work not yet done and `- [x]` when complete (optional).

---

## Database and migrations

- [x] **PostgreSQL** running with a production-appropriate **`DATABASE_URL`** (Compose local dev: **`localhost:5433`** → container **5432** — do not aim the API at the wrong port/instance; **`DEVELOPER.md`**).
- [x] **Final Migration Consistency check (v0.2.1):** Run `./scripts/migration-status-docker.sh` and ensure migrations through **150** are applied and all probe statuses are **ok** (including the **Schema Repair Baseline**, **Transaction Refactor**, **ROS Dev Center**, and reporting parity probes). Confirm ledger matches repo head.
- [x] **Authentication Endpoint Verification:** Verify that the POS `Cart.tsx` uses the modern `/api/staff/verify-cashier-code` endpoint and the legacy `/api/auth/verify-pin` correctly handles manager overrides (v0.2.0 Stabilization).
- [ ] **Backup drill** on a **non-production** copy: **`BACKUP_RESTORE_GUIDE.md`** (restore confidence before you need it).
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
- [ ] **Staff Identity & UI Logic (v0.2.0):**
  - [ ] **Top Bar Resolution:** Confirm `GlobalTopBar` prioritizes the authenticated Back Office staff member (`staffDisplayName` / `staffAvatarKey`) and only falls back to register session identity when no authenticated persona is present.
  - [ ] **POS Context:** Confirm register session identity (`cashierName` / `cashierAvatarKey`) remains visible only as secondary operational context in POS surfaces that intentionally show lane ownership, without replacing the authenticated staff persona in the Top Bar.
  - [ ] **Redundancy Audit:** Confirm `PosSidebar` and other child shells NO LONGER contain staff profile cards (centralized in Top Bar).

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

## Station & hardware commissioning (must-pass before first customer)

### Server host (Windows PC running API + Postgres)

- [ ] Hostname and static/DHCP-reserved LAN IP documented.
- [ ] Power plan set to prevent sleep/hibernate during store hours.
- [ ] Auto-start/service strategy validated for API and DB after reboot.
- [ ] Windows Firewall rules verified for required ports only (least privilege).
- [ ] NTP/time sync verified (clock drift can break TLS and reports).
- [ ] UPS present and graceful shutdown plan documented.
- [ ] Backup target reachable and write permissions verified.

### Register 1 (Tauri, primary drawer lane)

- [ ] Tauri app installed, launch tested, and version confirmed in **About this build**.
- [ ] `VITE_API_BASE` in built app points to production API origin.
- [ ] Register open/close flow validated on lane 1 with real cashier credentials.
- [ ] Cash drawer/till workflow validated (open float, paid in/out, reconcile).
- [ ] Receipt print workflow validated end-to-end from completed sale.
- [ ] Reprint workflow validated from order/report context.

### Register 2+ stations (Tauri or PWA satellite lanes)

- [ ] Lane assignment and operator SOP documented (satellite lanes tie to lane 1 till group).
- [ ] Register open behavior validated for lane >1 expectations.
- [ ] Satellite checkout flow validated with physical handoff to drawer lane policy.
- [ ] Shared-device logout/lock SOP posted at station.

### PWA devices (iPad/phones)

- [ ] Add-to-Home-Screen install completed on each intended device.
- [ ] Initial login and role-specific workspace access validated.
- [ ] Offline/poor-network behavior drill completed (what works vs what must wait).
- [ ] Cache reset/hard-refresh procedure documented for floor staff.
- [ ] MDM/screen-lock/auto-lock policy set for shared devices.

### Receipt printers

- [ ] Each printer model, IP, port, and physical station label documented.
- [ ] Static IP or DHCP reservation confirmed.
- [ ] Test print completed from target station and from production app flow.
- [ ] Paper width/stock loaded and spare roll policy documented.
- [ ] Fallback printer procedure documented if primary printer fails.

### Report/label printers

- [ ] Driver installed and set as expected printer on back-office station.
- [ ] Correct page/label size validated (no scaling/clipping).
- [ ] Test label/report print saved as acceptance artifact.
- [ ] Spare labels/ink/maintenance kit availability checked.

### Scanners (barcode hardware)

- [ ] Device mode set to HID keyboard wedge (or approved equivalent).
- [ ] Suffix/prefix behavior standardized (e.g., Enter/Tab) per station SOP.
- [ ] Scan tests pass in POS search, inventory flows, and any scanner-driven dialogs.
- [ ] Bluetooth scanners paired and reconnect procedure documented.
- [ ] Charging/storage plan documented for cordless scanners.

### Card/terminal hardware (credit card equipment)

- [ ] Reader registration/location mapping verified per lane/station.
- [ ] Connection token/terminal handshake works from live app context.
- [ ] Payment flow test completed for at least one successful card transaction path.
- [ ] Failure handling drill completed (reader offline, retry, fallback tender SOP).
- [ ] End-of-day reconciliation includes card activity verification path.

---

## Metabase / Insights (reporting)

**Policy (OSS baseline):** Prefer Metabase **Open Source** — **`RIVERSIDE_METABASE_JWT_SECRET`** unset and Metabase **Authentication → JWT** off unless you deliberately adopt **paid** Metabase for SSO. **Riverside `insights.view`** only opens the **Insights** shell; **margin and private data in Metabase** are controlled by **which Metabase user** logs in, not by staff PIN.

**Pair with Riverside:** **`DEVELOPER.md`** — **Back Office → Reports** (curated **`/api/insights/*`** tiles; **Margin pivot** = **Riverside Admin role** API-enforced). **Insights** = Metabase iframe — enforce sensitivity with Metabase accounts below.

- [ ] **Postgres:** **`reporting`** views require **`90`**, **`96`**, **`106`**, **`107`**, **`143`**, and **`150`** for the current release baseline. Migration **143** provides `transactions_core` and `fulfillment_orders_core`; migration **150** restores `reporting.order_lines.line_gross_margin_pre_tax` and probe parity. Role **`metabase_ro`** exists with a **strong password** (`ALTER ROLE ... PASSWORD`).
- [ ] **Metabase connection:** DB **`riverside_os`**, user **`metabase_ro`**, schema **`reporting`** only; sync schema after deploy.
- [ ] **Booked vs completed (revenue / tax / commission alignment):** Use **`reporting.transactions_core` / `reporting.order_lines`** (now pointing to `transaction_lines` via shim): **`booked_business_date`** = sale booked day; **`recognition_at`** / **`recognition_business_date`** = completed-revenue day.
- [ ] **Fulfillment Log:** Use **`reporting.fulfillment_orders_core`** to track logistical status of Special/Custom/Wedding orders in Metabase.
- [ ] **Legacy Compatibility:** Verify that `reporting.orders_core` and `reporting.order_lines` (shims) still function for existing v0.1.x dashboards.
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
  - [x] **Persistence:** Backend logic updated to persist `custom_item_type`, `is_rush`, and `need_by_date` in `transaction_lines`.
  - [x] **Cost Capture (v0.2.0):** Mandatory Vendor Cost entry at point-of-sale for Custom SKU items implemented.
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
- [ ] **Transactions vs Orders terminology follow-up:** The obvious doc/path sweep is complete, but do one more pass on user-facing labels and deep-link copy for ambiguous “Order” usage. Preserve intentional compatibility names that are still live in the codebase and migrations, including **`orders.*`** permission keys, historical migration/table names such as **`order_items`**, and reporting shims like **`reporting.order_lines`** / **`reporting.orders_core`** while the financial API/routes remain **`/api/transactions/*`**.
- [ ] **Opening Balance Audit:** Confirm migrated customer deposits and store credits match Counterpoint exactly.
- [ ] **Tax Rate Verification:** Final audit of NYS/NYC clothing tax rules vs Riverside logic.
- [ ] **Hardware Stress Test:** Validate thermal printing from multiple registers simultaneously.
- [ ] **Offline Drill:** Staff training on manual overrides and credit card procedures if internet/Tailscale is down.
- [ ] **Final DB Scrub:** Purge all "Test" records (customers, tickets) before the first day of real operations.

---

## Financial Integrity & "Source of Truth" Baseline

**Paramount Requirement:** Financial data must be 100% exact. Every dollar and unit must be traceable to a specific transaction, staff member, and timestamp.

### 1. The "Truth Trace" Invariant
- [ ] **Audit Trail Integrity:** Confirm that all commission payouts, inventory adjustments, and price overrides carry a human-readable `reason` or `trace` log (**`AGENTS.md`**).
- [ ] **Immutability:** Verify that completed `orders` cannot be edited; errors must be corrected via `returns` or `exchanges` with cross-linked IDs.
- [ ] **Checkout Idempotency:** Test "Double-Click" on Place Order; confirm `transactions.checkout_client_id` prevents duplicate charges/decrementing.

### 2. Tax & Compliance
- [ ] **NYC/NYS Clothing Threshold:** Verify $110 rule (tax-free under $110 for specific categories) with mixed carts (Taxable vs Non-Taxable items).
- [ ] **Shipping Taxability:** Confirm shipping tax rules match the destination state/county policy.
- [ ] **Refund Logic:** Ensure tax is correctly calculated and returned on partial returns.

### 3. Inventory Valuation & Costing
- [ ] **Cost Capture at Checkout:** Confirm `transaction_lines.unit_cost` is non-null and frozen at the moment of sale to prevent historical cost drift from affecting margin reports.
- [ ] **Inventory Reconciliation:** Perform a blind-count of 20 high-velocity SKUs and verify they match the system `stock_on_hand` exactly.
- [ ] **Receiving Bay Hardening:** Verify that posting inventory from the Receiving Bay is a single, atomic operation that cannot be partially interrupted.

### 4. Liability Management (Deposits & Gift Cards)
- [ ] **Double-Spending Prevention:** Run concurrent checkout tests for the same Gift Card on two registers; confirm transaction isolation.
- [ ] **Deposit Forfeiture Audit:** Verify QBO mappings for `income_forfeited_deposit` hit the correct ledger.

---

## Decision Support & Intelligence
- [ ] **Wedding Health Audit:** Manually verify 5 "Critical" health scores against the 40/40/20 formula to ensure no false-negatives (Risk mitigation).
- [ ] **Inventory Brain v2 Stress Test:** Verify that "Restock" recommendations align with actual sale-velocity vs lead-time constraints.
- [ ] **Commission Truth Trace walkthrough:** Hand-verify 3 complex commission traces (Variant + Category override combos) with the Store Manager.
- [ ] **Margin Pivot Baseline:** Confirm that `reporting.order_lines` `gross_margin` accurately subtracts `unit_cost` and discounts pre-tax.
- [ ] **Wedding Liability:** Confirm that party deposits are correctly aggregated at the wedding project level for the EOD snapshot.

### 5. Commission & SPIFF Accuracy
- [ ] **Attribution Integrity:** Confirm that order-level salesperson attribution correctly flows to all line items unless explicitly overridden.
- [ ] **Split-Commission Drill:** Test a 50/50 split order and verify both staff members' ledgers reflect the exact 0.5 ratio of the net margin.
- [ ] **Payout Verification:** Compare a 1-week test period of POS activity against the **Commission Payout Report**; confirm 0.00 discrepancy.

### 6. QuickBooks Online (QBO) Reconciliation
- [ ] **Account Mapping Audit:** Verify all 20+ GL mappings (Sales, Tax, COGS, Assets, Liabilities) are initialized in the production environment.
- [ ] **Staging Verification:** Confirm all QBO "Draft" entries require manager approval before final ledger impact.
- [ ] **Z-Close Balance:** Confirm the POS Z-Report totals match the QBO Journal Entry daily summary to the penny.
- [ ] **Fulfillment Urgency Audit:** Manually verify that "Rush" and "Due Soon" tags in the Fulfillment Command Center correctly trigger based on `is_rush` flags and `wedding_parties.event_date` to prevent missed deadlines.
- [ ] **Merchant Activity Mapping:** Confirm that the insights dashboard correctly maps `created_at` from `payment_transactions` for Stripe reconciliation drills.
- [ ] **Discount Event Visibility:** Verify that active promotions populate the POS Cart and apply correctly to subtotals, ensuring no manual price overrides are required for standard sales.
- [ ] **Zero-Dash-Error Baseline:** Confirm that the Insights, Register Activity, and Fulfillment Queue dashboards return 200 OK without console errors on every load.
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

## Stability & Performance Baseline (v0.2.1 Hardening)

**Goal:** Zero-vibration UI. The shell must remain responsive and loop-free even during network instability or rapid navigation.

- [x] **Auth Context Stabilization:** `BackofficeAuthContext` uses strict value-equality for permissions to prevent phantom re-renders of the entire app tree.
- [x] **Global API "Single Source of Truth":** All components utilize `getBaseUrl()` from `apiConfig.ts` to ensure consistent server targeting across all registers.
- [x] **Fetch Circuit Breakers:** Background data tasks (Compass stats, Weather, Notifications) must implement loading/error guards that prevent infinite retry-storms on failure.
- [x] **Unidirectional Navigation:** Register/POS navigation state must flow from parent to child only. Child shells (e.g. `PosShell`) must not attempt to counter-sync tab state to the root.
- [x] **Connection Refusal Cleanup:** Verify console logs are clear of recurring `ERR_INSUFFICIENT_RESOURCES` or `ERR_CONNECTION_REFUSED` during standard operation.
- [x] **Bridge Polling Silence:** Confirm Counterpoint Bridge is configured for "boot-check only" mode (idle heartbeat disabled).
- [x] **Frontend Poll Guard:** Verify `CounterpointSyncSettingsPanel` and similar components do not trigger infinite re-render loops on network failure.

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
- [ ] Verify scanner reads SKU and lands in expected POS/inventory search flows.
- [ ] Verify card reader is online and payment path initializes successfully.
- [ ] Verify report/label print output from designated back-office station.
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
- [ ] **Financial Discrepancy:** Any mismatch between POS Cart totals and Payment Terminal captured amount.
- [ ] **Tax Engine Error:** Incorrect tax applied to a live transaction (e.g. NYC threshold failure).
- [ ] **Inventory Ghosting:** Sale completes but inventory does not decrement (or double-decrements).

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

## POS Wedding Hub Restoration (v0.2.1)

- [x] **Component Restoration:** Replace full-screen `WeddingManagerApp` in the POS shell with the slimmed-down `WeddingPOSWorkspace`.
- [x] **Slideout Integration:** Verify that "Action Board", "Parties", and "Calendar" tabs correctly respond to sidebar sub-section navigation in the POS shell.
- [x] **Action Board Priority Feed:** Confirm that the Action Board correctly pulls from the priority-feed-bundle (`morning-compass`) and allows clicking into wedding party details.
- [x] **POS Detail Redirect:** Verify that clicking a party or member in the POS Wedding Hub correctly triggers the `onOpenWeddingParty` callback to open the appropriate detail drawer or view.
- [x] **Performance Check:** Ensure the Wedding Hub does not trigger excessive re-renders when switching between sub-sections in the POS.

---

<!-- Add new launch areas above this line or as new ## sections. -->
