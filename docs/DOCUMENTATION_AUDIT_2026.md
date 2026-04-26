# Documentation Audit 2026

Date: 2026-04-25

Scope: Markdown documentation in the Riverside OS repository, with emphasis on whether docs match the actual project structure and where docs can be consolidated for easier search and maintenance.

Status: **Closed cleanup pass with ongoing optional consolidation.** This document is the audit record and remaining-work tracker; the active documentation map now starts at [`docs/README.md`](README.md).

## Executive Summary

The documentation set is broad and useful, but it had accumulated release-era plans, generated component manuals, duplicated workflow guides, and stale references from the v0.2 transaction/fulfillment rename. The cleanup pass separated docs into clearer lanes:

- Canonical engineering docs
- Staff/operator manuals
- Generated in-app help docs
- Release/audit evidence
- Retired or superseded planning docs

The highest-risk correctness issue was stale references to old codepaths and missing docs, especially:

- `server/src/api/orders.rs` and `server/src/logic/order_checkout.rs`, which no longer exist.
- `client/src/components/layout/Header.tsx` and `TopBar.tsx`, while the actual component is `GlobalTopBar.tsx`.
- `docs/STAFF_SCHEDULE_XLSX_IMPORTER.md`, formerly referenced by README/DEVELOPER but absent.

Resolved in this cleanup pass:

- References to the old missing reporting-basis filename were standardized on existing `docs/REPORTING_BOOKED_AND_FULFILLED.md`.
- Active docs were updated from old transaction codepaths (`orders.rs`, `order_checkout.rs`, `order_recalc.rs`, `order_list.rs`) to the current `transactions.rs`, `transaction_checkout.rs`, `transaction_recalc.rs`, and `transaction_list.rs` files.
- New domain front doors were added for Reporting, Transactions, Counterpoint, RMS Charge / CoreCard, Customer Messaging and Notifications, and AI / ROSIE.
- `docs/README.md` was added as the documentation index and authority map.
- `docs/reviews/README.md` was added so historical reviews are clearly dated evidence, not current operating truth.
- `npm run docs:check` was added to guard links, stale renamed references, migration references/ceilings, repo path references, and staff corpus drift.

## Closure Status

| Area | Status |
| --- | --- |
| Main docs index | Done: `docs/README.md` is the canonical search/start page. |
| Reporting consolidation | Done: `docs/REPORTING.md` is the front door; basis docs use `REPORTING_BOOKED_AND_FULFILLED.md`. |
| Transactions consolidation | Done: `docs/TRANSACTIONS.md` is the front door; active code references point at transaction files. |
| Counterpoint consolidation | Done: `docs/COUNTERPOINT.md` is the front door; runbooks remain role-specific. |
| RMS Charge / CoreCard consolidation | Done: `docs/RMS_CHARGE.md` is the front door; architecture/runbook/security/finance docs remain companions. |
| Podium / Shipping / Notifications consolidation | Done: `docs/CUSTOMER_MESSAGING_AND_NOTIFICATIONS.md` is the messaging/notification front door; Shipping remains in `SHIPPING_AND_SHIPMENTS_HUB.md`. |
| AI / ROSIE consolidation | Done: `docs/AI.md` is the front door; retired pre-78 AI docs are marked historical. |
| Staff manual link drift | Done: staff links and corpus manifest pass automated checks. |
| Reviews / audit evidence | Done: `docs/reviews/README.md` defines historical review status. |
| Automated guardrail | Done: `npm run docs:check` passes. |

## Inventory

Observed Markdown surface:

| Area | Count | Approx size |
| --- | ---: | ---: |
| Root Markdown files | 21 | not grouped |
| `docs/` Markdown files | 215 | 1.45 MB |
| `docs/` top-level Markdown files | 118 | included above |
| `docs/staff/` Markdown files | 55 | 248 KB |
| `docs/reviews/` Markdown files | 31 | 102 KB |
| `docs/releases/` Markdown files | 6 | 17 KB |
| `client/src/assets/docs/` generated/help Markdown files | 165 | 375 KB |
| Total Markdown files, excluding common build/vendor folders | 649 | not grouped |

