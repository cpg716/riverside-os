# Production Financial, Operations & Infrastructure Audit - 2026-07-03

## Executive Summary

This audit traced the requested production-readiness areas across the current docs, checkout logic, customer/staff discount behavior, tax/QBO/reporting contracts, commission attribution, staff activity evidence, database probes, Redis job recovery, and scheduled operational jobs.

This was not documentation-only. Confirmed production risks were fixed with targeted changes:

- Customer preset discounts now evaluate from the selected customer profile before couple-linked financial-owner redirection.
- Staff employee discount eligibility is driven by the selected customer profile linked to a staff record, not the signed-in cashier.
- Discount and employee-purchase audit probes now understand selected-profile vs. effective financial-customer ownership.
- Post-recognition salesperson corrections remain allowed for legitimate correction workflows; the commission event snapshot is updated with an attribution audit marker instead of blocking the correction.
- Redis-backed jobs stranded in a processing list after worker failure are recovered and requeued after the processing timeout.
- QBO auto-propose and backup schedule checks now use the configured store timezone instead of the machine-local timezone.
- Stale reporting doc references were corrected to the current booked/fulfilled reporting guide.

Recommendation: CAUTION, not GO, until the live store database findings from the production probes are remediated or explicitly accepted. The code paths audited here are substantially stronger after this pass, but the local audit database still shows operational data risks: negative available stock, two returned commissionable lines missing return adjustment events, and stale backup health.

## Confirmed Findings And Fixes

### P1 - Customer preset discount source was lost after couple financial redirection

Root cause: checkout resolves a couple-linked customer to the primary financial owner before writing the transaction. Customer profile discount validation used the effective financial `customer_id`, so a preset discount on the selected spouse/partner/customer profile could be rejected if the primary profile did not carry that discount.

Risk: staff could correctly select the customer who owns the preset discount, but checkout could reject or misclassify the discount after financial ownership redirection. That also weakens audit evidence for receipts, reports, and later customer review.

Fix implemented:

- Profile discount lookup now uses the selected customer profile first.
- Transaction metadata records `selected_customer_id`, `effective_customer_id`, and `customer_resolution` when couple redirection occurs.
- Discounted line metadata records `profile_discount_customer_id` and `profile_discount_percent`.
- Added Playwright coverage for a secondary couple-linked customer with a preset discount whose transaction posts to the primary financial owner.

### P1 - Employee discount audit source was wrong for selected staff-linked customer profiles

Root cause: employee purchases are determined by the selected customer profile linked to `staff.employee_customer_id`, while the stored transaction customer can be redirected to a primary financial customer.

Risk: valid staff purchases could be falsely flagged, and invalid purchases could be missed if probes only looked at `transactions.customer_id`.

Fix implemented:

- Customer APIs now expose `employee_discount_eligible` for search, browse, and profile payloads.
- POS discount application uses the selected customer's staff-link eligibility.
- Customer lists, POS customer search, and customer profile surfaces show a `Staff` pill for staff-linked customer profiles.
- Production SQL probes and Dev Center probes use `metadata.selected_customer_id` when present before checking staff linkage.

### P1 - Daily Financial Report underreported POS discount totals

Root cause: POS price overrides store final unit price on `transaction_lines.unit_price` and original-vs-overridden evidence in `transaction_lines.size_specs`. The Daily Financial Report summary only used explicit `discount_amount`, which can be zero for POS override flows.

Risk: end-of-day emails could show net sales correctly but understate gross sales and discounts.

Fix implemented:

- Daily Financial Report discount totals now derive from both explicit `discount_amount` and original-vs-overridden line metadata.
- Gross sales reconstruct pre-discount sales from net line price plus discount evidence.
- Financial invariant gates require the metadata-based discount handling.

### P1 - Production probes did not cover discount, employee, and commission drift deeply enough

Root cause: release gates covered many financial invariants, but the read-only production probes did not directly flag several live-row drift cases around discount evidence, discount usage ledgers, customer/staff profile discounts, and commission events.

Risk: imports, repairs, failed retries, or legacy rows could leave financially important drift invisible until manual reconciliation.

Fix implemented:

- Added probes for discounted lines missing override evidence.
- Added probes for sale discount event metadata missing usage rows and usage rows pointing at mismatched line facts.
- Added probes for customer profile discounts without matching customer profile settings.
- Added probes for employee purchases without a linked staff customer profile.
- Added probes for missing, duplicate, and mismatched sale commission events.
- Added a probe for returned commissionable lines missing return adjustment events.
- Required those probes from `npm run check:financial-invariants`.

### P1 - Post-recognition salesperson corrections needed audit-safe event updates, not blocking

Root cause: commission events are generated at fulfillment/recognition, but Riverside OS also needs manager-correctable salesperson attribution when the cashier selected the wrong salesperson during the sale.

Risk: blocking post-recognition corrections would prevent legitimate corrections. Rewriting only transaction lines would create drift between line attribution and commission event snapshots.

Fix implemented:

- Recognized line attribution corrections remain allowed through the existing manager-audited transaction attribution route.
- When a recognized commission event exists, the correction updates the sale commission event snapshot and records attribution correction metadata.
- Staff-facing commission docs now direct wrong-salesperson corrections through attribution correction, while manual commission adjustments remain for explicit unrelated add/subtract entries.

### P1 - Redis processing jobs could be stranded after worker failure

Root cause: Redis dequeue uses `BRPOPLPUSH` to move jobs into a processing list, but there was no recovery pass for jobs left in processing after a worker crash.

