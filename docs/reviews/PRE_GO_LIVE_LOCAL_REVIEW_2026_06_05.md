# Pre-Go-Live Local Review — 2026-06-05

Scope: repo-local fixes and validation that can be completed without live store hardware, Windows target-machine access, real Counterpoint SQL, or live/sandbox provider credentials. This file does not claim those external gates are complete.

## Launch-Blocking Fixes Completed Locally

- Split-tender void/refund capacity now preserves original paid capacity for voided transactions and prevents voided transaction headers from being driven negative during refund processing.
- Helcim Payments Operations batch search now supports staff-visible batch/provider/raw-payload lookup instead of returning only unfiltered recent batches.
- Payments Operations E2E setup now seeds the same E2E database used by Playwright web servers.
- Counterpoint settings now exposes required go-live diagnostics inside the guided migration workspace: bridge reachability, Inbound queue, stale-apply recovery, replay-suppression evidence, support diagnostics, deterministic sign-off reconciliation, and optional ROSIE insight after proof.
- Register gift-card load keypad now always applies keypad clicks to the load amount, even when the card-code field is focused for scanner input.
- ROSIE settings now labels the governed intelligence pack explicitly so staff can verify the approved knowledge-source governance surface.

## Validation Passed

- `cargo fmt --all`
- `npm run check:server`
- `npm --prefix client run lint`
- `npm --prefix client run typecheck`
- `npm --prefix client run test:e2e -- e2e/counterpoint-signoff-ui.spec.ts e2e/tax-exempt-and-helcim-branding.spec.ts e2e/payments-operations-ui.spec.ts e2e/register-audit-contract.spec.ts e2e/register-close-reconciliation.spec.ts e2e/offline-recovery-contract.spec.ts e2e/reporting-trust-contract.spec.ts e2e/api-gates.spec.ts e2e/help-center.spec.ts --workers=1` — 66 passed, 2 skipped.
- `npm --prefix client run test:e2e -- e2e/checkout-tender-financial-contract.spec.ts e2e/tax-audit-contract.spec.ts e2e/commission-audit-contract.spec.ts e2e/qbo-audit-contract.spec.ts e2e/qbo-staging.spec.ts e2e/gift-card-redemption-contract.spec.ts e2e/loyalty-redemption-contract.spec.ts e2e/refund-split-tender.spec.ts e2e/exchange-wizard.spec.ts e2e/payments-operations-contract.spec.ts --workers=1` — 64 passed.
- `bash scripts/cargo-server.sh test backups -- --nocapture` — 9 passed.
- `bash scripts/cargo-server.sh test restore_catalog -- --nocapture` — 1 passed.

## Fresh Local Restore Drill

- Evidence: `docs/reviews/evidence/restore_drill_local_2026-06-05.txt`.
- Source database: `riverside_os_e2e`.
- Result: PASS; restored table counts matched source counts for products, variants, transactions, and customers.

## Still External Before Live Trading

These must still be performed on the actual launch environment or with real/sandbox provider accounts:

- Full Windows Main Hub install/update/uninstall rehearsal.
- ROSIE install/update verification on target Windows hardware.
- Full Counterpoint SQL sync against the real source database with final reconciliation and sign-off.
- QBO sandbox post, void, re-stage, and republish proof using Riverside's sandbox company.
- Helcim terminal/card-present workflow using real configured terminals.
- Podium, Shippo, QuickBooks, and email credential workflow tests using real configured accounts.
- Backup restore rehearsal on the Windows Main Hub against a non-production drill database.
- Physical register peripherals: receipt printer, cash drawer, barcode scanner, tag printer, and payment terminal.