The `client/src/assets/docs/` set is in-app Help content. It should be audited separately from canonical domain/engineering docs because it feeds `client/scripts/generate-help-manifest.mjs`, `client/src/lib/help/help-manifest.generated.ts`, and `server/src/logic/help_corpus_manuals.generated.rs`. Authority is based on role, not authorship: Help manuals define what the app serves, while `docs/*.md`, root runbooks, and `docs/staff/*.md` remain the canonical project/staff truth they should mirror.

## Actual Project Anchors Verified

Current code and script anchors observed:

| Claim area | Actual current state |
| --- | --- |
| App version | `README.md` and `CHANGELOG.md` identify current version as `v0.3.1`. |
| API transaction router | `server/src/api/mod.rs` nests `/api/transactions` to `server/src/api/transactions.rs`. |
| Old orders API file | `server/src/api/orders.rs` is absent. |
| Checkout logic | Actual checkout logic file is `server/src/logic/transaction_checkout.rs`. |
| Old checkout file | `server/src/logic/order_checkout.rs` is absent. |
| Recalc logic | Actual recalc file is `server/src/logic/transaction_recalc.rs`; old `order_recalc.rs` is absent. |
| Top bar component | Actual component is `client/src/components/layout/GlobalTopBar.tsx`. |
| Old header/topbar files | `client/src/components/layout/Header.tsx` and `TopBar.tsx` are absent. |
| Latest migration file | `migrations/167_product_tax_category_override.sql` exists. |
| Root scripts | Root `package.json` includes `lint`, `check:server`, `dev:e2e`, `test:e2e:*`, and `pack`; it does not include a root `typecheck` script. |
| Client scripts | `client/package.json` includes `lint`, `typecheck`, `build`, and Playwright scripts. |

## Stale Or Incorrect References Found

A curated link scan over `docs/`, `README.md`, `DEVELOPER.md`, `AGENTS.md`, and `.cursorrules` originally found 41 broken relative/file links. The current automated check passes.

High-impact stale references:

| Reference | Evidence | Recommended action |
| --- | --- | --- |
| `docs/STAFF_SCHEDULE_XLSX_IMPORTER.md` | Formerly referenced by `README.md` and `DEVELOPER.md`; file does not exist. | First cleanup pass repointed those references to `docs/STAFF_SCHEDULE_AND_CALENDAR.md`. Create a dedicated importer doc only if the importer is still a current workflow. |
| `server/src/api/orders.rs` | Previously referenced in plans and docs; file does not exist. | First cleanup pass updated active docs to `server/src/api/transactions.rs`. Remaining mentions in this audit are historical evidence / stale-path checks. |
| `server/src/logic/order_checkout.rs` | Previously referenced in active docs; file does not exist. | First cleanup pass updated active docs to `server/src/logic/transaction_checkout.rs`. |
| `server/src/logic/order_recalc.rs` | Previously referenced in old audit/plan docs; file does not exist. | First cleanup pass updated active docs to `transaction_recalc.rs`; historical audit notes should be moved or annotated during archive cleanup. |
| `client/src/components/layout/Header.tsx` | Previously referenced across curated docs; file does not exist. | First shell cleanup pass updated active docs to `GlobalTopBar.tsx` or `App.tsx`-owned drawer hosts depending on context. Remaining mentions in this audit are historical evidence / stale-path checks. |
| `client/src/components/layout/TopBar.tsx` | Previously referenced in active docs; file does not exist. | First shell cleanup pass keeps active docs on `GlobalTopBar.tsx`. Remaining mentions in this audit are historical evidence / stale-path checks. |
| `docs/staff/orders-back-office.md` | Previously linked from several staff docs; actual file is `docs/staff/transactions-back-office.md`. | First transactions cleanup pass replaced active links with `transactions-back-office.md`. Remaining mentions in this audit are historical evidence / stale-path checks. |
| `docs/staff/pos-orders.md`, `pos-layaways.md`, `pos-shipping.md` | Previously linked from `docs/staff/README.md`; absent. | Resolved by updating staff index links to current docs / Help content. |

