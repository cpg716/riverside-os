# Riverside OS Fundamentals Review And Fix Pass

Date: 2026-06-21
Scope: all 11 requested fundamentals areas, reviewed through existing contracts, targeted source inspection, and targeted fixes only.
Mode: AUDIT first, then IMPLEMENT for confirmed issues.

## 1. Executive Summary

Recommendation: **GO for continued v0.90.0 validation from this source-side pass.**

This pass covered all 11 requested areas with repo-native validation and targeted inspection. The broad blocking E2E lane passed with **148 passed, 2 skipped, 0 failed**. A supplemental section-coverage lane initially passed with **49 passed, 7 skipped, 0 failed**; after fixing `intelligence-and-finance.spec.ts`, that previously skipped spec passed directly with **7 passed, 0 skipped, 0 failed**. Client lint/typecheck, server check, pre-retag, go-live blockers, financial invariants, print routing, reports catalog, version parity, deployment release, dirty migration rehearsal, rustfmt, help impact, and whitespace checks passed.

Confirmed issue found and fixed:

- The Reports catalog validation gate had drifted from the current `ReportsWorkspace` print implementation and falsely failed even though the runtime code already used `reportPrintSubtitle`.
- `intelligence-and-finance.spec.ts` used the wrong local E2E API fallback and local skip behavior, so it skipped under the repo's deterministic E2E auto-boot path instead of proving its contracts.

Release blockers remaining:

- None found by the local validation run in this pass.

Skipped validation to keep explicit:

- Two Helcim Z-close E2E cases skipped through `startHelcimPurchaseOrSkip` in this local environment.
- No live hardware, live Helcim, live QBO, or physical Windows/Tauri printer smoke was performed.

## 2. Findings And Fixes

### Finding 1

Severity: **medium**

Area: Reports validation, deployment/dev fundamentals

Issue: `npm run check:reports` failed with `ReportsWorkspace print path is not using reportPrintSubtitle`.

Evidence: `client/src/components/reports/ReportsWorkspace.tsx` calls `reportPrintSubtitle(selectedAvailable, ctx)` in the print request. `scripts/check-reports-catalog.mjs` only accepted the stale exact text `reportPrintSubtitle(selected, ctx)`.

Impact: A valid Reports print path could be blocked by a stale readiness gate, creating false release failures.

Exact fix: `scripts/check-reports-catalog.mjs` now verifies the actual print request shape with `subtitle: reportPrintSubtitle(..., ctx)` instead of requiring the old variable name.

Files changed:

- `scripts/check-reports-catalog.mjs`

Tests added/updated:

- No separate test file. The corrected script is the regression gate and now passes through `npm run check:reports`.

Remaining risk:

- The Reports catalog check remains source-text based. A future large Reports print rewrite may need another intentional gate update.

### Finding 2

Severity: **medium**

Area: Intelligence/finance validation, deployment/dev fundamentals

Issue: `intelligence-and-finance.spec.ts` skipped locally under the deterministic E2E auto-boot path instead of running its core contracts.

Evidence: The spec fell back to `http://127.0.0.1:3000`, but Playwright auto-boots the deterministic E2E API on `http://127.0.0.1:43300`. It also used local `test.skip` for unreachable or unauthorized core prerequisites, so the supplemental run reported seven skips.

Impact: Wedding Health, Inventory Brain, Commission Trace, and Helcim payment config secret-hygiene checks were not actually proven by the supplemental pass.

Exact fix: `client/e2e/intelligence-and-finance.spec.ts` now defaults to `http://127.0.0.1:43300`, asserts core API reachability and authorization instead of skipping locally, and reserves skips only for genuinely data-dependent optional rows.

Files changed:

- `client/e2e/intelligence-and-finance.spec.ts`

Tests added/updated:

- Updated the existing spec. Direct validation now passes with 7 tests run.

Remaining risk:

- The direct spec passed against the deterministic local E2E stack. It is still not a live provider smoke for Helcim, QBO, or external intelligence services.

## 3. All 11 Requested Areas Reviewed

### 1. App shell and navigation

Evidence:

- `pos-navigation-contract.spec.ts` passed POS-native section containment and rapid POS rail tab changes.
- `settings-deeplink-contract.spec.ts` passed URL normalization and Settings visibility.
- `backoffice-workspace-nav-smoke.spec.ts` passed phone, tablet, iPad, and desktop workspace navigation.
- `runtime-console-cleanliness.spec.ts` passed POS search, Customers auth-gated browse, and Wedding dashboard month picker stability.

Result: No confirmed blocker found.

### 2. Frontend fundamentals

Evidence:

