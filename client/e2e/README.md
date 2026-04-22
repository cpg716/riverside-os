# Playwright E2E (`client/e2e/`)

**Coverage map and known gaps:** [`docs/E2E_REGRESSION_MATRIX.md`](../../docs/E2E_REGRESSION_MATRIX.md)

```bash
# Terminal 1 (repo root): start deterministic local E2E stack
npm install
npm run dev:e2e

# Terminal 2
cd client

# Client-level shortcuts
npm run test:e2e:list
npm run test:e2e:release
npm run test:e2e:visual

# Direct equivalent command
E2E_BASE_URL="http://localhost:43173" E2E_API_BASE="http://127.0.0.1:43300" npx playwright test --workers=1

# High-risk regression API suite (tax/revenue basis/help-admin/session gates)
E2E_BASE_URL="http://localhost:43173" E2E_API_BASE="http://127.0.0.1:43300" npx playwright test e2e/high-risk-regressions.spec.ts --workers=1

# Phase 2 suite (help policy lifecycle + finance-sensitive endpoint contracts)
E2E_BASE_URL="http://localhost:43173" E2E_API_BASE="http://127.0.0.1:43300" npx playwright test e2e/phase2-finance-and-help-lifecycle.spec.ts --workers=1

# Tender matrix deterministic contract suite (payment-intent modes/session-safe behavior)
E2E_BASE_URL="http://localhost:43173" E2E_API_BASE="http://127.0.0.1:43300" npx playwright test e2e/tender-matrix-contract.spec.ts --workers=1

# RMS / CoreCard deterministic suite
E2E_BASE_URL="http://localhost:43173" E2E_API_BASE="http://127.0.0.1:43300" E2E_CORECARD_BASE="http://127.0.0.1:43400" npx playwright test e2e/pos-rms-charge.spec.ts e2e/corecard-webhooks.spec.ts e2e/customers-rms-charge.spec.ts e2e/rms-reconciliation.spec.ts e2e/rms-permissions.spec.ts --workers=1
```

Config: [`playwright.config.ts`](../playwright.config.ts). Staff keypad default: **`E2E_BO_STAFF_CODE`** (default **1234**) — see migration **53** / **`docs/STAFF_PERMISSIONS.md`**.

**Important local prerequisite:** Browser-based Playwright specs require a reachable UI at **`E2E_BASE_URL`** (default `http://localhost:43173`) and API at **`E2E_API_BASE`** (default `http://127.0.0.1:43300`). Local Playwright now auto-boots the deterministic stack for that dedicated pair unless **`E2E_AUTO_BOOT=0`** is set. To mirror that stack manually, run **`npm run dev:e2e`** at the repo root; it brings up Docker Postgres, reapplies migrations, seeds the standard E2E staff fixtures, and starts the Rust API plus Vite on the dedicated E2E ports so it does not collide with a normal `npm run dev` session or other local Vite projects. The Vite side uses `--strictPort`, so a port collision fails fast instead of silently serving the wrong app.

**Server env note:** the API still reads **`server/.env`** during local/E2E boot. Keep **`DATABASE_URL=postgresql://postgres:password@localhost:5433/riverside_os`** there for the repo Docker Postgres. If you expect Metabase inside the local browser stack to auto-log in instead of showing the Metabase login page, populate the local **`RIVERSIDE_METABASE_ADMIN_*`** / **`RIVERSIDE_METABASE_STAFF_*`** shared-auth envs in **`server/.env`** as well.
**Root dependency note:** `npm run dev:e2e` and the repo-level E2E shortcuts require the root package dependencies in this worktree. Do not rely on a `node_modules` symlink from another checkout for release validation.

