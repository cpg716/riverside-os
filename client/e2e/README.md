# Playwright E2E (`client/e2e/`)

**Coverage map and known gaps:** [`docs/E2E_REGRESSION_MATRIX.md`](../../docs/E2E_REGRESSION_MATRIX.md)

```bash
# Terminal 1 (repo root): start API + Vite UI
npm run dev

# Terminal 2
cd client

# Client-level shortcuts
npm run test:e2e:list
npm run test:e2e:release
npm run test:e2e:visual

# Direct equivalent command
E2E_BASE_URL="http://localhost:5173" E2E_API_BASE="http://127.0.0.1:3000" npx playwright test --workers=1

# High-risk regression API suite (tax/revenue basis/help-admin/session gates)
E2E_BASE_URL="http://localhost:5173" E2E_API_BASE="http://127.0.0.1:3000" npx playwright test e2e/high-risk-regressions.spec.ts --workers=1

# Phase 2 suite (help policy lifecycle + finance-sensitive endpoint contracts)
E2E_BASE_URL="http://localhost:5173" E2E_API_BASE="http://127.0.0.1:3000" npx playwright test e2e/phase2-finance-and-help-lifecycle.spec.ts --workers=1

# Tender matrix deterministic contract suite (payment-intent modes/session-safe behavior)
E2E_BASE_URL="http://localhost:5173" E2E_API_BASE="http://127.0.0.1:3000" npx playwright test e2e/tender-matrix-contract.spec.ts --workers=1
```

Config: [`playwright.config.ts`](../playwright.config.ts). Staff keypad default: **`E2E_BO_STAFF_CODE`** (default **1234**) — see migration **53** / **`docs/STAFF_PERMISSIONS.md`**.

**Important local prerequisite:** Browser-based Playwright specs require a reachable UI at **`E2E_BASE_URL`** (default `http://localhost:5173`). If Vite is not running, tests will fail with `ERR_CONNECTION_REFUSED`. Start the app stack first (`npm run dev` at repo root), then run E2E from `client/`.

**Client script aliases:**
- `npm run test:e2e:list` → list all tests
- `npm run test:e2e:release` → standard release gate (`--workers=1`)
- `npm run test:e2e:visual` → visual suite enabled (`E2E_RUN_VISUAL=1`, `--workers=1`)
- `npm run test:e2e:high-risk` → high-risk API regressions (tax audit, revenue basis aliases, help admin RBAC/payload shape, session route resilience)
- `npm run test:e2e:phase2` → Phase 2 lifecycle coverage (help manual policy persist/revert and finance-sensitive endpoint contract checks)
- `npm run test:e2e:tender` → deterministic tender-matrix contract coverage (manual card, card-reader mode, saved-card invalid-ID handling, credit-negative validation, cancel contract, session-safe behavior)

Direct equivalents:
- `npm run test:e2e -- e2e/high-risk-regressions.spec.ts --workers=1`
- `npm run test:e2e -- e2e/phase2-finance-and-help-lifecycle.spec.ts --workers=1`
- `npm run test:e2e -- e2e/tender-matrix-contract.spec.ts --workers=1`

**API gates (margin-pivot 403):** run **`scripts/seed_e2e_non_admin_staff.sql`** against your DB (non-Admin **`5678`**, optional override **`E2E_NON_ADMIN_CODE`**). CI applies this automatically.
