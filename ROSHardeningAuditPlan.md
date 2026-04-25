# Riverside OS Production Hardening Audit Plan

## Current Execution Status — 2026-04-25

This plan has now been executed as an AI/code hardening pass. The current source-of-truth outputs are:

- [`docs/reviews/PRODUCTION_HARDENING_AUDIT_2026.md`](docs/reviews/PRODUCTION_HARDENING_AUDIT_2026.md)
- [`docs/PRODUCTION_HARDENING_FIX_PLAN.md`](docs/PRODUCTION_HARDENING_FIX_PLAN.md)
- [`docs/PRODUCTION_COVERAGE_GAP_MATRIX.md`](docs/PRODUCTION_COVERAGE_GAP_MATRIX.md)
- [`docs/PRODUCTION_DEPLOYMENT_GO_NO_GO_CHECKLIST.md`](docs/PRODUCTION_DEPLOYMENT_GO_NO_GO_CHECKLIST.md)

Code-level P0/P1 audit findings identified in this pass are remediated or converted into explicit release gates. The latest local full release gate reported **181 passed, 7 skipped, 0 failed**.

The remaining blockers are not hidden code-audit checklist items; they are release-environment signoffs:

- Run `scripts/production_audit_probes.sql` against the RC/production database and reconcile or waive every P0/P1 result.
- Complete the Hybrid Tauri host restore drill against a non-production database.
- Complete hardware/register station drills on the intended register host and peripherals.
- Complete QBO/accounting signoff for mappings, sync behavior, and store-local business-date policy.
- Complete owner, store operations, hardware, and backup/restore signoff.

## Summary
Run a serious deployment-readiness audit for the **Hybrid Tauri Host** production path, ending with a ranked **Audit + Fix Plan** and hard go/no-go gates before any retail deployment.

Primary risk focus:
- Register / checkout / tender / register close
- Inventory receiving, stock truth, fulfillment stock movement
- Tax correctness and tax exemption auditability
- Commission attribution, recalculation, and payout finalization
- QuickBooks staging, mappings, journals, sync idempotency
- Backup, restore, offline queue, and recovery after partial failures

Success criteria:
- No known P0/P1 financial, tax, inventory, auth, QBO, or recovery defects remain unplanned.
- Every high-risk workflow has code evidence, automated test evidence, and manual operational signoff criteria.
- Deployment remains blocked until lint, typecheck, build, server check, E2E release gates, backup restore drill, and hardware station checks pass.

## Audit Workstreams
- **Financial Truth Audit**
  - Review checkout transaction boundaries in `server/src/logic/transaction_checkout.rs`.
  - Verify payment allocation rows, split tenders, gift cards, RMS charges, deposits, refunds, exchanges, rounding adjustments, and existing-order payments cannot double-post or lose ledger traceability.
  - Confirm `checkout_client_id` idempotency works across retry, offline replay, race, and host failure scenarios.
  - Check reports distinguish booked sale activity from fulfilled revenue recognition.

- **Register Reliability Audit**
  - Inspect register open/attach/close flows, Z reports, cash discrepancy handling, session grouping, shift handoff, and offline pending-sync close blockers.
  - POS UI tests must remain part of the release gate. The prior quarantine has been removed after adding deterministic readiness contracts.
  - Verify cashier identity always uses authenticated staff identity first, with manager overrides logged.

- **Inventory Truth Audit**
  - Verify stock changes for takeaway, special order, custom order, layaway, PO receipt, pickup, return/restock, suit swap, and physical inventory publish.
  - Confirm checkout does not decrement `stock_on_hand` for order-style fulfillment until pickup/fulfillment.
  - Review receiving exact-once behavior, duplicate scan/retry behavior, negative available stock signals, and inventory transaction audit trails.

- **Tax Audit**
  - Verify line-level NYS/Erie tax calculations, clothing/footwear under-$110 exemption, case-insensitive category handling, discounts crossing the threshold, tax-exempt reason enforcement, returns tax reversal, and QBO tax liability mapping.
  - Confirm client tax presentation never becomes the source of financial truth.

- **Commission Audit**
  - Verify commission timing follows fulfillment/recognition, not booking, except immediate takeaway where fulfillment is immediate.
  - Review specificity order: variant, product, category, category default, staff base.
  - Confirm finalized payouts cannot be silently rewritten by salesperson changes, staff rate history, returns, or fulfillment edits.
  - Validate internal SPIFF/combo lines stay off customer-facing receipts.

- **QuickBooks Audit**
  - Review staging-first QBO flow, account mappings, fallback warnings, journal balance checks, dedupe keys, sync logs, and retry behavior.
  - Verify journals for revenue, COGS, inventory assets, taxes, deposits, gift cards, loyalty, returns, shipping, RMS charges, merchant fees, and rounding.
  - Confirm store-local business-date cutoff behavior is documented and reconciled against QBO company timezone expectations.

