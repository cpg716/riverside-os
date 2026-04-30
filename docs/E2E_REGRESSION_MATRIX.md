# E2E and regression coverage matrix

**Purpose:** Single map from **product surface** → **automated tests** (Playwright + API smoke) and **known gaps**. Agents and maintainers should update this file in the **same PR** as new `client/e2e/*.spec.ts` files or intentional coverage changes.

**Run:**

```bash
cd client
npm run test:e2e -- --list
E2E_BASE_URL="http://localhost:43173" E2E_API_BASE="http://127.0.0.1:43300" npx playwright test --workers=1
```

Prefer **`localhost`** for `E2E_BASE_URL` (see **`AGENTS.md`**). Full UI specs need a reachable API + Vite pair. **`api-gates.spec.ts`** needs only the **API** on **`E2E_API_BASE`**.
For deterministic local browser runs, prefer **`npm run dev:e2e`** from the repo root. That stack uses dedicated local ports (**`http://127.0.0.1:43300`** API + **`http://localhost:43173`** UI) so it does not collide with a normal `npm run dev` session on `3000/5173` or other local Vite apps. The Vite side uses `--strictPort` so collisions fail fast. Playwright also auto-boots that same dedicated stack unless **`E2E_AUTO_BOOT=0`** is set.

Helpers: **`client/e2e/helpers/backofficeSignIn.ts`** (`signInToBackOffice`, **`E2E_BO_STAFF_CODE`** default **1234**), **`client/e2e/helpers/openPosRegister.ts`**.

---

## Current hardening + execution policy (2026-04-30)

### Recently hardened

- POS bootstrap helper (`openPosRegister.ts`) replaced fixed waits with deterministic readiness checks.
- QBO staging UI removed `networkidle` waiting and now waits on explicit UI readiness.
- Overlay stacking checks were hardened for deterministic top-layer/interactability assertions.
- Added **`staff-audit-labels.spec.ts`** for staff-facing readable/non-technical label coverage.
- Added **`settings-deeplink-contract.spec.ts`** for Settings direct-route/fallback/normalization coverage.

### Blocking core suite (release gate)

Keep these **blocking**. They protect financial/tax/register/audit correctness and core UI/workflow contracts:

- `checkout-tender-financial-contract.spec.ts`
- `tax-audit-contract.spec.ts`
- `commission-audit-contract.spec.ts`
- `inventory-audit-contract.spec.ts`
- `register-audit-contract.spec.ts`
- `register-close-reconciliation.spec.ts`
- `offline-recovery-contract.spec.ts`
- `qbo-audit-contract.spec.ts`
- `tender-matrix-contract.spec.ts`
- `orders-custom-contract.spec.ts`
- `orders-detail-handoff.spec.ts`
- `inventory-receiving-api.spec.ts`
- `inventory-receiving-ui.spec.ts`
- `inventory-physical-ui.spec.ts`
- `exchange-wizard.spec.ts`
- `pos-navigation-contract.spec.ts`
- `ui-portaling-stacking.spec.ts`
- `settings-deeplink-contract.spec.ts`
- `staff-audit-labels.spec.ts`
- `api-gates.spec.ts`
- `phase2-finance-and-help-lifecycle.spec.ts`

### Non-blocking / nightly candidates

These remain useful but are lower-signal or environment-sensitive and should default to nightly/non-blocking lanes:

- `visual-baselines.spec.ts` (already opt-in)
- `qbo-staging.spec.ts`
- `pwa-responsive.spec.ts`
- `backoffice-mobile-workflow-smoke.spec.ts`
- `pos-small-screen-smoke.spec.ts`
- `pos-modal-smoke.spec.ts`
- `reports-mobile-cards.spec.ts`
- `gift-cards-mobile-cards.spec.ts`
- `loyalty-eligible-mobile.spec.ts`
- `scheduler-mobile-ergonomics.spec.ts`
- `alterations-register-lookup-mobile.spec.ts`

### Consolidation candidates (plan only, no removals yet)

- `pos-golden.spec.ts` → removal candidate after confirming equivalent POS bootstrap coverage in other POS specs.
- `backoffice-workspace-nav-smoke.spec.ts` → merge candidate into `backoffice-mobile-workflow-smoke.spec.ts`.
- `settings-mobile-sections.spec.ts` → merge candidate into `settings-mobile.spec.ts`.
- `high-risk-regressions.spec.ts` → merge candidate into `phase2-finance-and-help-lifecycle.spec.ts` and/or `api-gates.spec.ts`.