Migration ceiling drift:

- `README.md` previously said latest numbered files extended through `163_dashboard_read_path_indexes.sql`; first cleanup pass updated it to `167_product_tax_category_override.sql`.
- `DEVELOPER.md` previously said current repo ceiling was `158_*.sql`; first cleanup pass updated it to `167_product_tax_category_override.sql`.
- `docs/reviews/PRODUCTION_HARDENING_AUDIT_2026.md` remains a dated historical review snapshot; current migration ceilings are guarded in active docs.
- Actual latest file is `167_product_tax_category_override.sql`.

Terminology drift:

- "Morning Compass" appears 12 times across 10 curated docs, while current v0.3 guidance favors Operations Hub / Action Board.
- `docs/PORTING_NEW_FEATURES_PLAN.md` was explicitly about the legacy UI and has been marked historical / superseded.
- `docs/HARDWARE_MANAGEMENT.md` uses "Hardware Nodes" and "Node Type"; AGENTS guidance says user-facing UI should use "Register #[n]" instead of Node terminology. This may be acceptable only if it is strictly technical/admin-facing; otherwise rename.

## Consolidation Candidates

### 1. Reporting / Recognition

Current spread:

- `docs/REPORTING.md`
- `docs/BOOKED_VS_FULFILLED.md`
- `docs/REPORTING_BOOKED_AND_FULFILLED.md`
- `docs/METABASE_REPORTING.md`
- `docs/DAILY_SALES_REPORTS.md`
- `docs/AI_REPORTING_DATA_CATALOG.md`
- staff reports manuals

Outcome:

- `docs/REPORTING.md` is the reporting front door / index.
- `docs/REPORTING_BOOKED_AND_FULFILLED.md` is the canonical technical basis and recognition doc.
- `BOOKED_VS_FULFILLED.md` remains a short concept primer that links to the canonical doc.
- `AI_REPORTING_DATA_CATALOG.md` remains the route/catalog reference.
- Staff reports docs remain operator procedures.
- Reporting-basis links point at existing `REPORTING_BOOKED_AND_FULFILLED.md`.

### 2. Transactions / Fulfillment / Returns / Layaways / Deposits

Current spread:

- `docs/TRANSACTIONS_AND_WEDDING_ORDERS.md`
- `docs/TRANSACTION_FULFILLMENT_AND_PICKUP.md`
- `docs/TRANSACTION_RECORD_HUB_GUIDE.md`
- `docs/TRANSACTION_RETURNS_EXCHANGES.md`
- `docs/DEPOSIT_OPERATIONS.md`
- `docs/LAYAWAY_OPERATIONS.md`
- `docs/WEDDING_GROUP_PAY_AND_RETURNS.md`
- old planning docs that have now been mechanically repointed to `transactions.rs` / `transaction_checkout.rs`

Outcome:

- `docs/TRANSACTIONS.md` is the transactions front door.
- `TRANSACTIONS_AND_WEDDING_ORDERS.md` remains the canonical domain model.
- `TRANSACTION_RETURNS_EXCHANGES.md`, `DEPOSIT_OPERATIONS.md`, and `LAYAWAY_OPERATIONS.md` remain specialized financial workflow docs.
- Active docs use codepaths under `transactions.rs` / `transaction_checkout.rs`.
- Old implementation plans are marked with status banners where touched; deeper archive moves remain optional.

### 3. Counterpoint / Bridge

Current spread:

- `docs/COUNTERPOINT.md`
- `docs/COUNTERPOINT_SYNC_GUIDE.md`
- `docs/COUNTERPOINT_ONE_TIME_IMPORT.md`
- `docs/COUNTERPOINT_BRIDGE_OPERATOR_MANUAL.md`
- `docs/PLAN_COUNTERPOINT_ROS_SYNC.md`
- root `counterpoint_bridge_final_steps.md`
- bridge README files under multiple bridge folders

Recommendation:

- Keep `docs/COUNTERPOINT.md` as the Counterpoint front door.
- Keep `docs/COUNTERPOINT_SYNC_GUIDE.md` as the engineering guide.
- Keep `docs/COUNTERPOINT_BRIDGE_OPERATOR_MANUAL.md` as the operator runbook.
- Keep `docs/COUNTERPOINT_ONE_TIME_IMPORT.md` as the cutover / validation / retirement runbook.
- `counterpoint_bridge_final_steps.md` has been marked historical and points at `docs/COUNTERPOINT.md` / `docs/COUNTERPOINT_ONE_TIME_IMPORT.md`.
- Move or retire duplicate bridge README folders after confirming which bridge package is authoritative.

### 4. RMS Charge / CoreCard

Current spread:

- `docs/CORECARD_CORECREDIT_FULL_ARCHITECTURE.md`
- `docs/CORECARD_CORECREDIT_PHASE1.md`
- `docs/CORECARD_CORECREDIT_PHASE2.md`
- `docs/CORECARD_CORECREDIT_PHASE3.md`
- `docs/CORECARD_SANDBOX_LIVE_VALIDATION_RUNBOOK.md`
- `docs/operations/rms-corecard-*`
- `docs/security/corecard-data-handling.md`
- `docs/finance/rms-charge-qbo.md`
- staff RMS charge docs

Recommendation:

- Keep `docs/RMS_CHARGE.md` as the RMS Charge / CoreCard front door.
- Keep `docs/CORECARD_CORECREDIT_FULL_ARCHITECTURE.md` as the architecture source of truth.
- Keep `docs/POS_PARKED_SALES_AND_RMS_CHARGES.md` as the parked cart + RMS engineering/product behavior reference.
- Keep operations, validation, security, QBO finance, and staff manuals as role-specific companion docs.
- Keep phase docs as clearly marked historical implementation notes unless they are later collapsed into retired-document summaries.

### 5. Podium / Shipping / Notifications

Current spread:

- `docs/PLAN_PODIUM_SMS_INTEGRATION.md`
- `docs/PLAN_PODIUM_REVIEWS.md`
- `docs/PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md`
- `docs/PODIUM_STOREFRONT_CSP_AND_PRIVACY.md`
- `docs/PLAN_SHIPPO_SHIPPING.md`
- `docs/SHIPPING_AND_SHIPMENTS_HUB.md`
- `docs/PLAN_NOTIFICATION_CENTER.md`
- `docs/NOTIFICATION_GENERATORS_AND_OPS.md`

Recommendation:

- Keep `docs/CUSTOMER_MESSAGING_AND_NOTIFICATIONS.md` as the Podium / reviews / notification-center front door.
- Keep `docs/SHIPPING_AND_SHIPMENTS_HUB.md` as the canonical Shipping / Shippo / Shipments Hub guide.
- Keep `docs/NOTIFICATION_GENERATORS_AND_OPS.md` as the notification operations reference.
- Keep `docs/PLAN_PODIUM_SMS_INTEGRATION.md` and `docs/PLAN_PODIUM_REVIEWS.md` as deep specs / roadmap notes until promoted to non-plan guides.
- Keep `docs/PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md` as a mixed completion tracker for cross-cutting rollout history.

### 6. AI / ROSIE

Current spread:

- `docs/ROSIE_HOST_STACK.md`
- `docs/ROSIE_OPERATING_CONTRACT.md`
- `docs/ROS_GEMMA_WORKER.md`
- `docs/ROS_AI_HELP_CORPUS.md`
- `docs/API_AI.md`
- `docs/AI_CONTEXT_FOR_ASSISTANTS.md`
- `docs/AI_REPORTING_DATA_CATALOG.md`
- `docs/PLAN_LOCAL_LLM_HELP.md`
- `docs/AI_INTEGRATION_OUTLOOK.md`
- root `ROS_AI_INTEGRATION_PLAN.md`

Recommendation:

- Keep `docs/AI.md` as the AI / ROSIE front door.
- Keep `docs/ROSIE_HOST_STACK.md` as runtime/deployment source of truth.
- Keep `docs/ROSIE_OPERATING_CONTRACT.md` as product/safety source of truth.
- Keep `docs/AI_CONTEXT_FOR_ASSISTANTS.md` and `docs/AI_REPORTING_DATA_CATALOG.md` for assistant/reporting routing and report allowlists.
- Keep `ROS_AI_INTEGRATION_PLAN.md`, `docs/API_AI.md`, `docs/ROS_AI_HELP_CORPUS.md`, and `docs/ROS_GEMMA_WORKER.md` as clearly marked historical references for the retired pre-78 stack.

### 7. Staff Manuals

Current state:

- Staff docs are useful and searchable, but link drift is present.
- `docs/staff/README.md` links to missing POS order/layaway/shipping docs.
- First transactions cleanup pass replaced active `orders-back-office.md` staff links with `transactions-back-office.md`.

Recommendation:

- Treat `docs/staff/README.md` as the staff docs index and fix it first.
- Keep staff docs workflow-oriented and plain-language.
- Avoid mixing engineering implementation details into staff docs.
- Document how `client/src/assets/docs/` relates to canonical docs. **Done:** Help manuals are defined as in-app Help artifacts that should mirror canonical domain/staff docs; draft/auto-scaffold manuals are lower-authority until promoted.

## Proposed Target Structure

Recommended structure without forcing a huge migration in one PR:

```text
docs/
  README.md                         # Documentation map and search guide
  engineering/
    architecture.md
    api.md
    database-and-migrations.md
    auth-and-permissions.md
    ui-conventions.md
  domains/
    transactions-and-fulfillment.md
    deposits.md
    returns-exchanges.md
    layaways.md
    reporting-basis-and-recognition.md
    inventory.md
    customers-crm.md
    weddings.md
    shipping.md
  integrations/
    counterpoint.md
    qbo.md
    stripe.md
    podium.md
    metabase.md
    meilisearch.md
    weather.md
    corecard.md
  operations/
    deployment.md
    maintenance.md
    backup-restore.md
    release-qa.md
    observability.md
  staff/
    ...
  releases/
    ...
  reviews/
    ...
  archive/
    retired-summaries.md
```

This can be done gradually with redirects/stub docs so inbound links do not break.

## Recommended Cleanup Sequence

1. Create `docs/README.md` as the canonical documentation index. **Done:** `docs/README.md` now points to the major front doors and explains where planning/history docs fit.
2. Fix broken links in `README.md`, `DEVELOPER.md`, `AGENTS.md`, and `docs/staff/README.md`.
3. Keep reporting docs discoverable through `docs/REPORTING.md`; keep basis links on `REPORTING_BOOKED_AND_FULFILLED.md` unless a future rename is done intentionally with redirects.
4. Keep active docs on `transactions.rs` / `transaction_checkout.rs`; archive or annotate old plans during consolidation.
5. Keep shell docs on `GlobalTopBar.tsx`, `GlobalSearchDrawers.tsx`, and `App.tsx` drawer/provider ownership.
6. Keep planning docs marked as one of: `current plan`, `shipped`, `superseded`, or `archived`. First status pass added banners to the ambiguous plan docs, including Help Center, Notification Center, Shippo/Podium/Notifications, Counterpoint sync, production hardening, rush/due dates, v0.2.0 polish, commission ledger, Metabase dashboard starter, ROS AI retirement, and the historical porting plan.
7. Consolidate one domain cluster at a time, starting with Reporting and Transactions because they are financially sensitive.
8. Add a lightweight docs check script for broken relative links and stale known-renamed paths. **Done:** `npm run docs:check` runs `scripts/verify_docs.py`, checks relative Markdown links, known stale renamed-path strings, migration references/ceilings, repo path references, and staff corpus drift.

