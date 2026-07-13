# Full Production Hardening Review — 2026-07-12

## Executive summary

This review inspected active Riverside OS production paths beyond Playwright/E2E coverage. It covered Register completion, tenders and refunds, wedding group pay, deposits, tax/reporting contracts, inventory and fulfillment, customer/staff workflows, Counterpoint, printing, QBO/Helcim boundaries, database atomicity, backups/restore, security, runtime startup, and Windows/update release guards.

Six active-path defects were fixed with targeted changes. The highest-risk fixes prevent wedding split payments from exceeding a beneficiary's live balance and make audit history atomic with order/financial mutations. Read-only SQL production probes returned zero financial, allocation, session, inventory, tax, discount, commission, QBO, and shipping anomalies in the local E2E database. A real compressed database dump and restore drill also passed.

Paid web checkout is not active. Its confirmed persistence defects are recorded under dormant risks and were intentionally not changed in this pass.

## Active defects fixed

### 1. Wedding split payment could overpay a live beneficiary balance

`server/src/logic/transaction_checkout.rs` selected the newest open member Transaction Record without locking it, did not exclude a zero balance, and did not compare a requested disbursement with the balance re-read inside checkout. Two registers or stale UI data could therefore allocate above the member's balance and produce a negative balance.

The beneficiary row is now selected only when `balance_due > 0`, locked with `FOR UPDATE`, and checked against the live balance before tender sources or payment allocations are consumed. The existing two-cent checkout tolerance is preserved. A focused unit test covers overpayment rejection and exact-balance acceptance.

### 2. Required transaction audit rows were written after commit

`server/src/api/transactions.rs` committed several shipping, refund, exchange, status, financial-date, and order-line changes before inserting `transaction_activity_log`. An audit insert failure could return an error after the business mutation had already succeeded, encouraging a staff retry while leaving incomplete audit evidence.

These activity rows now participate in the same SQL transaction as the mutation. Customer timeline notes remain a separate, non-financial convenience write after commit and cannot turn a completed refund into a false failure.

### 3. Strict production employee pricing silently used a default

`server/src/launcher.rs` silently substituted a 15% employee markup if the setting query failed. In strict production this could allow checkout to continue with an unintended price policy.

Strict production now fails startup when employee pricing policy cannot be loaded. Development/test modes retain the documented warning and default for local resilience.

### 4. Native Counterpoint CSV export could report false success

`client/src/components/settings/CounterpointSyncSettingsPanel.tsx` used a browser anchor for CSV download even in Tauri and immediately showed success. A blocked/missing desktop download could therefore be invisible.

The export now uses the shared desktop-aware file bridge, reports actual failures, and does not show success when the user cancels the save dialog.

### 5. Staff discount-cap failures were swallowed

`client/src/components/staff/StaffDiscountCapsPanel.tsx` swallowed load/save transport failures. Managers could believe a policy change saved when no request completed.

Loads and saves now show explicit error feedback, retain strict role typing, and stop cleanly on invalid values.

### 6. Register product-search outages looked like no results

`client/src/hooks/usePosSearch.ts` caught ordinary product-search transport failures and returned an empty list with console-only evidence. Staff could mistake a Main Hub/API problem for a missing product.

The Register now clears stale results and shows a direct Main Hub connection/retry error. `client/src/assets/docs/pos-manual.md` explains the difference between **Product search failed** and **SKU NOT FOUND**.

### 7. Restore drill rejected the repository's test environment

`scripts/verify-backup-restore-drill.sh` allowed `development`, `test`, and `sandbox` but rejected the actual local `e2e` mode, preventing the normal safe database from proving recovery.

The allowlist now explicitly includes `e2e`; production and unknown modes are still refused. The drill created a compressed dump, restored a temporary database, verified environment mode and migration 124, queried core tables, and cleaned up successfully.

### 8. Deployment guide used obsolete PostgreSQL recovery instructions

`docs/DEPLOYMENT_GUIDE.md` still named PostgreSQL 14 paths and `recovery.conf`, while Riverside's Docker and Windows deployment baseline is PostgreSQL 16.

WAL/replication paths now use version 16 and standby setup uses `primary_conninfo` plus `standby.signal`.

### 9. Current release evidence pointed to an earlier candidate

The live `v0.95.0` tag, release title, and published deployment ZIP identify build `6fdaca58`, but README, release notes, and certification still named the earlier `29ea2c1d` candidate and workflow runs.

The current-release documents now match the annotated tag target, exact-SHA Lint/Playwright runs, Windows/macOS candidate runs, promotion run, publication date, and `RiversideOS-v0.95.0-6fdaca58-Windows-Deployment.zip` asset verified from GitHub.

## Areas reviewed with no new active defect found

