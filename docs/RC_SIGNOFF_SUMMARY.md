# RC Signoff Summary — Riverside OS v0.2.1

## Branch under signoff

- **`release/rc-gate-blocker-fixes`**

## Validation status

The current RC branch passed the release gate build checks:

- `cargo fmt --check --manifest-path server/Cargo.toml`
- `npm run lint`
- `npm --prefix client run build`
- `npm run pack`

## Release-focused E2E subset status

Previously validated on this RC branch during the release gate pass:

- `high-risk-regressions.spec.ts`
- `phase2-finance-and-help-lifecycle.spec.ts`
- `exchange-wizard.spec.ts`
- `register-close-reconciliation.spec.ts`
- `tender-matrix-contract.spec.ts`

Status:

- **22 passed**
- no unexplained skips in the release-focused subset

## Runtime prerequisites

Local runtime parity for this RC branch expects:

- repo root: **`npm install`**
- client: **`cd client && npm install`**
- local **`server/.env`** present (copy from **`server/.env.example`**)
- local Docker Postgres URL:
  - **`DATABASE_URL=postgresql://postgres:password@localhost:5433/riverside_os`**
- local Metabase automatic sign-in, when expected, requires:
  - **`RIVERSIDE_METABASE_ADMIN_EMAIL`**
  - **`RIVERSIDE_METABASE_ADMIN_PASSWORD`**
  - **`RIVERSIDE_METABASE_STAFF_EMAIL`**
  - **`RIVERSIDE_METABASE_STAFF_PASSWORD`**
- expected local services and ports:
  - Postgres **5433**
  - API **3000**
  - Vite **5173**
  - deterministic E2E API/UI **43300 / 43173**
  - Metabase **3001**
  - Meilisearch **7700** when used
- expected DB/application state:
  - **`store_settings`** row **`id = 1`**
  - seeded E2E staff **`1234`** and **`5678`**
- repo-root packaging expectation:
  - **`npm run pack`** should work directly from the repo root

## Known limitations

- `STRIPE_SECRET_KEY` still does not fail fast in strict production; payment-path failure remains the current detection point.
- Remaining direct **`VITE_API_BASE ?? "http://127.0.0.1:3000"`** callsites are not fully centralized yet.
- Degraded-mode UI warnings for Metabase shared-auth fallback, search fallback, and weather/mock fallback are still deferred.

## Release-readiness statement

**Code RC gate passed; production release still requires operational signoff for envs, services, hardware, and external integrations.**