## Suggested Docs Check

Added `npm run docs:check` for:

- Broken relative links in `README.md`, `DEVELOPER.md`, `AGENTS.md`, and `docs/**/*.md`.
- Known stale path strings:
  - `server/src/api/orders.rs`
  - `server/src/logic/order_checkout.rs`
  - `server/src/logic/order_recalc.rs`
  - `client/src/components/layout/Header.tsx`
  - `client/src/components/layout/TopBar.tsx`
- Migration ceiling claims that do not match the latest file under `migrations/`.
- Backticked repo path references that point at missing files or folders.

The current checker covers links, stale renamed path strings, exact migration file references, stale current migration ceilings, repo path references, and staff corpus drift.

## Completed Low-Risk Fix List

Completed link/index corrections, not behavioral rewrites:

- `README.md` migration ceiling is on `167_product_tax_category_override.sql`.
- `DEVELOPER.md` migration ceiling is on `167_product_tax_category_override.sql`.
- Shell references use current mount points (`GlobalTopBar.tsx`, `GlobalSearchDrawers.tsx`, and `App.tsx` ownership).
- `docs/staff/README.md` links use current existing staff docs instead of missing `pos-orders.md`, `pos-layaways.md`, and `pos-shipping.md`.
- Staff links use `transactions-back-office.md` instead of missing `orders-back-office.md`.
- Transaction docs are discoverable through `docs/TRANSACTIONS.md`.
- Ambiguous planning docs touched in this pass have explicit status banners so search results distinguish shipped, superseded, deferred, and active roadmap material.
- The canonical reporting filename decision is documented so future docs do not reintroduce the old missing reporting-basis filename.

## Remaining Optional Cleanup

These are intentionally left as follow-up choices, not blockers for the audit pass:

- Move root-level guides such as `INVENTORY_GUIDE.md`, `BACKUP_RESTORE_GUIDE.md`, and `REMOTE_ACCESS_GUIDE.md` under `docs/` with root stubs left behind.
- Decide whether shipped `PLAN_*` docs should be renamed, archived, or left in place with status banners.
- Collapse historical phase docs into `docs/RETIRED_DOCUMENT_SUMMARIES.md` after extracting any still-current details.
- Continue gradual folder normalization toward the proposed `engineering/`, `domains/`, `integrations/`, and `operations/` structure.
- Review technical/admin uses of "Node" in hardware docs and UI copy against the current "Register #[n]" terminology rule.
- Add future checker coverage for selected API route references if docs start drifting on endpoint names.

## Decisions

- Should generated component manuals under `client/src/assets/docs/` be considered part of the canonical docs repo, or treated as Help Center content with separate quality checks? **Resolved:** canonicality depends on role, not authorship. `client/src/assets/docs/*-manual.md` is Help Center content; canonical project/staff truth remains in `docs/*.md`, root runbooks, and `docs/staff/*.md`.
- Should historical audits in `docs/reviews/` remain in the main search path, or move under an archive/release evidence index? **Resolved for now:** keep them in place, add `docs/reviews/README.md`, and mark them as dated evidence that does not override canonical front-door docs.
- Should root-level guides like `INVENTORY_GUIDE.md`, `BACKUP_RESTORE_GUIDE.md`, and `REMOTE_ACCESS_GUIDE.md` move under `docs/` with root stubs left behind? **Deferred:** useful, but not required for correctness now that front-door indexes and checks exist.
- Should old planning docs be renamed from `PLAN_*` once shipped, or moved to archive after the shipped behavior is merged into canonical docs? **Deferred:** keep status banners for now; archive/rename can happen gradually by domain.