- `npm run lint` passed.
- `cd client && npm run typecheck` passed.
- `ui-portaling-stacking.spec.ts` passed modal/drawer stacking and interactivity contracts.
- `phase3-failure-states.spec.ts` passed failure-state handling for orders, receiving, operations, pickup, inventory, duplicate review, and notifications.
- Responsive smoke passed through Back Office workspace navigation and targeted mobile/card specs covered by the supplemental lane.

Result: No confirmed blocker found.

### 3. Backend fundamentals

Evidence:

- `npm run check:server` passed.
- `api-gates.spec.ts` passed anonymous auth gates, Helcim permission gates, staff effective-permissions, sessions list-open, insights admin/non-admin boundaries, and Help admin RBAC.
- `phase2-finance-and-help-lifecycle.spec.ts` passed Help policy lifecycle, Help RBAC, finance endpoint contracts, payments/session auth, and non-admin boundaries.

Result: No confirmed blocker found.

### 4. Database/API contracts

Evidence:

- `npm run check:dirty-migration-rehearsal` passed.
- `npm run check:pre-retag` passed migration parser tests.
- `orders-custom-contract.spec.ts`, `orders-detail-handoff.spec.ts`, `inventory-receiving-api.spec.ts`, `qbo-audit-contract.spec.ts`, and `tax-audit-contract.spec.ts` passed API shape and lifecycle contracts.

Result: No confirmed blocker found.

### 5. POS/Register foundation

Evidence:

- `checkout-tender-financial-contract.spec.ts` passed check-number, split tender, cash rounding, mixed tender, and exact-cent non-cash contracts.
- `tender-matrix-contract.spec.ts` passed session-safe tender and RMS internal payment handling.
- `phase2-tender-ui.spec.ts` passed checkout drawer/tender UI smoke.
- `pos-golden.spec.ts` passed scan-to-checkout drawer flow.
- `exchange-wizard.spec.ts` passed return-window manager override and exchange overlay contracts.
- `refund-split-tender.spec.ts` passed void, refund capacity, store credit, gift card refund, partial refund, closed queue, and manager authorization contracts.
- `register-audit-contract.spec.ts` and `register-close-reconciliation.spec.ts` passed register lifecycle, close, parked-sale purge, reconciliation notes, refund-close serialization, historical Register #1 grouping, and pending close coordination. Two Helcim terminal close blockers skipped locally.

Result: No confirmed blocker found.

### 6. Inventory foundation

Evidence:

- `inventory-audit-contract.spec.ts` passed inventory value basis, no-decrement order checkout, exact-once pickup, duplicate PO receipt replay, physical inventory blocking/replay, and restock refund truth.
- `inventory-receiving-api.spec.ts` passed batch scan staging, final receipt exact-once, simultaneous same-PO receive, Product Hub inventory truth, timeline history, and direct invoice exact-once.
- `inventory-receiving-ui.spec.ts` passed Receive Stock, Batch Scan, New PO, Direct Invoice, standard PO submit/stage/receive, and no raw ID entry.
- `inventory-physical-ui.spec.ts` passed physical inventory review/publish.
- `printing-hardening.spec.ts` passed fixed LP 2844 EPL2 inventory tag payload contract.

Result: No confirmed blocker found.

### 7. Wedding Manager foundation

Evidence:

- `orders-custom-contract.spec.ts` passed wedding attachment deposit visibility, wedding group pay completion/routing, special order balance/pickup status, and transaction item review before/after pickup.
- `wedding-readiness-certification.spec.ts` passed readiness risk, vendor delay, partial pickup, balance block, and completion.
- `wedding-readiness-ui.spec.ts` passed readiness search, priority counts, and next actions.
- `wedding-readiness-walkthrough.spec.ts` passed repeatable walkthrough party seeding.
- `runtime-console-cleanliness.spec.ts` passed Wedding dashboard month-end picker stability.

Result: No confirmed blocker found.

### 8. Customer/CRM foundation

Evidence:

- `customers-lifecycle.spec.ts` passed manual address entry, address suggestions, lookup failure resilience, duplicate review timing, and lifecycle filter/hub badge alignment.
- `gift-card-redemption-contract.spec.ts` passed purchased redemption balance reduction, Back Office purchased-card issuance block, donated subtype mismatch error, and insufficient-balance clarity.
- `loyalty-redemption-contract.spec.ts` passed loyalty gift card issuance, manual adjustment history, issuance-only guard, non-loyalty card block, couple-linked primary account resolution, couple link/unlink timeline, and split-profile history behavior.
- `runtime-console-cleanliness.spec.ts` passed Customers browse auth timing.

