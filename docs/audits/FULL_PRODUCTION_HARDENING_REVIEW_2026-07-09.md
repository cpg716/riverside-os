# Riverside OS Full Production Hardening Review

Date: 2026-07-09
Source baseline: `main` at `b46b829a` before this review
Mode: AUDIT with safe, targeted fixes for confirmed issues

## 1. Executive Summary

Recommendation: **CAUTION** for production signoff; **GO** for continued source-level and store-environment validation.

The current source passes the repository's financial, go-live, print-routing, Reports, Staff/Customer save, typecheck, lint, server compilation, migration rehearsal, and pre-retag gates. Those gates are useful evidence, but they are not the readiness conclusion. A second pass deliberately ignored the test catalog and traced production boundaries: locks across network calls, authoritative-versus-client money, persisted JSON shapes, provider recovery, reused UI components, socket failure semantics, workstation-local queues, and work performed after the financial commit but before the cashier receives success.

That runtime-first pass confirmed and fixed six defects that ordinary green E2E did not expose:

1. Checkout fetched live weather while holding the register-session row lock and linked Transaction Record locks. With the shared 25-second HTTP timeout and weather retries, a weather outage could stall a sale and competing register work for roughly a minute.
2. Live Helcim card refunds re-acquired register/refund locks before calling the provider, so provider slowness could block Z-close and competing refund work.
3. Checkout accepted tax components and cart totals within a two-cent tolerance, then persisted server-recalculated tax and recomputed the Transaction Record. A checkout could therefore be accepted as paid and emerge with a one- or two-cent balance mismatch.
4. Weather snapshots were persisted as JSON objects, while daily activity reporting only read JSON arrays, silently discarding valid stored context.
5. The reusable receipt modal applied the auto-print preference to historical receipt views and could retrigger when callback/array identities changed, creating unexpected or repeated prints.
6. Browser/PWA Main Hub printing bounded only the TCP connect. A stalled printer write could hang indefinitely, and a flush failure was logged but still returned success, preventing the receipt retry queue from activating.

Six additional deterministic validation/deployment gaps were fixed: migration certification through `124`, the Helcim refund durability fixture, the wedding open-deposit/QBO fixture, the shared register Access PIN helper, two fake-identity POS specs, and stale register-close E2E policy assertions.

A current-provider contract pass then found three source-level integration defects without sending any provider transaction: Riverside's descriptive Helcim idempotency headers exceeded Helcim's 36-character maximum, QBO JournalEntry request ids exceeded Intuit's 50-character maximum, and the QBO webhook route recorded payloads without validating `intuit-signature`. Helcim now receives a deterministic provider-safe UUID while ROS retains its descriptive replay key; QBO uses a deterministic 44-character request id, verifies webhook HMAC-SHA256 over the raw body with the configured Intuit verifier token, requires OAuth state on every callback, and refreshes expired access tokens before all QBO API calls.

The larger source-addressable risks identified after that pass are also implemented:

- Checkout now commits a PostgreSQL outbox record with the financial transaction and acknowledges the cashier without waiting on commission, loyalty, notifications, wedding timeline entries, RMS tasks, staff audit rows, or the configured transaction webhook. The always-on worker retries each idempotent side effect and surfaces exhausted jobs.
- Offline checkout and failed receipt-print recovery are mirrored to the Main Hub, restored across linked registers in the same till shift, and visible store-wide only to staff with `register.reports`.
- Weather now has one canonical `store_daily_weather` row per store-local business date; new checkout/register-close flows no longer duplicate weather into every Transaction Record or session.
- Metrics collection is initialized and API latency plus checkout commit, refund provider, register close, and printer dispatch phases are retained for Ops p50/p95/failure review.
- The daily Meilisearch reindex worker no longer consumes Tokio's immediate interval tick and launches a full catalog scan during server startup; it begins on the first real hourly schedule tick.
- The mailbox adapter moved from the old synchronous `imap` stack to Tokio `async-imap`; active `imap-proto` is now `0.16.7`, and IMAP sync has a 30-second bound.

No permission, inventory, payment, tax, or fulfillment rule was weakened. Money validation is stricter, provider and weather I/O no longer extends critical database locks, printer failures are surfaced, and auto-print is limited to the just-completed sale.

