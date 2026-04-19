# Release Operational Signoff — Riverside OS v0.2.1

This checklist is for the final human go/no-go review after the code RC gate has passed.

## Approval

- Operational signoff status: **APPROVED**
- Approved by: **Christopher Garcia**
- Date: **2026-04-19**
- Approved scope:
  - Environment verified
  - Core workflows verified
  - Reporting verified
  - External dependencies verified
  - Backup/recovery verified

## Code signoff already completed

- RC branch under signoff: **`release/rc-gate-blocker-fixes`**
- Code RC gate status: **passed**
- Build validation completed:
  - **`cargo fmt --check --manifest-path server/Cargo.toml`**
  - **`npm run lint`**
  - **`npm --prefix client run build`**
  - **`npm run pack`**
- Release-focused E2E subset previously passed:
  - **`high-risk-regressions.spec.ts`**
  - **`phase2-finance-and-help-lifecycle.spec.ts`**
  - **`exchange-wizard.spec.ts`**
  - **`register-close-reconciliation.spec.ts`**
  - **`tender-matrix-contract.spec.ts`**

## Human operational checks completed before shipping

### Production environment and deployment

- Confirm production **`RIVERSIDE_STRICT_PRODUCTION=true`** is set for any browser-facing deployment.
- Confirm **`RIVERSIDE_CORS_ORIGINS`** is set to the exact production origins.
- Confirm **`RIVERSIDE_STORE_CUSTOMER_JWT_SECRET`** is set to a strong production value.
- Confirm **`FRONTEND_DIST`** points to the correct built frontend directory on the deployed host.
- Confirm any required **`VITE_API_BASE`** value matches the actual UI/API topology when they are not same-origin.

### Runtime services and access

- Confirm PostgreSQL, API, frontend, and any required sidecars are running at the intended production endpoints.
- Confirm Metabase / Insights access is working for the roles that use it, if Insights is part of this deployment.
- Confirm Tailscale / remote access is verified if the store depends on it.
- Confirm Meilisearch is available and indexed if search-backed workflows are expected.

### Payments, hardware, and store operations

- Confirm hardware/station commissioning is complete for each live terminal.
- Confirm receipt printer, scanner, and card reader behavior on the live stations.
- Confirm Stripe and any external payment conditions are acknowledged and verified for the actual deployment topology.
- Confirm any bridge/sync services required by the store are enabled and healthy.

### Recovery and audit readiness

- Confirm backup jobs are enabled and a restore drill has been verified on a non-production target.
- Confirm operator access, manager approval flows, and required audit-sensitive credentials are in place.

## Release tag reminder

- This operational checklist is complete.
- The release tag may be cut for **v0.2.1**.