**Guardrail:** financial, tax, register, and audit contract suites stay blocking.

---

## Playwright UI specs (`client/e2e/`)

| Spec | What it covers | Prerequisites / notes |
|------|----------------|------------------------|
| **`backoffice-signin.spec.ts`** | Back Office keypad gate; wrong code; **Switch staff** | API + migration **53** staff; serial mode |
| **`backoffice-mobile-workflow-smoke.spec.ts`** | Mobile/tablet/desktop smoke for scheduler, inventory receiving/order stock, customer shipments, gift cards, and loyalty refresh flows | Responsive workflow smoke across shared Back Office surfaces |
| **`backoffice-workspace-nav-smoke.spec.ts`** | Back Office navigation smoke for Customers, Orders, Gift Cards, Loyalty, Appointments, Inventory, and Settings across viewports | Catches shell/sidebar regressions and stuck loading states |
| **`pos-golden.spec.ts`** | POS shell: open till, cashier overlay, product search / checkout drawer path | Same + register session. Uses explicit POS register-ready and cashier-overlay contracts; see [`docs/POS_E2E_TESTABILITY_FOLLOWUP.md`](POS_E2E_TESTABILITY_FOLLOWUP.md). |
| **`pos-navigation-contract.spec.ts`** | POS rail section contract, narrowed POS-native sections, and rapid tab changes staying in POS mode | Uses explicit POS register-ready and cashier-overlay contracts |
| **`pos-modal-smoke.spec.ts`** | POS modal smoke across viewports | Responsive modal coverage for register flows |
| **`pos-small-screen-smoke.spec.ts`** | POS shell/cart/register smoke on small and tablet viewports | Mobile/PWA regression coverage for core register surface |
| **`pos-dropdown-visibility.spec.ts`** | POS dropdown menus remain visible near the bottom of a scrollable cart | Protects dropdown clipping/viewport behavior |
| **`pos-alterations-intake.spec.ts`** | POS alteration intake, lookup-only/current-cart/custom item flows, charged/free alteration cart lines, and existing Transaction Record payment flow | Uses mocked POS/API flows plus checkout payload assertions |
| **`exchange-wizard.spec.ts`** | Exchange wizard opens from cart; return recalculation parity across transaction detail, refund queue, and receipt ZPL | Open till + cashier signed in; deterministic local stack seeds Admin (`1234`). Uses explicit POS register-ready and cashier-overlay contracts. |
| **`register-close-reconciliation.spec.ts`** | Register close notes for cash discrepancies, historical till-group session list, and pending close coordination | Register session lifecycle and reconciliation contract |
| **`morning-compass-coach.spec.ts`** | **Suggested next** coach on **Register dashboard** + **Operations** morning home | Permissions: **`weddings.view`** or **`tasks.complete`** or **`notifications.view`** |
| **`data-quality-signals.spec.ts`** | Lightweight completeness/data-quality summaries in workspaces | UI smoke for operator-facing quality indicators |
| **`notification-deep-link-contract.spec.ts`** | Notification deep-link actionability, bundle preview behavior, severity/recency mapping, and bulk lifecycle helpers | Unit-style Playwright contract without browser navigation |
| **`staff-tasks.spec.ts`** | **Staff → Tasks** → **My tasks** | Migration **56**, task permissions |
| **`staff-scheduler.spec.ts`** | Staff public weekly roster, individual availability, master scheduler, store events, and master-template mode | Staff scheduling UI contract |
| **`staff-audit-labels.spec.ts`** | Staff-facing audit surfaces keep labels readable and non-technical (no raw key/enum leakage) | Operator-language readability contract for audit UI |
| **`podium-settings.spec.ts`** | **Settings → Integrations** Podium section | **`settings.admin`**-ish paths |
| **`settings-mobile.spec.ts`** | **Settings** grouped sidebar contract and deep links for `register`, `tag-designer`, `shippo`, and `ros-dev-center` | UI + notifications mocked for Settings deep-link navigation; confirms targets do not fall back to General |
| **`settings-mobile-sections.spec.ts`** | Settings section navigation for General, Help Center, and Bug Reports across phone/tablet/iPad/desktop | Responsive Settings routing smoke |
| **`settings-deeplink-contract.spec.ts`** | Direct URL settings deep links, invalid-subroute fallback, partial-route normalization, and no dead-shell contract | Route contract for `/settings` and `/settings/*` path behavior |
| **`qbo-staging.spec.ts`** | QBO workspace staging shell (map / propose / approve / sync flow) | Insights/QBO permissions; may flake if data dependent |
| **`help-center.spec.ts`** | Help from BO header + POS; search results; **Settings → Help Center Manager** tab visibility; Automation and Search & Index admin-op request wiring | API; Meilisearch optional; manager flows require staff with **`help.manage`** |
| **`reports-workspace.spec.ts`** | **Reports** curated library (`insights.view`); Admin **Margin pivot** tile + API wait | API + migration **53** admin; nav uses **`data-testid="sidebar-nav-reports"`** |
| **`reports-mobile-cards.spec.ts`** | Reports responsive card/list behavior across mobile/tablet/desktop viewports | Responsive Reports smoke |
| **`pwa-responsive.spec.ts`** | Narrow + tablet viewports; shell + **Insights** lazy heading | UI only |
| **`scheduler-mobile-ergonomics.spec.ts`** | Scheduler mobile ergonomics across phone/tablet/iPad/desktop viewports | Responsive Appointments/Scheduler smoke |
| **`customer-relationship-mobile-cards.spec.ts`** | Customer Relationship Hub responsive cards, profile defaults, history, loyalty controls, linked profiles, and staff-facing timeline language | Mocked CustomerHub APIs; viewport coverage |
| **`customers-lifecycle.spec.ts`** | Add-customer address flows, lookup failure resilience, duplicate review timing, and lifecycle filter/hub badge alignment | Customer workspace + mocked address/lookup behavior |
| **`customers-rms-charge.spec.ts`** | Back Office RMS Charge exception ownership/retry, resolution notes, reconciliation usability, and account link correction | Uses fake CoreCard/test-support fixtures |
| **`orders-custom-contract.spec.ts`** | Custom vs special vs wedding order contracts, custom detail persistence, cost deferral until receipt, deposits, odd-cent balance, and pickup lifecycle | API-centric Orders/Fulfillment contract |
| **`phase2-tender-ui.spec.ts`** | POS tender drawer smoke: core tender tabs, customer-linked Saved Card / Store Credit | Uses explicit POS register-ready and cashier-overlay contracts; release gate. |
| **`tax-exempt-and-stripe-branding.spec.ts`** | STRIPE branding + tax-exempt checkout drawer flow + customer-linked vault tab | Uses explicit POS register-ready and cashier-overlay contracts; release gate. |
| **`gift-card-redemption-contract.spec.ts`** | Purchased/donated gift card redemption, balance reduction, Back Office issuance block, subtype mismatch, and insufficient-balance messaging | Gift card accounting contract |
| **`gift-cards-mobile-cards.spec.ts`** | Gift Cards responsive list/card mode across phone/tablet/iPad/desktop | Responsive Gift Cards smoke |
| **`loyalty-redemption-contract.spec.ts`** | Loyalty reward issuance, manual adjustments, issuance-only immediate-use guard, non-loyalty code block, couple-linked reward behavior, and timeline sharing | Loyalty + customer relationship contract |
| **`loyalty-eligible-mobile.spec.ts`** | Loyalty eligible actions on mobile/tablet/desktop viewports | Responsive Loyalty smoke |
| **`alterations-register-lookup-mobile.spec.ts`** | Alterations + Register lookup responsive behavior across viewports | Mobile/PWA smoke for alteration lookup handoff |
| **`alterations-safety.spec.ts`** | Alteration activity audit, source/work/charge fields, invalid payload guards, status filter, and garment workbench labels | API + Back Office alteration safety contract |
| **`alterations-smart-scheduler.spec.ts`** | Smart alterations scheduler planning, wedding member alteration status, and manual alteration appointment creation | Scheduler + Alterations + Wedding Hub contract |
| **`inventory-receiving-api.spec.ts`** | Batch scan staging, final PO receipt exact-once behavior, unified inventory truth, timeline history, and direct invoice exact-once replay | Inventory receiving API contract |
| **`inventory-receiving-ui.spec.ts`** | Receive Stock operator flow, standard PO submit/stage/receive path, and direct invoice receiving without raw ID entry | Inventory receiving UI contract |
| **`inventory-physical-ui.spec.ts`** | Physical inventory review surfaces missing in-scope SKUs and publish applies reconciled stock | Physical inventory UI contract |
| **`inventory-physical-mobile-cards.spec.ts`** | Physical inventory responsive cards across phone/tablet/iPad/desktop | Responsive physical inventory smoke |
| **`visual-baselines.spec.ts`** | Full-page screenshots: register closed, QBO, dark inventory, customers, operations | **Opt-in only**: runs only when **`E2E_RUN_VISUAL=1`** (local or CI). By default this suite is skipped to avoid release-blocking snapshot drift (fonts/layout/render differences). Visual stability is improved via Playwright defaults (`animation: "disabled"`, `timezoneId: "UTC"`, `locale: "en-US"`); canonical screenshot updates should run in a pinned environment. |
| **`ui-portaling-stacking.spec.ts`** | Refund modal over Transaction Detail drawer, receipt action availability, exchange confirmation modal stacking, and stock adjustment modal over Product Hub | Overlay/portal stacking contract |
| **`api-gates.spec.ts`** | **HTTP:** anonymous 401/403 on sample routes; staff probes | API only (no browser base URL) |
| **`high-risk-regressions.spec.ts`** | High-risk API regressions: route mount smoke (non-404), NYS tax audit auth/shape, sales-pivot basis alias stability (`booked`/`sale`/`completed`/`pickup`), Help Manager admin-op RBAC + payload shape, session endpoint auth behavior, non-admin permission boundaries | API-focused release hardening; seeded Admin (`1234`) and non-Admin (`5678`) recommended |
| **`phase2-finance-and-help-lifecycle.spec.ts`** | Phase 2 release checks: Help manual policy lifecycle persistence/revert, Help admin policy RBAC boundaries, NYS tax + sales-pivot contract stability, payments/session auth-gate safety, non-admin boundary checks on sensitive analytics/help-admin routes | API-centric deterministic suite for finance/help lifecycle hardening; requires seeded Admin (`1234`) and recommended non-Admin (`5678`) |
| **`tender-matrix-contract.spec.ts`** | Deterministic tender contract checks for checkout-critical payment intent modes (manual/MOTO, reader, saved-card failure behavior, credit-negative rejection), cancel-intent error contract, and session-safe auth expectations | API-centric tender hardening without hardware dependency; validates contract stability and guardrails while UI tender smoke remains in POS workflows |
| **`checkout-tender-financial-contract.spec.ts`** | Missing check-number rejection, split tender allocation across current sale + existing balance, rounded-up/down cash behavior, mixed tender cash-residual rounding, non-cash exact-cent behavior, and cash rounding ledger/QBO impact | Production hardening audit contract; included in `npm run test:e2e:tender` and release gate |
| **`orders-detail-handoff.spec.ts`** | Back Office/POS Transaction Record drawer handoff, detail edit round-trip, and wording boundaries between Transaction Records, Fulfillment Work, and Layaways | Production hardening contract for Orders navigation and staff-facing terminology |
| **`tax-audit-contract.spec.ts`** | NYS/Erie clothing threshold, discount crossing, stale client tax rejection, return tax reversal, and QBO tax liability mapping | Production hardening audit contract |
| **`commission-audit-contract.spec.ts`** | Fulfillment-based commission timing, rate specificity order, finalized payout immutability, and internal SPIFF receipt exclusion | Production hardening audit contract |
| **`inventory-audit-contract.spec.ts`** | Order-style no-decrement checkout, pickup stock decrement, duplicate PO receipt retry, and return/restock refund truth | Production hardening audit contract |
| **`offline-recovery-contract.spec.ts`** | 4xx checkout replay retention as blocked recovery and register close blocking while checkout recovery is pending/blocked | Production hardening audit contract |
| **`qbo-audit-contract.spec.ts`** | Balanced staged proposal, mapped accounts, dedupe, staging visibility, drilldown tender linkage, one-time approval, and store-local business-date cutoff | Production hardening audit contract |
| **`register-audit-contract.spec.ts`** | Register #1/till group lifecycle, closed-token rejection, and Z-close parked-sale purge/audit rows | Production hardening audit contract |
| **`intelligence-and-finance.spec.ts`** | Wedding health, inventory brain, commission trace rationale, Stripe setup/payment config auth/secret hygiene, and product intelligence payloads | API-centric intelligence/finance contract |
| **`pos-rms-charge.spec.ts`** | POS RMS financed sale success/decline, no-customer block, multi-match metadata, payment collection success/failure, receipt wording, and legacy RMS/RMS90 compatibility | Fake CoreCard host + RMS test-support fixtures |
| **`corecard-webhooks.spec.ts`** | CoreCard webhook ingestion updates state and replay remains idempotent | Fake CoreCard/CoreCard webhook contract |
| **`rms-reconciliation.spec.ts`** | RMS reconciliation mismatch visibility and clearing-path support | Fake CoreCard/test-support fixtures |
| **`rms-permissions.spec.ts`** | POS-limited vs Back Office admin RMS workspace capability split | Requires seeded staff permission split |

