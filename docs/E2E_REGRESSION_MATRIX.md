# E2E and regression coverage matrix

**Purpose:** Single map from **product surface** → **automated tests** (Playwright + API smoke) and **known gaps**. Agents and maintainers should update this file in the **same PR** as new `client/e2e/*.spec.ts` files or intentional coverage changes.

**Run:**

```bash
cd client
npm run test:e2e -- --list
E2E_BASE_URL="http://localhost:5173" E2E_API_BASE="http://127.0.0.1:3000" npx playwright test --workers=1
```

Prefer **`localhost`** for `E2E_BASE_URL` (see **`AGENTS.md`**). Full UI specs need **`npm run dev`** (API + Vite). **`api-gates.spec.ts`** needs only the **API** on **`E2E_API_BASE`**.

Helpers: **`client/e2e/helpers/backofficeSignIn.ts`** (`signInToBackOffice`, **`E2E_BO_STAFF_CODE`** default **1234**), **`client/e2e/helpers/openPosRegister.ts`**.

---

## Playwright UI specs (`client/e2e/`)

| Spec | What it covers | Prerequisites / notes |
|------|----------------|------------------------|
| **`backoffice-signin.spec.ts`** | Back Office keypad gate; wrong code; **Switch staff** | API + migration **53** staff; serial mode |
| **`pos-golden.spec.ts`** | POS shell: open till, cashier overlay, product search / checkout drawer path | Same + register session |
| **`exchange-wizard.spec.ts`** | Exchange wizard opens from cart | Open till + cashier signed in |
| **`morning-compass-coach.spec.ts`** | **Suggested next** coach on **Register dashboard** + **Operations** morning home | Permissions: **`weddings.view`** or **`tasks.complete`** or **`notifications.view`** |
| **`staff-tasks.spec.ts`** | **Staff → Tasks** → **My tasks** | Migration **56**, task permissions |
| **`podium-settings.spec.ts`** | **Settings → Integrations** Podium section | **`settings.admin`**-ish paths |
| **`qbo-staging.spec.ts`** | QBO workspace staging shell (map / propose / approve / sync flow) | Insights/QBO permissions; may flake if data dependent |
| **`help-center.spec.ts`** | Help from BO header + POS; search results | API; Meilisearch optional |
| **`reports-workspace.spec.ts`** | **Reports** curated library (`insights.view`); Admin **Margin pivot** tile + API wait | API + migration **53** admin; nav uses **`data-testid="sidebar-nav-reports"`** |
| **`pwa-responsive.spec.ts`** | Narrow + tablet viewports; shell + **Insights** lazy heading | UI only |
| **`visual-baselines.spec.ts`** | Full-page screenshots: register closed, QBO, dark inventory, customers, operations | **`settings.admin`** for Settings/dark path; **skipped in CI** unless **`E2E_RUN_VISUAL=1`** (font/layout drift) |
| **`api-gates.spec.ts`** | **HTTP:** anonymous 401/403 on sample routes; staff probes | API only (no browser base URL) |

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

- **`playwright-e2e.yml`:** on **PR** and **push** to **`main`** — Postgres (**`pgvector/pgvector:pg16`**), **`scripts/apply-migrations-psql.sh`**, **`scripts/seed_e2e_non_admin_staff.sql`**, **`cargo build` / `cargo run`** with **`RIVERSIDE_HTTP_BIND=127.0.0.1:3000`**, **`client` `npm ci` + `npm run build`**, Playwright Chromium + **`npx playwright test --workers=1`**. **`E2E_BASE_URL` / `E2E_API_BASE`** target **`http://127.0.0.1:3000`** (SPA from Axum). Failure uploads **`playwright-output`** artifact.
- **`tauri-register-build.yml`:** Windows Tauri bundle (**`workflow_dispatch`** only).

Local release gate remains **`E2E_BASE_URL=http://localhost:5173`** + **`npm run dev`** when exercising Vite-specific behavior.

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