- Register tender validation, split tender, rounding, tax parity, payment allocations, session locking, duplicate-submit protection, and checkout idempotency.
- Helcim provider attempts, approval durability, refund retry identity, terminal pending/finality handling, signed webhook intake, redaction, and recovery boundaries.
- QBO minor version 75, OAuth refresh-token replacement, webhook HMAC verification, explicit mapping gates, daily staging, deposit liability, gift-card/store-credit treatment, reversals, and booked/fulfilled recognition.
- Tax, shipping, discount, commission, receiving freight, and QBO reconciliation invariants (115 repository gates passed).
- Inventory receiving exact-once contracts, fulfillment stock movement locking, return/restock handling, and inventory audit records.
- Customer save sparsity, Staff Access/Manager Access contracts, permission-template ownership, and role/default discount-cap contracts.
- Counterpoint import proof, quarantine/exception visibility, bridge entity routing, reset behavior, and packaged updater/build gates.
- Receipt/tag/report routing, fixed LP 2844 EPL target, native Tauri report printing, retry queue routing, and 42-route print manifest.
- Help corpus packaging, generated manual coverage, ROSIE Help search boundaries, and Help-impact enforcement.
- Windows deployment fail-closed checks, migration/bootstrap readiness, rollback/update controls, Node 24 workflow baseline, exact-SHA candidate/promotion gates, and updater asset verification wiring.
- Secret-pattern scan, weekly Cargo/npm audit configuration, and dependency audit results. Cargo reported no unallowed vulnerability; all active npm packages reported no high-severity vulnerability.

## Dormant paid-web-checkout risks (recorded, not changed)

Paid online checkout is inactive, so these findings are deferred until that feature is intentionally activated:

1. `server/src/logic/store_checkout.rs` stores a line's full allocated web tax in `transaction_lines.state_tax`, which is a per-unit field. Quantity greater than one can overstate tax in returns, reports, and recalculation.
2. Storefront coupon discounts are recorded on the checkout session/redemption but not persisted in `transaction_lines.discount_amount`; line-based reports can overstate net sales and later recalculation can lose the coupon effect.
3. Coupon `max_uses` is preview-checked before payment rather than reserved atomically; concurrent paid sessions can exceed a configured usage cap.

Before paid web checkout is enabled, allocate discount and tax to exact cents across persisted units, make recalculation use the same line truth, and define an atomic coupon reservation/finalization contract that cannot strand an already captured payment.

## Remaining external/operator risks

- Live Helcim credentials, both physical terminals, debit refund card-presence behavior, and public webhook delivery were not exercised, per direction. Source contracts match the current documented Helcim flow, but real hardware/provider proof remains required.
- A live QBO sandbox/company was not connected. Source uses Intuit minor version 75 and current OAuth/webhook contracts, but token refresh, account mappings, journal acceptance, void/delete, and webhook delivery still need credentialed sandbox proof.
- Physical Windows installation/update/rollback, Tauri printer drivers, Zebra EPL output, receipt/report printers, scanner focus, and offline recovery still require operator testing on target machines.
- The local database restore drill passed; production backup scheduling, off-machine replication, encryption-key custody, alert delivery, and a production-copy restore drill remain operational responsibilities.
- Root/client npm graphs retain moderate transitive advisories through `exceljs`/`uuid` and the browser polyfill chain. `npm audit` offers only breaking forced changes/downgrades, so no unsafe automatic change was applied. Reassess when upstream packages publish a compatible path.
- Tauri's Linux dependency graph retains Cargo audit warnings for upstream GTK3/unmaintained crates. They are allowlisted upstream/platform warnings, not an observed Windows Riverside vulnerability.

## Validation evidence

- `cargo test --manifest-path server/Cargo.toml transaction_checkout_wedding_disbursement_rejects_live_balance_overpayment --lib` — 1 passed.
- `cargo test --manifest-path server/Cargo.toml api::transactions::tests --lib` — 18 passed.
- `npm run check:server` — passed after the Rust changes.
- `npm --prefix client run typecheck` — passed.
- `npm --prefix client run lint` — passed after the Register search feedback/manual update.
- `npm run check:financial-invariants` — 115 gates passed.
- `npm run check:go-live-blockers` — 75 gates passed.
- `npm run check:print-routing` — 42 routes / 41 call groups passed.
- `npm run check:reports` — 38 reports passed.
- `npm run check:staff-customer-save-contracts` — 9 gates passed.
- `npm run check:deployment-release` and `npm run check:version` — deployment passed; version will be rerun in final validation.
- `npm run check:help-impact` — passed with substantive Help/docs coverage.
- `RIVERSIDE_DB_NAME=riverside_os_e2e bash scripts/verify-backup-restore-drill.sh` — passed; 983,864-byte dump restored through migration `124_operational_recovery_and_telemetry.sql`.
- `cargo audit` — exit 0, no unallowed advisories; 20 allowlisted upstream warnings.
- `npm audit --audit-level=high` in all eight active npm workspaces — exit 0; no high-severity findings.
- `scripts/production_audit_probes.sql` against `riverside_os_e2e` — all financial/data probes zero; backup health is intentionally unset in the local fixture.

No full local Playwright E2E suite was used as the basis of this review. The review relied on source/data tracing, focused tests, database recovery proof, static production gates, and targeted compilation/lint/type validation.
