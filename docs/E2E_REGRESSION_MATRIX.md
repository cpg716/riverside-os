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

## Playwright UI specs (`client/e2e/`)

| Spec | What it covers | Prerequisites / notes |
|------|----------------|------------------------|
| **`backoffice-signin.spec.ts`** | Back Office keypad gate; wrong code; **Switch staff** | API + migration **53** staff; serial mode |
| **`pos-golden.spec.ts`** | POS shell: open till, cashier overlay, product search / checkout drawer path | Same + register session. **Temporarily quarantined in CI** behind `ROS_QUARANTINE_UNSTABLE_POS_E2E=1` while POS shell/cashier-overlay determinism is redesigned; see [`docs/POS_E2E_TESTABILITY_FOLLOWUP.md`](POS_E2E_TESTABILITY_FOLLOWUP.md). |
| **`exchange-wizard.spec.ts`** | Exchange wizard opens from cart; return recalculation parity across transaction detail, refund queue, and receipt ZPL | Open till + cashier signed in; deterministic local stack seeds Admin (`1234`). The UI-open test is **temporarily quarantined in CI** behind `ROS_QUARANTINE_UNSTABLE_POS_E2E=1`; the API parity test remains required. See [`docs/POS_E2E_TESTABILITY_FOLLOWUP.md`](POS_E2E_TESTABILITY_FOLLOWUP.md). |
| **`morning-compass-coach.spec.ts`** | **Suggested next** coach on **Register dashboard** + **Operations** morning home | Permissions: **`weddings.view`** or **`tasks.complete`** or **`notifications.view`** |
| **`staff-tasks.spec.ts`** | **Staff → Tasks** → **My tasks** | Migration **56**, task permissions |
| **`podium-settings.spec.ts`** | **Settings → Integrations** Podium section | **`settings.admin`**-ish paths |
| **`qbo-staging.spec.ts`** | QBO workspace staging shell (map / propose / approve / sync flow) | Insights/QBO permissions; may flake if data dependent |
| **`help-center.spec.ts`** | Help from BO header + POS; search results; **Settings → Help Center Manager** tab visibility; Automation and Search & Index admin-op request wiring | API; Meilisearch optional; manager flows require staff with **`help.manage`** |
| **`reports-workspace.spec.ts`** | **Reports** curated library (`insights.view`); Admin **Margin pivot** tile + API wait | API + migration **53** admin; nav uses **`data-testid="sidebar-nav-reports"`** |
| **`pwa-responsive.spec.ts`** | Narrow + tablet viewports; shell + **Insights** lazy heading | UI only |
| **`phase2-tender-ui.spec.ts`** | POS tender drawer smoke: core tender tabs, customer-linked Saved Card / Store Credit | **Temporarily quarantined in CI** behind `ROS_QUARANTINE_UNSTABLE_POS_E2E=1` while POS register-ready / cashier-overlay contracts are redesigned; see [`docs/POS_E2E_TESTABILITY_FOLLOWUP.md`](POS_E2E_TESTABILITY_FOLLOWUP.md). |
| **`tax-exempt-and-stripe-branding.spec.ts`** | STRIPE branding + tax-exempt checkout drawer flow + customer-linked vault tab | **Temporarily quarantined in CI** behind `ROS_QUARANTINE_UNSTABLE_POS_E2E=1` while POS register-ready / cashier-overlay contracts are redesigned; see [`docs/POS_E2E_TESTABILITY_FOLLOWUP.md`](POS_E2E_TESTABILITY_FOLLOWUP.md). |
| **`visual-baselines.spec.ts`** | Full-page screenshots: register closed, QBO, dark inventory, customers, operations | **Opt-in only**: runs only when **`E2E_RUN_VISUAL=1`** (local or CI). By default this suite is skipped to avoid release-blocking snapshot drift (fonts/layout/render differences). Visual stability is improved via Playwright defaults (`animation: "disabled"`, `timezoneId: "UTC"`, `locale: "en-US"`); canonical screenshot updates should run in a pinned environment. |
| **`api-gates.spec.ts`** | **HTTP:** anonymous 401/403 on sample routes; staff probes | API only (no browser base URL) |
| **`high-risk-regressions.spec.ts`** | High-risk API regressions: route mount smoke (non-404), NYS tax audit auth/shape, sales-pivot basis alias stability (`booked`/`sale`/`completed`/`pickup`), Help Manager admin-op RBAC + payload shape, session endpoint auth behavior, non-admin permission boundaries | API-focused release hardening; seeded Admin (`1234`) and non-Admin (`5678`) recommended |
| **`phase2-finance-and-help-lifecycle.spec.ts`** | Phase 2 release checks: Help manual policy lifecycle persistence/revert, Help admin policy RBAC boundaries, NYS tax + sales-pivot contract stability, payments/session auth-gate safety, non-admin boundary checks on sensitive analytics/help-admin routes | API-centric deterministic suite for finance/help lifecycle hardening; requires seeded Admin (`1234`) and recommended non-Admin (`5678`) |
| **`tender-matrix-contract.spec.ts`** | Deterministic tender contract checks for checkout-critical payment intent modes (manual/MOTO, reader, saved-card failure behavior, credit-negative rejection), cancel-intent error contract, and session-safe auth expectations | API-centric tender hardening without hardware dependency; validates contract stability and guardrails while UI tender smoke remains in POS workflows |

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
| Operations home / morning board | Coach strip (**morning-compass**), visual baseline | Activity feed depth, compass drawers |
| Customers / CRM / hub / RMS / duplicates | Visual baseline (customers workspace) | Hub tabs, merge, shipments |
| Orders / refunds / exchanges | — | Refund queue, returns, exchanges |
| Inventory / receiving / import | Visual baseline (inventory dark) | Receiving post, CSV import |
| Weddings (embedded WM) | — | Party pipeline, appointments |
| Staff / schedule / commission / audit | Tasks subsection | Pins, payouts, schedule |
| QBO | Visual + staging spec | Live sync, production mappings |
| **Reports** (curated insights library) | **`reports-workspace.spec.ts`** (catalog + margin pivot) | Extra report tiles, CSV export |
| Insights / Metabase shell | PWA Insights heading smoke | iframe embed, Metabase auth |
| Settings / backups / integrations | Podium + visual paths | Full backup flow, every integration card |
| Scheduler | — | Book / edit appointment |
| Alterations / gift cards / loyalty | — | Core flows |
| POS register / cart / checkout | Golden, exchange | Full tender matrix, Z-close, parked/RMS |
| POS Dashboard | Coach | Metrics cards, notification actions |
| POS Reports / other rails | — | Register reports, procurement |