The remaining caution is environment-specific: the intended sandbox/test provider configurations are not available locally, no physical printer or multi-register smoke was possible, and the production Main Hub is unavailable for its backup/restore proof. Those are not safe source-code assumptions.

## 2. Highest-Risk Findings

### P0 - Checkout held financial locks across an unrelated external weather request

Files: `server/src/logic/transaction_checkout.rs`, `server/src/logic/weather.rs`

Checkout opened its database transaction, locked the active register session and linked Transaction Records, consumed the shipping quote, and then called Visual Crossing. The shared HTTP client allows a 25-second request and weather retries twice. This made reporting enrichment capable of delaying transaction completion, register close, and concurrent order payments.

Fix:

- Insert the Transaction Record without waiting for weather.
- After commit, capture one `store_daily_weather` row using the persisted store-local `business_date`.
- Finalize that canonical day row from Visual Crossing after the day closes; keep legacy row snapshots read-only as compatibility fallback.

### P0 - Helcim refund waited on the provider while register/refund rows were locked

File: `server/src/api/transactions.rs`

The refund flow correctly created a durable provider attempt, but then re-opened a transaction, locked the register session and refund queue, and called Helcim before committing. Provider latency could block Z-close and other refund work.

Fix:

- Validate capacity and create the durable pending provider attempt.
- Commit before calling Helcim.
- After approval, begin a new transaction, re-lock, and revalidate the session, refund queue, and card capacity before writing the local ledger.
- Preserve the approved attempt if local reconciliation cannot finish, so retry reuses the provider result instead of refunding twice.

### P0 - Accepted tax tolerance could create a post-save balance mismatch

Files: `server/src/logic/checkout_validate.rs`, `server/src/logic/transaction_checkout.rs`, `client/src/lib/tax.ts`

Tax components used the same two-cent comparison tolerance as catalog price compatibility, and `total_price` could also differ from the calculated cart by two cents. The server later persisted authoritative tax and recalculated totals, so an accepted fully paid request could become an open Transaction Record with a small balance.

Fix:

- Require exact cent parity for state and local tax.
- Build the validated cart sum from server-calculated tax, not the submitted tax fields.
- Require exact cent parity between the submitted cart total and the authoritative sum.
- Match Rust's half-away-from-zero rounding in the client for negative adjustments.

### P1 - Main Hub print dispatch could hang or report false success

File: `server/src/api/hardware.rs`

Network printer connect had a five-second timeout, but `write_all` and `flush` did not. A printer that accepted TCP and then stopped reading could hold the request indefinitely. Flush errors were logged but returned `200 dispatched`, so the local failed-print queue never saw a failure.

Fix:

- Apply the same bounded five-second write/flush contract already used by the Tauri native path.
- Treat write, partial delivery, flush, and timeout failures as request failures.
- Reuse one network dispatch implementation for both Main Hub print endpoints.

### P1 - Receipt auto-print leaked into historical views and could retrigger

Files: `client/src/components/pos/ReceiptSummaryModal.tsx`, `client/src/components/pos/Cart.tsx`

The same receipt component is used after sale completion and from Reports, Orders, Customer history, and Staff Profile. It unconditionally honored the workstation auto-print setting. Default empty arrays and caller callback identity changes could rebuild the print callback and retrigger the effect.

Fix:

- Add an explicit `autoPrintOnOpen` contract.
- Enable it only from the just-completed sale flow.
- Guard by Transaction Record ID so one newly completed sale gets at most one automatic attempt.

### P1 - Weather reporting rejected the shape written by checkout and register close

File: `server/src/logic/register_day_activity.rs`

Writers serialize one daily weather row as an object. The daily activity query required an array and dereferenced element zero, so current writers produced data the report ignored.

Fix:

- Normalize both the current object shape and legacy single-element arrays in the query.
- Continue preferring register-close weather over checkout weather for the same day.

### P1 - Current migration chain was rejected by its own validator

File: `scripts/validate_migration_layout.sh`

The validator's canonical list ended at `100_allow_wedding_import_customer_source.sql`, while the repository contains the reviewed forward migration chain through `123_staff_accounts.sql`. It also rejected the explicit system-data inserts in migrations `113` and `123` because those filenames were missing from the narrow seed-migration allowlist.

