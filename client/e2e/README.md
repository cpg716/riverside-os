# Playwright E2E (`client/e2e/`)

**Coverage map and known gaps:** [`docs/E2E_REGRESSION_MATRIX.md`](../../docs/E2E_REGRESSION_MATRIX.md)

```bash
cd client
npm run test:e2e -- --list
E2E_BASE_URL="http://localhost:5173" E2E_API_BASE="http://127.0.0.1:3000" npx playwright test --workers=1
```

Config: [`playwright.config.ts`](../playwright.config.ts). Staff keypad default: **`E2E_BO_STAFF_CODE`** (default **1234**) — see migration **53** / **`docs/STAFF_PERMISSIONS.md`**.

**API gates (margin-pivot 403):** run **`scripts/seed_e2e_non_admin_staff.sql`** against your DB (non-Admin **`5678`**, optional override **`E2E_NON_ADMIN_CODE`**). CI applies this automatically.