---

## API smoke (`api-gates.spec.ts`) — route inventory

These are **not** exhaustive RBAC tests; they catch **totally open** regressions. Expand this table when adding high-risk **GET** handlers.

| Check | Expected |
|--------|----------|
| `GET /api/products` (no headers) | **401** |
| `POST /api/payments/intent` (no auth) | **401** |
| `GET /api/settings/receipt` (no staff) | **401** or **403** |
| `GET /api/customers/{uuid}/order-history` (no staff) | **401** |
| `GET /api/insights/sales-pivot?…` (no staff) | **401** |
| `GET /api/insights/best-sellers` (no staff) | **401** |
| `GET /api/insights/margin-pivot` (no staff) | **401** |
| `GET /api/insights/margin-pivot` (non-Admin staff, e.g. **`5678`**) | **403** — requires **`scripts/seed_e2e_non_admin_staff.sql`** (or **`E2E_NON_ADMIN_CODE`**) |
| `GET /api/insights/margin-pivot` (seeded **Admin** staff) | **200**, JSON `rows` + `truncated` |
| `GET /api/staff/effective-permissions` (seeded code+PIN) | **200**, non-empty `permissions` |
| `GET /api/sessions/list-open` (staff headers) | **200** array |
| `GET /api/help/admin/ops/status` (no staff) | **401** |
| `POST /api/help/admin/ops/generate-manifest` (no staff) | **401** |
| `POST /api/help/admin/ops/reindex-search` (no staff) | **401** |
| `GET /api/help/admin/ops/status` (non-Admin staff, e.g. **`5678`**) | **403** (or skip when non-Admin seed is missing) |
| `POST /api/help/admin/ops/generate-manifest` (non-Admin staff) | **403** (or skip when non-Admin seed is missing) |
| `POST /api/help/admin/ops/reindex-search` (non-Admin staff) | **403** (or skip when non-Admin seed is missing) |
| `GET /api/help/admin/ops/status` (seeded **Admin** staff) | **200**, boolean status shape (`meilisearch_configured`, `meilisearch_indexing`, `node_available`, `script_exists`, `help_docs_dir_exists`) |
| `POST /api/help/admin/ops/generate-manifest` (seeded **Admin** staff) | **200**, terminal result shape (`ok`, `exit_code`, `stdout`, `stderr`) |
| `POST /api/help/admin/ops/reindex-search` (seeded **Admin** staff) | **200**, status payload shape (`status`, optional `mode`) |