Impact:

- `migration-status-docker.sh` stopped before ledger comparison.
- Fresh/local migration certification could fail even when the migrations themselves were valid.
- Deployment and release readiness could not reliably prove the schema expected by the current application.

Fix:

- Added migrations `101` through `123` to the exact canonical list.
- Added only migrations `113` and `123` to the existing explicit system-data allowlist.
- Updated the success label to `active baseline 001-123`.

Validation:

- `./scripts/validate_migration_layout.sh` passes.
- `./scripts/apply-migrations-docker.sh` applied `116`-`123` to the local database and reported no checksum drift.
- `./scripts/migration-status-docker.sh` reports repository/ledger parity after application.

### P1 - Helcim approved-refund replay test did not reach the provider-reuse contract

File: `server/src/api/transactions.rs`

The durability test inserted an open Register #1 session. The current schema correctly enforces one open session per Register #, and the shared test database already had Register #1 open. The test therefore failed on the uniqueness constraint before reaching the forced post-provider local-ledger failure.

Impact:

- The regression intended to prove "one Helcim provider call, then local replay from the approved attempt" could fail for unrelated fixture state.
- A critical double-refund prevention contract was not reliably exercised in a realistic shared database.

Fix:

- The test now selects the first free Register # from the valid `1..=99` range before inserting its session.

Validation:

- The focused database-backed test passes.
- It proves the first attempt calls Helcim once, preserves the approved provider attempt after the forced local failure, retries without a second provider call, creates one local refund payment/allocation, and closes the refund queue.
- The full database-backed Rust suite passes.

### P1 - Wedding open-deposit/QBO regression had stale schema and business-shape assumptions

File: `server/src/logic/transaction_checkout.rs`

The regression inserted customers without the now-required `customer_code`, redeemed a wedding member's earmarked open deposit against a `Takeaway` line, and expected the whole day's QBO deposit line to equal only this test's $200 contribution.

Impact:

- The test could fail before checkout because of current schema constraints.
- Its takeaway fixture contradicted the documented rule that open deposits apply to order/wedding balances, while take-home merchandise requires regular cash-equivalent tender.
- Any other same-day deposit data made the QBO assertion fail even when this transaction's accounting evidence was correct.

Fix:

- Added deterministic unique `TST-*` customer codes to direct SQL fixtures.
- Modeled the redemption as `WeddingOrder`, preserving the takeaway guard.
- Kept aggregate QBO assertions while proving this transaction contributes exactly three preserved source rows totaling $200.

Validation:

- The focused database-backed wedding group-pay/open-deposit test passes.
- The full database-backed Rust suite passes.

### P1 - POS E2E authentication fixtures bypassed the real identity contract

Files: `client/e2e/helpers/openPosRegister.ts`, `client/e2e/operational-rollout-smoke.spec.ts`, `client/e2e/pos-alterations-intake.spec.ts`

The shared register helper swallowed a late access-dialog transition and treated keypad clicks as synchronous. Two specs also mocked a staff identity that did not own the seeded Access PIN. The server correctly rejected that mismatch, while asynchronous four-digit auto-verification could make the helper double-enter a digit or click a Continue button after it was disabled.

Fix:

- Wait for either the cart or access dialog instead of swallowing register mount failure.
- Wait briefly for each keypad click to register, use keyboard input only when the click truly did not advance, and rely on the overlay's canonical four-digit auto-verification rather than clicking Continue again.
- Removed the fake staff auth routes so the affected specs use the seeded roster, real PIN ownership, and real effective permissions.
- Selected the stable seeded `Staff Admin` commission identity in the alteration checkout cases.

Validation:

- The operational balance-payment, alteration intake, order round-trip, and bottom-of-cart dropdown regressions pass in focused runs.
- A complete release E2E run after the fixture corrections passed with 378 passed, 12 explicitly skipped, and 0 failed. This is supporting evidence for the corrected fixtures, not the basis of the runtime findings above.

### P1 - Register-close E2E policy had drifted from the shipped Helcim review contract

File: `client/e2e/register-close-reconciliation.spec.ts`

The spec expected pending and approved-unlinked Helcim attempts to block Z-close. Current application behavior and staff documentation intentionally include those attempts in reconciliation for review without blocking close.