Risk: background jobs could remain invisible forever after a process crash, network interruption, or deploy restart.

Fix implemented:

- Dequeue now first scans the processing list for stale jobs.
- Jobs whose `started_at` age exceeds `processing_timeout` are moved back to pending and requeued.
- Missing or malformed processing-list entries are removed instead of blocking the queue.

### P2 - Scheduled QBO and backup checks used machine-local time

Root cause: the QBO auto-propose worker and backup scheduler compared dates/hours using `chrono::Local`, not `reporting.effective_store_timezone()`.

Risk: deployments running outside the store timezone could propose QBO dates or evaluate backup schedule times against the wrong business day/hour.

Fix implemented:

- QBO auto-propose uses store-local date and hour from PostgreSQL.
- Backup schedule checks use store-local `HH:MM`.
- The financial invariant gate now requires these store-time helpers.

### P2 - Stale reporting documentation references could mislead future audit work

Root cause: several docs referenced the removed `REPORTING_BOOKED_AND_RECOGNITION.md` name instead of the current booked/fulfilled reporting guide.

Risk: future code or audit work could follow stale docs in a business-critical revenue-recognition area.

Fix implemented:

- Updated references to `docs/REPORTING_BOOKED_AND_FULFILLED.md`.

## Local Probe Results

The read-only production audit probes were run against the local Docker `riverside_os` database.

Clean in this run:

- Duplicate checkout client IDs.
- Broken payment allocations.
- Over-allocated payments.
- Long-reconciling register sessions.
- Parked sales on closed sessions.
- Order-style checkout stock decrements.
- Tax-exempt taxable lines missing reasons.
- Discounted lines missing override evidence.
- Discount usage ledger mismatches.
- Customer profile discount linkage.
- Employee purchase staff-customer linkage.
- Missing, duplicate, or mismatched sale commission events.
- Unbalanced approved QBO staging payloads.
- QBO staging rows missing business timezone.
- Receiving freight without inventory receipt rows.
- Customer shipping/freight QBO separation.

Still needs operational cleanup or acceptance:

- Negative available stock rows exist in the local audit database.
- Two returned commissionable lines are missing return adjustment events.
- Backup health is stale; last local success shown by the probe was `2026-06-11 05:50:45 UTC`.
- Five QBO staging rows were pending or approved in the local audit database.

## Files Changed

- `AGENTS.md`
- `DEVELOPER.md`
- `README.md`
- `client/e2e/tax-audit-contract.spec.ts`
- `client/src/components/customers/CustomerRelationshipHubDrawer.tsx`
- `client/src/components/customers/CustomersWorkspace.tsx`
- `client/src/components/pos/Cart.tsx`
- `client/src/components/pos/CustomerSelector.tsx`
- `client/src/components/pos/customerProfileTypes.ts`
- `client/src/hooks/useCartActions.ts`
- `client/src/hooks/useCartCheckout.ts`
- `docs/AI_CONTEXT_FOR_ASSISTANTS.md`
- `docs/COMMISSION_AND_SPIFF_OPERATIONS.md`
- `docs/CUSTOMER_HUB_AND_RBAC.md`
- `docs/DAILY_FINANCIAL_REPORT.md`
- `docs/audits/PRODUCTION_FINANCIAL_OPERATIONS_INFRASTRUCTURE_AUDIT_2026-07-03.md`
- `docs/finance/financial-invariants.md`
- `docs/staff/reports-curated-admin.md`
- `docs/staff/reports-curated-manual.md`
- `docs/staff/transactions-back-office.md`
- `scripts/check-financial-invariants.mjs`
- `scripts/production_audit_probes.sql`
- `server/src/api/customers.rs`
- `server/src/api/transactions.rs`
- `server/src/jobs/queue.rs`
- `server/src/launcher.rs`
- `server/src/logic/daily_report.rs`
- `server/src/logic/ops_dev_center.rs`
- `server/src/logic/transaction_checkout.rs`

## Validation Performed

- `cargo fmt` - passed.
- `npm run check:financial-invariants` - passed, 115 gates.
- `npm run check:server` - passed.
- `npm run lint` - passed.
- `npm --prefix client run typecheck` - passed.
- `npm --prefix client run test:e2e -- e2e/tax-audit-contract.spec.ts --workers=1` - passed, 13 tests.
- `npm --prefix client run test:e2e -- e2e/qbo-audit-contract.spec.ts --workers=1 -g "store-local business date wins over UTC date near midnight"` - passed.
- `npm run check:help-impact` - passed; detected impacted files and matching docs/help updates.
- `docker compose exec -T db psql -U postgres -d riverside_os -v ON_ERROR_STOP=1 < scripts/production_audit_probes.sql` - executed; clean for the new discount/customer/employee/commission/QBO integrity probes, with operational data findings listed above.

## Remaining Risks

- Live production signoff still requires running the same SQL probes against the intended production-candidate database and reviewing non-zero rows.
- Redis recovery was compile-validated and statically gated, but not exercised against a live Redis crash/restart scenario in this pass.
- QBO sandbox posting/voiding/retry behavior was not executed end-to-end in this pass; the store-local contract and static gates were validated.
- Hardware-dependent reliability still needs real workstation validation: receipt/tag printing, network interruption, multi-register behavior, backups, and recovery timing.
- Negative stock and missing return commission adjustment rows are data remediation tasks, not fully solved by code changes in this pass.