---

## Server-side unit tests (`server/`)

**Spot coverage** in `logic/*` (e.g. **tax**, **pricing**, **shippo**, **podium**, **receipt_privacy**, **meilisearch_documents**, **template_variant_pricing**, **procurement**, **models**). There is **no** requirement that every `api/*.rs` route has a Rust integration test — **`cargo test`** is complementary to Playwright, not a full API matrix.

---

## CI

- **`playwright-e2e.yml`:** on **PR** and **push** to **`main`** — Postgres (**`pgvector/pgvector:pg16`**), **`scripts/apply-migrations-psql.sh`**, **`scripts/seed_e2e_non_admin_staff.sql`**, **`scripts/seed_staff_register_test.sql`**, **`cargo build` / `cargo run`** with **`RIVERSIDE_HTTP_BIND=127.0.0.1:3000`**, **`RIVERSIDE_ENABLE_E2E_TEST_SUPPORT=1`**, **`client` `npm ci` + `npm run build`**, Playwright Chromium + **`npx playwright test --workers=1`**. **`E2E_BASE_URL`** targets **`http://localhost:3000`** (browser-safe SPA origin) while **`E2E_API_BASE`** targets **`http://127.0.0.1:3000`**. CI opens a default Register #1 session before the suite so the tender contract coverage cannot silently skip due to missing session state, and it now sanity-checks the test-support routes before the suite starts. Failure uploads **`playwright-output`** artifacts, including Playwright traces and the server/fake-host logs for faster debugging. Visual baselines are **non-blocking by default** because they are opt-in via **`E2E_RUN_VISUAL=1`**; when enabled, use stabilized visual settings (animations disabled, UTC timezone, en-US locale) and a pinned environment for snapshot authority.
- **Temporary CI quarantine:** `playwright-e2e.yml` sets **`ROS_QUARANTINE_UNSTABLE_POS_E2E=1`** to skip the currently order-dependent POS UI subset (`phase2-tender-ui`, `pos-golden`, `tax-exempt-and-stripe-branding`, and the UI-open test in `exchange-wizard`) until the explicit POS testability contracts in [`docs/POS_E2E_TESTABILITY_FOLLOWUP.md`](POS_E2E_TESTABILITY_FOLLOWUP.md) are implemented.
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
| 2026-04-08 | Initial matrix + **`playwright-e2e.yml`** CI; **`seed_e2e_non_admin_staff.sql`**; **`api-gates`**: best-sellers 401, margin **403** for non-Admin; visual baselines **skipped** on CI unless **`E2E_RUN_VISUAL=1`** |
| 2026-04-08 | **`reports-workspace.spec.ts`**; matrix rows updated. **Operations** sidebar: **Dashboard** includes the former **Activity** content; deep link **`subsection=activity`** normalizes to **dashboard** (`App.tsx`). |
| 2026-04-11 | Expanded **Help Center** coverage: `help-center.spec.ts` now includes **Help Center Manager** settings navigation and admin-op request checks (generate-manifest / reindex-search); `api-gates.spec.ts` now includes anonymous/non-admin/admin route gates and payload-shape checks for **`/api/help/admin/ops/*`**. |
| 2026-04-11 | Added **`high-risk-regressions.spec.ts`** for release-critical API checks: migration route mount smoke, NYS tax audit auth/shape, sales-pivot basis alias stability, help-admin op RBAC/payload checks, session auth behavior, and non-admin boundary assertions. |
| 2026-04-11 | Added **`phase2-finance-and-help-lifecycle.spec.ts`** for Phase 2 hardening: Help manual policy lifecycle persistence/revert, policy endpoint RBAC boundaries, finance-sensitive contract checks, and payments/session auth-gate regressions. |
| 2026-04-11 | Added **`tender-matrix-contract.spec.ts`** for deterministic checkout tender contract coverage (payment-intent mode contracts, cancel-intent error contract, session-safe guards) without hardware coupling. |
| 2026-04-11 | Visual baseline policy clarified: `visual-baselines.spec.ts` is **opt-in** behind **`E2E_RUN_VISUAL=1`** and treated as **non-blocking** for standard release gates unless explicitly enabled; visual runs use stabilized config defaults (animations disabled, UTC timezone, en-US locale). |