Fix:

- Assert unresolved approved attempts are present with `approved_not_recorded` evidence.
- Prove both pending and approved-unlinked attempts do not block Z-close.
- Release the deliberate pending simulator fixture through the supported staff-authenticated terminal release endpoint so later Helcim scenarios remain isolated.

Validation:

- All seven register-close/reconciliation E2E cases pass, including double-use protection, refund/close serialization, and till-group coordination.
- The corrected register-close cases were included in the earlier complete release run.

### Runtime edge-case matrix

| Runtime condition | Prior behavior | Current disposition |
| --- | --- | --- |
| Weather provider stalls during checkout | Sale held register/order locks while retrying external HTTP | Fixed: capture begins only after commit and uses store-local `business_date` |
| Helcim stalls during card refund | Register/refund rows remained locked | Fixed: durable attempt, unlocked provider call, then reacquire and revalidate |
| Submitted tax is off by one cent | Request could pass tolerance and later recalc to a different balance | Fixed: exact cent parity and server-authoritative sum |
| Historical receipt opened with auto-print enabled | Reused modal could print without an explicit print action | Fixed: historical views are manual; new-sale auto-print is explicit and once-only |
| Printer accepts TCP but stops reading | Main Hub request could hang; flush failure could report success | Fixed: bounded write/flush and failure propagation into retry UX |
| Approved provider refund followed by local DB failure | Durable attempt retained for replay | Existing recovery preserved and regression-tested |
| Checkout commit succeeds but response is lost | Client records an unconfirmed blocker and reuses `checkout_client_id` | Main Hub recovery record is durable and checkout replay remains idempotent |
| Offline checkout reconnects after its register session closed | Replay becomes a manager-visible blocked item instead of being deleted | Main Hub retains the recovery evidence; blind provider-payment replay remains prohibited |
| Backdated transaction crosses UTC/store-local date | Immediate weather used UTC date | Fixed: post-commit capture reads the persisted store-local business date |
| App/process stops before background weather capture | Store-day row may be absent temporarily | Hourly store-day backfill and EOD finalization restore it without touching financial rows |

## 3. Review Coverage by Requested Area

### 1. POS / Register

Reviewed checkout allocation, split tender, cash rounding, check metadata, gift cards, store credit, RMS/staff account payment, deposits, refunds, exchanges, register session uniqueness, register close, receipts, pickup context, failed-payment recovery, and checkout idempotency. The runtime pass removed unrelated weather latency from the locked checkout transaction and moved non-financial post-commit work to a durable idempotent outbox. Financial/go-live gates and Rust checkout/refund tests pass.

### 2. Payments / Helcim

Reviewed terminal/manual-card attempt state, idempotency replay, webhook signature/redaction/idempotency, approved-but-unapplied recovery, provider identifiers, refund capacity, partial refund behavior, settlement imports, and reconciliation visibility against Helcim's current v2.2 documentation. The refund provider call now runs without register/refund database locks and reacquires/revalidates before ledger mutation. All payment requests now translate ROS's potentially long local replay identity into a deterministic 36-character UUID for Helcim's current idempotency-header contract. The approved-refund replay regression remains the durability proof. No provider transaction was sent by request.

### 3. Accounting / QBO / Financial Integrity

The implementation was compared with Intuit's current official Accounting API, OAuth, request-id, minor-version, and webhook contracts. Minor version `75`, OAuth endpoints/scope, sandbox/production base URLs, JournalEntry create/delete shapes, and rolling refresh-token persistence match the current contracts. Confirmed fixes: deterministic JournalEntry request ids are now 44 characters instead of 52; every API call rejects expired access-token reuse and refreshes first; OAuth callbacks fail closed when the stored state is absent; and `/api/auth/qbo/webhook` validates the base64 HMAC-SHA256 `intuit-signature` over the raw body before storing an event. The verifier token is encrypted/configurable in Settings. No QBO transaction or sandbox call was sent by request.

### 4. Tax

Rust tests pass for NY/Erie clothing and footwear under/at the $110 threshold, discount threshold crossing, case-insensitive category handling, service non-taxability, and full-rate other categories. The audit found a boundary defect rather than a rate-table defect: two-cent request tolerance could disagree with the authoritative tax later persisted. Tax components and total cart value now require exact cent parity, and the validated sum is server-derived. Production probes found no tax-exempt taxable rows missing a reason.