Result: No confirmed blocker found.

### 9. Accounting/QBO foundation

Evidence:

- `npm run check:financial-invariants` passed 77 gates for receiving cost, supplier freight, customer shipping, gift cards, deposits, QBO proposal behavior, tender contracts, and audit probes.
- `qbo-audit-contract.spec.ts` passed refunds, over-refund prevention, admin approval, COGS reversal, async returns/refunds, liability relief, gift card subtypes, layaways, balanced/deduped/drillable/approval-gated proposals, business dates, and shipment recognition.
- `qbo-staging.spec.ts` passed QBO staging shell language.
- `payments-operations-contract.spec.ts` and `payments-operations-ui.spec.ts` passed Payments Operations read/mutation shapes, reconciliation audit history, guarded linking, deposit workflow, tabs, drawers, empty states, and staff-safe copy.
- `intelligence-and-finance.spec.ts` now passes directly under the deterministic E2E stack for Wedding Health, Inventory Brain, Commission Trace, payment config secret hygiene, detailed wedding health scorecard, Product Intelligence, and commission trace diagnostics.

Result: No confirmed blocker found.

### 10. Printing/hardware foundation

Evidence:

- `npm run check:print-routing` passed.
- `npm run check:go-live-blockers` passed print routing, Tauri preview, direct report printer, receipt/tag station routing, Main Hub station print server, Tag Designer preview failure, LP 2844 EPL route, and report print visibility gates.
- `printing-hardening.spec.ts` passed LP 2844 EPL2 tag payload contract without hardware.
- `settings-deeplink-contract.spec.ts` passed Reports printer installed-printer settings path.

Result: No confirmed blocker found locally. Remaining risk is physical hardware/Tauri smoke was not run.

### 11. Deployment/dev fundamentals

Evidence:

- `npm run check:version` passed.
- `npm run check:deployment-release` passed.
- `npm run check:dirty-migration-rehearsal` passed.
- `cargo fmt --check` from `server/` passed.
- `npm run check:pre-retag` passed, including version parity, deployment release, go-live blockers, print routing, migration rehearsal, rustfmt, migration parser tests, client typecheck, client lint, and `git diff --check`.
- `npm run check:help-impact -- --help-not-needed` passed because the fix is not staff-facing runtime behavior.

Result: One confirmed validation-gate issue fixed. No release blocker remains from this pass.

## 4. Validation Summary

Commands run:

- `npm run check:go-live-blockers` - passed.
- `npm run check:financial-invariants` - passed.
- `npm run check:print-routing` - passed.
- `npm run check:reports` - failed before the fix, passed after the fix.
- `npm run check:help-impact -- --help-not-needed` - passed.
- `npm run lint` - passed.
- `cd client && npm run typecheck` - passed.
- `npm run check:server` - passed.
- `npm run check:version` - passed.
- `npm run check:deployment-release` - passed.
- `npm run check:dirty-migration-rehearsal` - passed.
- `cargo fmt --check` from `server/` - passed.
- `npm run check:pre-retag` - passed.
- `npm --prefix client run test:e2e:blocking` - 148 passed, 2 skipped, 0 failed.
- `npm --prefix client run test:e2e -- e2e/backoffice-workspace-nav-smoke.spec.ts e2e/pos-golden.spec.ts e2e/phase2-tender-ui.spec.ts e2e/refund-split-tender.spec.ts e2e/customers-lifecycle.spec.ts e2e/gift-card-redemption-contract.spec.ts e2e/loyalty-redemption-contract.spec.ts e2e/wedding-readiness-certification.spec.ts e2e/wedding-readiness-walkthrough.spec.ts e2e/wedding-readiness-ui.spec.ts e2e/reports-workspace.spec.ts e2e/printing-hardening.spec.ts e2e/qbo-staging.spec.ts e2e/payments-operations-contract.spec.ts e2e/payments-operations-ui.spec.ts e2e/intelligence-and-finance.spec.ts --workers=1` - initially 49 passed, 7 skipped, 0 failed.
- `npm --prefix client run test:e2e -- e2e/intelligence-and-finance.spec.ts --workers=1` - after the spec fix, 7 passed, 0 skipped, 0 failed.

Skipped or blocked validation:

- Full live hardware validation was not run.
- Live Helcim/QBO provider smoke was not run.

## 5. Remaining Recommended Work

- Run physical desktop/Tauri printer smoke on the store hardware for receipt, tag, and report printers.
- Run live Helcim terminal close-blocker smoke before release signoff.
- Keep `npm run check:reports` in readiness validation when curated Reports or report print behavior changes.