**CI note:** GitHub Actions runs Playwright against Axum serving the built SPA on **`http://localhost:3000`** (browser base) with the API on **`http://127.0.0.1:3000`**, not Vite on `:5173`. CI also seeds the default admin/non-admin staff fixtures, opens a default register session for the tender contract suite, enables **`RIVERSIDE_ENABLE_E2E_TEST_SUPPORT=1`** so the RMS/test-support contract suites can mount their seed endpoints, and retains Playwright traces plus server/fake-host logs on failure for faster triage.

**Client script aliases:**
- `npm run test:e2e:list` → list all tests
- `npm run test:e2e:release` → standard release gate (`--workers=1`)
- `npm run test:e2e:visual` → visual suite enabled (`E2E_RUN_VISUAL=1`, `--workers=1`)
- `npm run test:e2e:high-risk` → high-risk API regressions (tax audit, revenue basis aliases, help admin RBAC/payload shape, session route resilience)
- `npm run test:e2e:phase2` → Phase 2 lifecycle coverage (help manual policy persist/revert and finance-sensitive endpoint contract checks)
- `npm run test:e2e:tender` → deterministic tender-matrix contract coverage (manual card, card-reader mode, saved-card invalid-ID handling, credit-negative validation, cancel contract, session-safe behavior)
- `npm run test:e2e:rms` → deterministic RMS Charge / CoreCard suite with the fake CoreCard host and seeded RMS fixtures

Direct equivalents:
- `npm run test:e2e -- e2e/high-risk-regressions.spec.ts --workers=1`
- `npm run test:e2e -- e2e/phase2-finance-and-help-lifecycle.spec.ts --workers=1`
- `npm run test:e2e -- e2e/tender-matrix-contract.spec.ts --workers=1`
- `npm run test:e2e -- e2e/pos-rms-charge.spec.ts e2e/corecard-webhooks.spec.ts e2e/customers-rms-charge.spec.ts e2e/rms-reconciliation.spec.ts e2e/rms-permissions.spec.ts --workers=1`

**API gates (margin-pivot 403):** run **`scripts/seed_e2e_non_admin_staff.sql`** against your DB (non-Admin **`5678`**, optional override **`E2E_NON_ADMIN_CODE`**). CI applies this automatically.

## RMS / CoreCard E2E mode

`npm run dev:e2e` now starts a dedicated fake CoreCard server at **`E2E_CORECARD_BASE`** (default `http://127.0.0.1:43400`) alongside the Rust API and Vite UI. Riverside points its server-only CoreCard broker at that fake host by exporting:

- `RIVERSIDE_CORECARD_BASE_URL`
- `RIVERSIDE_CORECARD_CLIENT_ID`
- `RIVERSIDE_CORECARD_CLIENT_SECRET`
- `RIVERSIDE_CORECARD_WEBHOOK_SECRET`
- `RIVERSIDE_ENABLE_E2E_TEST_SUPPORT`

The fake host lives at [`scripts/fake-corecard-server.mjs`](../../scripts/fake-corecard-server.mjs). It is intentionally isolated from Riverside business logic so sandbox/live host validation can swap in later without changing the Playwright scenarios.

### Covered RMS scenarios

- financed sale success
- financed sale decline
- multi-match metadata persistence
- RMS payment collection success
- RMS payment collection host failure
- webhook ingestion + idempotent replay
- Back Office exception retry
- reconciliation visibility
- POS vs Back Office permission split
- receipt wording for Standard vs RMS 90
- legacy RMS/RMS90 compatibility smoke

### Not covered until sandbox/live validation

- real CoreCard credential exchange against a CoreCard tenant
- live host latency/network edge behavior beyond deterministic fake-host timeout/unavailable responses
- live sandbox ledger settlement timing, host-side reconciliation drift, and real webhook delivery infrastructure

For that real-host pass, use [`docs/CORECARD_SANDBOX_LIVE_VALIDATION_RUNBOOK.md`](../../docs/CORECARD_SANDBOX_LIVE_VALIDATION_RUNBOOK.md) and run `npm run validate:corecard:sandbox` first.