### 5. Inventory / Receiving / Cost

Reviewed inventory audit movement coverage, order-style no-decrement behavior, receiving/freight separation, WAC rules, physical inventory review, and Counterpoint stock movement audit. Probes found no unaudited Counterpoint stock rows, no order-style premature decrement, no inactive products with commitments, and no manual movement missing a note.

### 6. Counterpoint Sync / Import / Bridge

Rust coverage passes for preflight blockers, quarantine, SKU recovery, barcode aliases, duplicate handling, run-scoped counts, fidelity checks, open-document behavior, gift card/loyalty reconciliation, provenance, and review-state visibility. Go-live gates pass for thin Bridge routing, authenticated rate-limit bypass, health/staging counts, updater packaging, and retired-workbench exclusion. No runtime change was needed.

### 7. Orders / Open Orders / Deposits

Reviewed order-payment allocation, deferred/deposit tagging, overpayment and customer mismatch guards, transaction-line lifecycle, pickup/receipt context, open deposits, and booked/fulfilled separation. The corrected open-deposit regression now matches the documented order-only contract and proves source preservation. No business rule was relaxed.

### 8. Wedding Manager

Reviewed group pay, member/customer matching, disbursement routing, open-deposit beneficiaries, wedding-order fulfillment classification, and QBO liability evidence. Database-backed group-pay tests pass. Full live party workflow, measurements/fittings, and event-day hardware operation remain manual environment validation.

### 9. Customers / CRM

Staff/Customer save-contract gates pass, including sparse profile patches and server-owned staff defaults. Production probes found no customer-profile discount mismatch or employee purchase without the selected staff-linked customer. Static scans found no raw browser dialogs in customer/POS flows. No change was needed.

### 10. Staff Access / Permissions / Auditability

Reviewed Staff/Manager/Admin authorization gates through go-live, API, QBO, restore, Counterpoint reset, and ROSIE tests. The one-open-session-per-Register constraint remains enforced. No permission bypass or unaudited source fix was introduced.

### 11. Scheduling / Appointments / Alterations

Rust coverage passes for alteration source/status validation and charge-line/customer requirements. Existing release coverage maps staff scheduling, smart alteration scheduling, and wedding-member alteration status. No confirmed source blocker was found; live capacity and calendar workflow breadth remain a manual follow-up.

### 12. Printing / Hardware / Tauri / PWA

The print manifest passes with 42 classified routes and 41 source call groups. Runtime tracing found two issues the route manifest cannot detect: unbounded Main Hub socket writes/false-success flush handling, and receipt auto-print leaking into reused historical views. Both are fixed. Go-live gates still pass for Tauri preview, receipt station routing, fixed LP 2844 EPL routing, Main Hub browser/PWA tag dispatch, Reports printer routing, and visible print actions. Physical receipt/tag/report printer tests were not possible locally.

### 13. Frontend / Staff Usability

Typecheck and lint pass. Receipt auto-print now has an explicit caller contract and once-per-transaction guard. Static scans found no forbidden `alert()`, `confirm()`, or browser `prompt()` calls; the only `.prompt()` is the browser install-prompt API. No client-exposed secret/token/password environment access was found. Staff-facing `Node` terminology was not found in the reviewed UI/manual scope.

### 14. Backend / API / Database

Server compilation, rustfmt, migration parser, clean-database rehearsal, schema ledger/checksum, dump/restore drill, and the database-backed Rust suite pass. Both local sandbox databases are current through migration `124`. Runtime boundary review additionally removed network waits from locked checkout/refund transactions, made printer I/O failure explicit, added durable recovery/outbox state, and initialized metrics collection.

### 15. Reports / Insights / Metabase

The Reports catalog gate passes for 38 curated reports. Financial probes found no QBO/shipping/freight classification drift. Existing report/Metabase focused audits remain applicable; live Metabase shared-auth/embed and production-data report reconciliation were not repeated against store credentials.

### 16. Performance / Stability / Deployment