**Not covered here (add spec or expand gates intentionally):** granular **`insights.view`** vs other keys on every **`/api/insights/*`** route, **`POST`** mutations, Counterpoint M2M, webhooks.

---

## Back Office workspaces — coverage vs `UI_WORKSPACE_INVENTORY.md`

| Area | Automated | Gap (manual / future E2E) |
|------|-----------|---------------------------|
| Operations home / morning board | **`morning-compass-coach.spec.ts`**, **`backoffice-workspace-nav-smoke.spec.ts`**, **`backoffice-mobile-workflow-smoke.spec.ts`**, **`data-quality-signals.spec.ts`**, visual baseline | Activity feed depth, compass drawers |
| Customers / CRM / hub / RMS / duplicates | **`customer-relationship-mobile-cards.spec.ts`**, **`customers-lifecycle.spec.ts`**, **`customers-rms-charge.spec.ts`**, visual baseline | Merge edge cases, full shipments workflow |
| Orders / refunds / exchanges | **`orders-detail-handoff.spec.ts`**, **`orders-custom-contract.spec.ts`**, **`exchange-wizard.spec.ts`** | Refund queue breadth, every return/exchange branch |
| Inventory / receiving / import | **`inventory-audit-contract.spec.ts`**, **`inventory-receiving-api.spec.ts`**, **`inventory-receiving-ui.spec.ts`**, **`inventory-physical-ui.spec.ts`**, **`inventory-physical-mobile-cards.spec.ts`**, visual baseline | CSV import |
| Weddings (embedded WM) | **`alterations-smart-scheduler.spec.ts`**, **`morning-compass-coach.spec.ts`** | Full party pipeline |
| Staff / schedule / commission / audit | **`staff-tasks.spec.ts`**, **`staff-scheduler.spec.ts`**, **`staff-audit-labels.spec.ts`**, **`commission-audit-contract.spec.ts`** | PIN/admin profile edge cases, payout UI breadth |
| QBO | **`qbo-staging.spec.ts`**, **`qbo-audit-contract.spec.ts`**, visual baseline | Live sync, production mappings |
| **Reports** (curated insights library) | **`reports-workspace.spec.ts`**, **`reports-mobile-cards.spec.ts`** | Extra report tiles, CSV export |
| Insights / Metabase shell | **`pwa-responsive.spec.ts`**, **`intelligence-and-finance.spec.ts`** | iframe embed, Metabase auth |
| Settings / backups / integrations | **`settings-mobile.spec.ts`**, **`settings-mobile-sections.spec.ts`**, **`settings-deeplink-contract.spec.ts`**, **`podium-settings.spec.ts`**, visual paths | Full backup flow, every integration card |
| Scheduler | **`scheduler-mobile-ergonomics.spec.ts`**, **`alterations-smart-scheduler.spec.ts`** | Book/edit appointment breadth |
| Alterations / gift cards / loyalty | **`alterations-register-lookup-mobile.spec.ts`**, **`alterations-safety.spec.ts`**, **`alterations-smart-scheduler.spec.ts`**, **`gift-card-redemption-contract.spec.ts`**, **`gift-cards-mobile-cards.spec.ts`**, **`loyalty-redemption-contract.spec.ts`**, **`loyalty-eligible-mobile.spec.ts`** | Additional edge cases for legacy data |
| POS register / cart / checkout | **`pos-golden.spec.ts`**, **`phase2-tender-ui.spec.ts`**, **`tender-matrix-contract.spec.ts`**, **`checkout-tender-financial-contract.spec.ts`**, **`tax-exempt-and-stripe-branding.spec.ts`**, **`exchange-wizard.spec.ts`**, **`register-close-reconciliation.spec.ts`**, **`pos-rms-charge.spec.ts`**, **`corecard-webhooks.spec.ts`** | Hardware/live tender validation |
| POS Dashboard | **`morning-compass-coach.spec.ts`**, **`pos-navigation-contract.spec.ts`**, **`pos-small-screen-smoke.spec.ts`** | Notification action breadth |
| POS Reports / other rails | **`pos-navigation-contract.spec.ts`**, **`pos-modal-smoke.spec.ts`**, **`pos-dropdown-visibility.spec.ts`**, **`pos-alterations-intake.spec.ts`**, **`rms-permissions.spec.ts`**, **`rms-reconciliation.spec.ts`** | Procurement rail depth |