- **Recovery Audit**
  - Verify local backup status, cloud backup health, restore procedure, migration ledger consistency, hybrid host restart behavior, and offline queue replay.
  - Require a real restore drill into a non-production database before deployment signoff.
  - Confirm no operational path depends on clearing browser storage or undocumented manual DB edits.

## Execution Steps
1. **Baseline Evidence Capture**
   - Record `git status`, migration status, current version, current branch, and environment topology.
   - Review `.cursorrules`, `README.md`, `DEVELOPER.md`, `CHANGELOG.md`, release docs, and domain docs for checkout, deposits, returns, revenue, staff permissions, QBO, inventory, and backups.

2. **Static Code Audit**
   - Trace high-risk flows from UI request to API handler to logic/service to DB writes.
   - Produce a finding list with severity:
     - P0: can corrupt money, tax, stock, auth, or recovery.
     - P1: can block retail operations or create unreconciled state.
     - P2: weak auditability, brittle UX, missing coverage, or recoverability gaps.
     - P3: polish, documentation, or maintainability improvements.

3. **Data Integrity Audit**
   - Inspect migrations and schema invariants for financial tables, stock tables, commission tables, QBO tables, backups, and register sessions.
   - Add SQL audit probes to the fix plan where gaps exist, but do not mutate production data during audit.
   - Validate duplicate migration prefix handling compares full filenames, not only numeric ceilings.

4. **Automated Verification Plan**
   - Required gates:
     - `cargo fmt --check --manifest-path server/Cargo.toml`
     - `npm run check:server`
     - `npm run lint`
     - `npm --prefix client run build`
     - `npm run test:e2e:release`
     - `npm run test:e2e:high-risk`
     - `npm run test:e2e:phase2`
     - `npm run test:e2e:tender`
   - Add or repair tests for every P0/P1 issue before release approval.
   - Keep formerly quarantined POS tests in the release gate and maintain the explicit readiness contracts that stabilized them.

5. **Manual Retail Drill Plan**
   - On a hybrid Tauri host, run live-station rehearsals for:
     - Open Register #1, attach satellite registers, shift handoff, close with exact cash, close with discrepancy.
     - Scan sale, custom order, special order, wedding order, layaway, gift card, loyalty, check tender, card tender, cash rounding, refund, exchange.
     - Receive PO, duplicate receive retry, pickup fulfillment, return/restock, physical count publish.
     - QBO propose, approve, sync, retry failed sync, inspect journal balance.
     - Kill/restart host mid-operation, replay offline checkout, restore backup to clean DB.

## Test Scenarios
Minimum release-blocking scenarios:
- Duplicate checkout replay with same `checkout_client_id` creates exactly one transaction.
- Split tender allocates correctly across current sale and existing transaction balance.
- Check tender requires check number.
- Cash rounding records balanced ledger impact.
- Tax-exempt checkout requires reason and preserves original tax audit trace.
- Clothing item at `$109.99` uses local-only tax; `$110.00` uses full state + local tax.
- Discount crossing `$110` recalculates tax at line level.
- Special/custom/wedding checkout does not decrement `stock_on_hand`; pickup does.
- PO receipt duplicate retry does not double-increment stock.
- Return with restock updates refund, stock, reporting, QBO, and receipt consistently.
- Commission payout follows fulfillment date and finalized payouts cannot be rewritten.
- QBO proposed journal is balanced and deduped before sync.
- Register cannot close while offline queued checkout exists.
- Backup restore produces bootable app with migration ledger intact.

## Deliverables
- `Production Deep Audit Report`
  - Findings ranked P0-P3 with file/code references, business impact, reproduction evidence, and recommended fix.
- `Fix Plan`
  - Ordered remediation batches, each with exact target area, risk, tests, and release gate.
- `Deployment Go/No-Go Checklist`
  - Hybrid Tauri host environment, hardware, Stripe, QBO, backups, restore drill, E2E, and human operational signoff.
- `Coverage Gap Matrix`
  - Existing automated coverage, remaining skips, missing tests, and required additions before retail use.

## Public Interfaces / Types
No public API, database schema, or UI contract changes are assumed for the audit itself.

If findings require changes, the fix plan must explicitly call out:
- REST endpoint contract changes.
- Migration requirements.
- QBO journal shape or mapping changes.
- Register/session payload changes.
- Staff-facing workflow or documentation updates.

## Assumptions
- Production target is **Hybrid Tauri Host**.
- Primary endpoint is **Audit + Fix Plan**, not immediate implementation.
- Existing production rules remain authoritative: server truth for money/tax/stock, `rust_decimal` for money, fulfillment-based revenue and commission recognition, staging-first QBO, and no auth/PIN weakening.
- Deployment is blocked by any unresolved P0/P1 finding.