Go-live and deployment gates pass after the migration validator fix. The highest-impact performance changes are structural: weather and Helcim provider latency no longer extend critical row locks, checkout acknowledgement no longer waits for post-commit fan-out, Main Hub printer writes are bounded, and the daily Meilisearch full-catalog scan no longer starts during server boot. `/api/ops/metrics` now exposes 24-hour phase p50/p95/max/failure summaries plus outbox and recovery counts. During validation, OrbStack stopped once and the disk filled from disposable Rust incremental output; the runtime was restarted and only `target/debug/incremental` was removed. These were local workstation resource interruptions, not application failures.

### 17. Security / Data Protection

Webhook tests pass for signature age, invalid signature rejection, payload redaction, and idempotent processing. Strict-production credential-key tests pass. Static scans found no Vite client secret/token/password/API-key access in application source. Auth/rate-limit tests and sensitive restore/QBO gates pass. Live edge/tunnel and external-provider credential validation remain deployment tasks.

## 4. Files Changed

- Schema/deployment: `migrations/124_operational_recovery_and_telemetry.sql`, `server/src/embedded_migrations.rs`, `scripts/validate_migration_layout.sh`, `scripts/verify-backup-restore-drill.sh`.
- Durable checkout/recovery: `server/src/logic/operational_outbox.rs`, `server/src/api/recovery.rs`, `client/src/lib/serverRecovery.ts`, `client/src/lib/offlineQueue.ts`, `client/src/lib/printRetryQueue.ts`, and the idempotent wedding/task/notification/staff-audit helpers.
- Performance/telemetry: `server/src/logic/operation_metrics.rs`, `server/src/launcher.rs`, `server/src/api/ops.rs`, `server/src/api/mod.rs`, plus checkout/refund/register-close/printing instrumentation.
- Financial/runtime correctness: `server/src/logic/checkout_validate.rs`, `server/src/logic/transaction_checkout.rs`, `server/src/api/transactions.rs`, `server/src/api/hardware.rs`, `server/src/logic/register_day_activity.rs`, `server/src/logic/weather.rs`, `server/src/api/sessions.rs`, and `client/src/lib/tax.ts`.
- Mail dependency: `server/Cargo.toml`, `Cargo.lock`, `server/src/logic/email.rs`.
- Provider API compatibility: `server/src/logic/helcim.rs`, `server/src/api/qbo.rs`, `server/src/jobs/qbo_sync.rs`, `server/src/logic/integration_credentials.rs`, `client/src/components/settings/QuickBooksSettingsPanel.tsx`, provider environment examples, and Helcim/QBO staff/help docs.
- Receipt/staff workflow: `client/src/components/pos/ReceiptSummaryModal.tsx`, `client/src/components/pos/Cart.tsx`, `client/src/lib/posRegisterAuth.ts`, `client/src/assets/docs/pos-manual.md`, and `docs/OFFLINE_OPERATIONAL_PLAYBOOK.md`.
- Test fixtures: `client/src/hooks/useCartCheckout.test.jsx` and the four listed Playwright fixture/spec files from the initial review.
- Canonical evidence: `docs/audits/FULL_PRODUCTION_HARDENING_REVIEW_2026-07-09.md`.

## 5. Validation Run