---

## Server-side unit tests (`server/`)

**Spot coverage** in `logic/*` (e.g. **tax**, **pricing**, **shippo**, **podium**, **receipt_privacy**, **meilisearch_documents**, **template_variant_pricing**, **procurement**, **models**). There is **no** requirement that every `api/*.rs` route has a Rust integration test — **`cargo test`** is complementary to Playwright, not a full API matrix.

---

## CI

- **`playwright-e2e.yml`:** on **PR** and **push** to **`main`** — Postgres (**`pgvector/pgvector:pg16`**), **`scripts/apply-migrations-psql.sh`**, **`scripts/seed_e2e_non_admin_staff.sql`**, **`scripts/seed_staff_register_test.sql`**, **`cargo build` / `cargo run`** with **`RIVERSIDE_HTTP_BIND=127.0.0.1:3000`**, **`RIVERSIDE_ENABLE_E2E_TEST_SUPPORT=1`**, **`client` `npm ci` + `npm run build`**, Playwright Chromium + **`npx playwright test --workers=1`**. **`E2E_BASE_URL`** targets **`http://localhost:3000`** (browser-safe SPA origin) while **`E2E_API_BASE`** targets **`http://127.0.0.1:3000`**. CI opens a default Register #1 session before the suite so the tender contract coverage cannot silently skip due to missing session state, and it now sanity-checks the test-support routes before the suite starts. Failure uploads **`playwright-output`** artifacts, including Playwright traces and the server/fake-host logs for faster debugging. Visual baselines are **non-blocking by default** because they are opt-in via **`E2E_RUN_VISUAL=1`**; when enabled, use stabilized visual settings (animations disabled, UTC timezone, en-US locale) and a pinned environment for snapshot authority.
- **POS UI determinism:** the formerly quarantined POS UI subset now relies on explicit POS testability contracts and runs in CI as part of the release suite.
- **`tauri-register-build.yml`:** Windows Tauri bundle (**`workflow_dispatch`** only).