- `npm run check:financial-invariants` - passed, 115 gates.
- `npm run check:go-live-blockers` - passed, 75 gates.
- `npm run check:print-routing` - passed, 42 routes / 41 source call groups.
- `npm run check:reports` - passed, 38 reports.
- `npm run check:staff-customer-save-contracts` - passed, 9 gates.
- `npm run typecheck` - passed.
- `npm run lint` - passed.
- `npm run check:server` - passed.
- `npm run check:pre-retag` - passed.
- `./scripts/validate_migration_layout.sh` - passed through migration `124`.
- `./scripts/apply-migrations-docker.sh` - Docker sandbox advanced through `124`; no checksum drift.
- `./scripts/apply-migrations-psql.sh` - the database selected by `server/.env` advanced through `124`; no checksum drift.
- Clean throwaway PostgreSQL database - all active migrations `001` through `124` applied and all four new tables were verified.
- `./scripts/verify-backup-restore-drill.sh` - passed against the local development database; 49,121,318-byte compressed dump restored to a throwaway database, migration `124` and core tables verified, throwaway database removed.
- Focused Helcim approved-refund replay Rust test - passed, 1 test.
- Focused wedding open-deposit/group-pay Rust test with explicit database - passed, 1 test.
- `bash scripts/cargo-server.sh test --lib` - passed on the final provider-contract source, 458 tests / 0 failed after migration `124` was applied to the selected test database.
- Focused provider-contract tests - passed for Helcim UUID idempotency normalization, QBO 44-character create/delete request ids, Intuit HMAC webhook verification, and encrypted QBO webhook-verifier credential wiring.
- `cargo tree -p riverside-server -i imap-proto` - active graph is `imap-proto 0.16.7 -> async-imap 0.11.2`; old `imap-proto 0.10.2` is absent.
- Rebuilt sandbox server run with provider features disabled - `/api/live` and `/api/ready` passed, `metrics_worker` reported healthy, five checkout-generated outbox rows drained to `completed`, 0 pending/failed remained, and no startup Meilisearch full-catalog scan ran.
- Focused exact-cent tax validation tests - passed.
- Focused Helcim approved-refund replay after forced local-ledger failure - passed.
- `npm run build` - production client/PWA build passed.
- `scripts/production_audit_probes.sql` against local `riverside_os` - executed; stale local backup health remained external to source remediation.
- `cargo fmt --manifest-path server/Cargo.toml -- --check` - passed.
- `git diff --check` - passed before the audit report was added; rerun in final validation.
- Earlier full `npm run test:e2e:release` after the fixture corrections - 378 passed / 12 explicitly skipped / 0 failed in 25.7 minutes.
- Post-runtime-fix release E2E rerun - intentionally stopped after the user clarified that another full-suite pass should not dominate this audit; 141 passed / 5 skipped, with the active test marked interrupted by cancellation and no product failure observed. It was not restarted.

## 6. Areas Reviewed With No Code Change Needed

No additional runtime fix was justified in inventory mutation logic, Counterpoint ingest, QBO journal approval/accounting logic, permissions, scheduling/alterations, curated report definitions, or client secret handling. Provider boundary changes were limited to confirmed API-contract and authentication defects. Passing gates are recorded as supporting evidence only; they are not treated as proof against unmodeled production failures.

## 7. Remaining Risks

### P1 - Production Main Hub backup/restore proof

The sandbox dump/restore path is proven, but the physical Main Hub is unavailable. Production signoff still requires a current Main Hub backup plus restore drill, verified media/path permissions, free space, and off-machine recovery evidence.

### P2 - Provider-environment confirmation

No provider request was sent, by request. Helcim and QBO endpoint paths, headers, payload shapes, authentication, idempotency, webhook verification, OAuth state, token refresh, sandbox/production routing, and QBO minor version were checked against current official provider documentation. Actual merchant-account permissions, Intuit app callback/webhook registration, saved verifier-token environment, and terminal/account-specific behavior remain deployment configuration rather than source assumptions.

### P1 - Physical hardware and multi-register operation

Run receipt, reprint, LP 2844 EPL tag, Reports printer, offline/misconfigured recovery, drawer close, and two-register concurrency tests on the actual Windows/Tauri store hardware.

### P2 - Other sandbox/test integrations

Counterpoint SQL Server, Shippo, Podium, Constant Contact, Metabase shared auth, PWA update, Windows updater, and Main Hub LAN deployment require environment-specific smoke tests.

### P2 - Production-volume evidence collection

The instrumentation now exists, but real p95/p99 conclusions require production-volume samples, slow-query plans, and physical two-register contention/chaos runs. Source changes should be driven by those measurements rather than synthetic timing alone.

## 8. Prioritized Follow-Up

1. Run physical receipt/tag/report printer and two-register checkout/refund/close contention tests on store hardware.
2. In deployment Settings, save the Intuit Webhook Verifier Token and confirm the Intuit callback/webhook URLs target the public ROS host; no transaction test is required for this source review.
3. Perform and document a production Main Hub backup/restore drill.
4. Collect production-volume Ops metrics and slow-query plans, then optimize only from measured p95/p99 evidence.
5. Complete sandbox/test Counterpoint/Shippo/Podium/Constant Contact/Metabase/updater smoke tests where those environments are available.