Local release gate remains the Vite path, but use **`E2E_BASE_URL=http://localhost:43173`** and **`E2E_API_BASE=http://127.0.0.1:43300`** with **`npm run dev:e2e`** (or Playwright auto-boot) so DB, seed staff, API, and UI all come up together without clashing with an ordinary dev stack.

---

## Troubleshooting

- **`GET /api/insights/margin-pivot` returns `404` with HTML in `api-gates`:** The running **`riverside-server` binary is older than the route** (or you are not hitting the API port). Run **`npm run check:server`**, then **restart** dev (`npm run dev`) so Axum picks up **`/api/insights/margin-pivot`**. Anonymous callers should get **`401`**; Admin staff gets **`200`** JSON with **`rows`** and **`truncated`**.
- **Non-Admin margin test skipped (401):** Apply **`scripts/seed_e2e_non_admin_staff.sql`** to your DB, or set **`E2E_NON_ADMIN_CODE`** to match an existing **non-Admin** **`cashier_code`**.

---

## Changelog (maintainers)

| Date | Change |
|------|--------|
| 2026-04-30 | Documented current suite hardening status (deterministic POS bootstrap waits, QBO readiness waits, hardened overlay stacking), added explicit staff-audit/settings-deeplink coverage notes, and recorded consolidation candidates (plan-only; no removals yet). |
| 2026-04-30 | Reconciled the matrix against the full `client/e2e/*.spec.ts` inventory; added hardening contracts for Settings grouped navigation/deep links, Orders Transaction Record/Fulfillment/Layaway wording, and expanded checkout cash-rounding coverage. |
| 2026-04-25 | Added production hardening audit contracts for checkout tender financials, tax, commission, inventory, offline recovery, QBO, and register close; latest local release gate reported **181 passed, 7 skipped, 0 failed**. |
| 2026-04-08 | Initial matrix + **`playwright-e2e.yml`** CI; **`seed_e2e_non_admin_staff.sql`**; **`api-gates`**: best-sellers 401, margin **403** for non-Admin; visual baselines **skipped** on CI unless **`E2E_RUN_VISUAL=1`** |
| 2026-04-08 | **`reports-workspace.spec.ts`**; matrix rows updated. **Operations** sidebar: **Dashboard** includes the former **Activity** content; deep link **`subsection=activity`** normalizes to **dashboard** (`App.tsx`). |
| 2026-04-11 | Expanded **Help Center** coverage: `help-center.spec.ts` now includes **Help Center Manager** settings navigation and admin-op request checks (generate-manifest / reindex-search); `api-gates.spec.ts` now includes anonymous/non-admin/admin route gates and payload-shape checks for **`/api/help/admin/ops/*`**. |
| 2026-04-11 | Added **`high-risk-regressions.spec.ts`** for release-critical API checks: migration route mount smoke, NYS tax audit auth/shape, sales-pivot basis alias stability, help-admin op RBAC/payload checks, session auth behavior, and non-admin boundary assertions. |
| 2026-04-11 | Added **`phase2-finance-and-help-lifecycle.spec.ts`** for Phase 2 hardening: Help manual policy lifecycle persistence/revert, policy endpoint RBAC boundaries, finance-sensitive contract checks, and payments/session auth-gate regressions. |
| 2026-04-11 | Added **`tender-matrix-contract.spec.ts`** for deterministic checkout tender contract coverage (payment-intent mode contracts, cancel-intent error contract, session-safe guards) without hardware coupling. |
| 2026-04-11 | Visual baseline policy clarified: `visual-baselines.spec.ts` is **opt-in** behind **`E2E_RUN_VISUAL=1`** and treated as **non-blocking** for standard release gates unless explicitly enabled; visual runs use stabilized config defaults (animations disabled, UTC timezone, en-US locale). |
