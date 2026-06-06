# Physical Inventory Readiness Audit

Date: 2026-06-06
Scope: Riverside OS Physical Inventory lifecycle, scanner/PWA readiness, business-open counting, reporting, QBO/accounting impact, and first-inventory cleanup readiness.

## 1. Executive Summary

Riverside OS has a real Physical Inventory foundation: session creation, scoped snapshots, barcode/SKU scan resolution, aggregate count rows, review materialization for uncounted in-scope variants, atomic publish with row locks, receiving pause while a count is open/reviewing, permission gates, and inventory movement/audit records.

This pass fixed several concrete blockers:

- Physical Inventory UI session creation now sends the selected `scope`.
- Physical Inventory scanner lookup now includes Staff Access headers.
- Count mutations now use the authenticated staff member instead of trusting a client-supplied `staff_id`.
- Count scan source is explicitly validated.
- Scan increments are now recorded in `inventory_count_scan_stream`.
- Review corrections now carry the correcting staff member and refresh the count timestamp.
- Accept variance now writes schema-valid `review_status = 'ok'`.
- Review unresolved-count math no longer treats every non-`approved` row as unresolved.
- Business-open sale handling no longer deducts POS sales twice when the item was counted after the sale.
- Publish movement rows now record effective unit cost for QBO/accounting aggregation.
- Publish audit rows now record live old/new quantities rather than snapshot old quantity.
- Physical Inventory now has a direct `/physical-inventory/scanner` PWA shortcut for PC USB scanners, iPad Bluetooth scanners, and iPad camera scanning.
- Settings -> Station & Network now surfaces the Physical Inventory Scanner URLs alongside the normal Back Office/POS URLs.
- Unknown barcode/SKU scans are captured as discovered scans and must be resolved or ignored before publish.
- Session creation records `baseline_type` as `normal`, `first_inventory`, or `baseline_correction`.
- Publish requires explicit Manager Access signoff and records that approval with the session.
- Publish blocks non-zero movement rows with zero unit cost before accounting impact can be posted.
- Physical Inventory reports now live in the Physical Inventory workspace, with session-scoped variance, scan stream, discovered scan, accounting, and approval rows available for Metabase consumption.
- 200k-SKU sessions are protected by bounded count/review/report UI reads, set-based review sales math, indexes for recent scan feeds and transaction-line joins, and publish logic that skips no-op ledger writes while still evaluating the full session.

Current status: GO for controlled manager-run category or full-store Physical Inventory sessions after targeted validation. CAUTION remains for the first full production live-inventory cutover until store procedure covers non-sale movement timing, offline scanner fallback, and area/location assignment.

## 2. Current Physical Inventory Architecture

Backend:

- Router: `server/src/api/physical_inventory.rs`, mounted at `/api/inventory/physical`.
- Domain logic: `server/src/logic/physical_inventory.rs`.
- Scan resolution: `server/src/api/inventory.rs` -> `resolve_scan_code`.
- Receiving guard: `server/src/api/purchase_orders.rs` blocks PO receiving while a session is `open` or `reviewing`.
- QBO aggregation: `server/src/logic/qbo_journal.rs` includes `inventory_transactions.tx_type = 'physical_inventory'`.
- Inventory history consumers: `server/src/api/products.rs`, `server/src/api/insights.rs`, `server/src/logic/daily_report.rs`.

Database:

- `physical_inventory_sessions`: session header with `open`, `reviewing`, `published`, `cancelled`.
- `physical_inventory_snapshots`: snapshot quantity at session start by variant.
- `physical_inventory_counts`: aggregate count row per `(session_id, variant_id)`.
- `physical_inventory_audit`: session/count/publish audit events.
- `physical_inventory_discovered_items`: session-scoped unknown scan capture and resolution state.
- `physical_inventory_approvals`: Manager Access signoff records.
- `physical_inventory_accounting_impacts`: materialized session value impact rows for workspace reports and Metabase.
- `inventory_count_scan_stream`: raw collaborative scan event table. This was present but not written by the current count endpoint before this pass.
- `inventory_transactions`: live inventory movement ledger; publish writes `physical_inventory` rows.

Frontend:

- Manager/count/review/report UI: `client/src/components/inventory/PhysicalInventoryWorkspace.tsx`.
- Camera scanner component: `client/src/components/inventory/CameraScanner.tsx` using existing `html5-qrcode`.
- HID scanner hook: `client/src/hooks/useScanner.ts`.
- Direct scanner route: `/physical-inventory/scanner`, added as a PWA shortcut.
- Navigation surface: `Inventory -> Physical Inventory` via `InventoryWorkspace.tsx`.
- Scanner setup surface: `Settings -> Station & Network`.
- Help manual: `client/src/assets/docs/inventory-physical-inventory-workspace-manual.md`.

## 3. Files Inspected

- `.cursorrules`
- `README.md`
- `DEVELOPER.md`
- `CHANGELOG.md`
- `package.json`
- `client/package.json`
- `client/vite.config.ts`
- `client/public/manifest.json`
- `client/src/App.tsx`
- `client/src/components/inventory/InventoryWorkspace.tsx`
- `client/src/components/inventory/PhysicalInventoryWorkspace.tsx`
- `client/src/components/inventory/CameraScanner.tsx`
- `client/src/hooks/useScanner.ts`
- `client/src/components/settings/StationNetworkPanel.tsx`
- `client/src/components/settings/RemoteAccessPanel.tsx`
- `client/src/lib/reportsCatalog.ts`
- `client/src/components/reports/ReportsWorkspace.tsx`
- `client/src/assets/docs/inventory-physical-inventory-workspace-manual.md`
- `client/e2e/helpers/inventoryPhysical.ts`
- `client/e2e/inventory-physical-ui.spec.ts`
- `client/e2e/inventory-physical-mobile-cards.spec.ts`
- `client/e2e/inventory-audit-contract.spec.ts`
- `server/src/api/mod.rs`
- `server/src/api/inventory.rs`
- `server/src/api/physical_inventory.rs`
- `server/src/api/products.rs`
- `server/src/api/purchase_orders.rs`
- `server/src/api/insights.rs`
- `server/src/logic/physical_inventory.rs`
- `server/src/logic/qbo_journal.rs`
- `server/src/logic/daily_report.rs`
- `server/src/auth/permissions.rs`
- `migrations/001_core_identity_staff.sql`
- `migrations/002_catalog_inventory.sql`
- `migrations/007_reporting_views.sql`
- `migrations/008_indexes_constraints_triggers.sql`
- `docs/api-audit/inventory-procurement.md`
- `docs/api-audit/accounting-qbo.md`
- `docs/AI_REPORTING_DATA_CATALOG.md`
- `docs/QBO_JOURNAL_TEST_MATRIX.md`
- `docs/PWA_UPDATE_MECHANISM.md`
- `docs/PWA_AND_REGISTER_DEPLOYMENT_TASKS.md`
- `docs/staff/inventory-back-office.md`
- `docs/staff/pilot-receiving-inventory-guide.md`
- `docs/reviews/INVENTORY_RECEIVING_AUDIT_2026_05.md`

## 4. Current Workflow Map

1. Manager opens Inventory -> Physical Inventory.
2. Manager creates a `full` or `category` scoped session and selects the inventory reason.
3. Server enforces one active session and snapshots in-scope variant `stock_on_hand`, optionally excluding reserved or layaway quantity.
4. Staff scan with HID, Bluetooth, or camera scanner inside the Back Office Physical Inventory workspace, the `/physical-inventory/scanner` route, or select a variant manually.
5. Server resolves barcode/vendor UPC/SKU through `/api/inventory/scan-resolve`.
6. Known items increment `physical_inventory_counts`, record `physical_inventory_audit`, and write `inventory_count_scan_stream`.
7. Unknown items are captured in `physical_inventory_discovered_items` and stay pending until resolved or ignored.
8. Staff can save for the day; the session remains `open`.
9. Manager moves session to `reviewing`; server materializes uncounted in-scope variants as count rows with zero quantity.
10. Review shows expected start quantity, counted quantity, sales during the count, final stock, live-stock adjustment variance, unit cost, and accounting impact.
11. Manager can edit a count row in review; server records an audit adjustment.
12. Manager publishes from `reviewing` only after Manager Access signoff; server locks session and variant rows, computes final stock, writes absolute `stock_on_hand`, writes `inventory_transactions`, materializes accounting impact rows, writes audit/approval rows, and marks session `published`.
13. Session reports remain available inside the Physical Inventory workspace.

## 5. Gaps and Blockers Found

Critical blockers fixed in this pass:

- UI could not create sessions reliably because it omitted required `scope`.
- Scanner lookup could fail authorization because `/api/inventory/scan-resolve` requires Staff Access or POS session auth, but the Physical Inventory scanner omitted headers.
- Scan/count rows could miss staff attribution because the backend trusted optional payload `staff_id`.
- Accept variance wrote `confirmed`, which violates the database check constraint allowing only `pending`, `ok`, or `adjusted`.
- Publish inventory movement rows did not write `unit_cost`, causing QBO physical-inventory value to aggregate as zero when the movement had a quantity delta.
- Business-open sales could be deducted twice from counted quantity if the sale happened before the item was scanned.
- Raw scan stream table existed but was not populated by the count endpoint.

Residual limitations:

- No offline queue for scanner submissions; scanner stations are connection-required.
- No scanner-only Access PIN shell separate from the Back Office guard; the direct route still uses the existing authenticated shell.
- No photo capture on discovered items.
- No un-scan/reversal action in the scanner UI; count corrections are still performed in Review.
- No full movement reconciliation for returns, exchanges, damaged/lost, RTV, or manual stock adjustments during an active count. Receiving is blocked, and POS sales are modeled, but other movement classes require store procedure control.
- No location/area assignment workflow, despite inventory location tables existing.
- No draft/planned/paused state split. `save` updates `last_saved_at`; operational pause is procedural.

## 6. Fixes Made

- `client/src/components/inventory/PhysicalInventoryWorkspace.tsx`
  - Sends `scope` during session creation.
  - Sends Staff Access headers for scan resolution.
  - Adds `sales_after_count` to the review response type.
  - Fixes unresolved review count logic to consider only pending variance/uncounted rows.
  - Adds the scanner URL card, baseline reason selector, discovered-scan queue, Manager Access publish flow, publish blockers, and in-workspace reports panel.
  - Caps recent count feed and review worklists so large sessions do not force the browser to render all rows.

- `server/src/api/physical_inventory.rs`
  - Overrides count payload `staff_id` with authenticated staff.
  - Validates `source` as `laser`, `camera`, or `manual`.
  - Passes authenticated staff to review corrections.
  - Uses schema-valid `ok` status for accepted variances.
  - Adds discovered-scan, session report, and Manager Access publish endpoints.
  - Bounds count/review responses and returns full-session summary counts separately from displayed rows.

- `server/src/logic/physical_inventory.rs`
  - Records raw scan increments in `inventory_count_scan_stream`.
  - Uses sales after the last count/correction timestamp to avoid double-deducting POS sales.
  - Computes publish `delta` against current live stock when variants are locked.
  - Writes effective unit cost to `inventory_transactions`.
  - Records live old/new quantities in publish audit rows.
  - Refreshes `last_scanned_at` when a review correction is saved.
  - Blocks publish for unresolved discovered scans and zero-cost movement rows.
  - Materializes accounting impact rows and Manager Access approval rows.
  - Uses set-based sales aggregation for review and skips no-op stock/ledger writes during publish.

- `migrations/071_physical_inventory_readiness_controls.sql`
  - Adds `baseline_type`, discovered-scan capture, approval, and accounting-impact persistence.
  - Adds large-session indexes for recent count feeds and transaction-line joins.

- `client/src/App.tsx`, `client/public/manifest.json`, `client/src/components/settings/StationNetworkPanel.tsx`
  - Adds the `/physical-inventory/scanner` route, PWA shortcut, and setup URLs for PC USB, iPad Bluetooth, and iPad camera scanner stations.

- `client/src/assets/docs/inventory-physical-inventory-workspace-manual.md`
  - Documents corrected sales handling, scanner URLs, discovered scans, Manager Access publish, QBO/accounting cost capture, and workspace reports.

Migrations added: `071_physical_inventory_readiness_controls.sql`.

## 7. Remaining Risks

- Business-open count logic is improved for POS sales, but not complete for every movement type. A robust model needs session movement reconciliation rows or a queryable inventory movement ledger by variant/time/type.
- Scanner submissions are connection-required; no offline queue exists for physical count scans.
- Count corrections still happen in Review; there is no quick un-scan/reversal control in the scanner panel.
- Discovered items have resolution status, but no photo capture.
- Location/area assignment is not part of the active workflow.
- Historical session reporting is now in the Physical Inventory workspace, but print/export controls are not yet specialized for each report table.

## 8. Physical Inventory Reporting Requirements

Physical Inventory workspace reports now present:

- Raw scan stream by staff/device/time.
- Variance summary and detail.
- Shortage/loss and overage/gain.
- Discovered/added items and unresolved discovered items.
- Approval/signoff.
- QBO/accounting impact.
- First-inventory cleanup/baseline correction.

Remaining reporting follow-up:

1. Keep Physical Inventory reports in the Physical Inventory workspace, not the global Reports workspace.
2. Add print/export controls around the workspace report tables when staff need paper binders.
3. Add area/location progress only after the location assignment workflow exists.
4. Use the session report endpoint as the Metabase source for variance, scan stream, discovered scan, accounting, and approval datasets.

## 9. PWA Scanner Readiness Review

Current readiness:

- PWA infrastructure exists through `vite-plugin-pwa`.
- `html5-qrcode` is already installed and used by `CameraScanner`; the upstream project positions it as a lightweight cross-platform web QR/barcode scanner, but it should be treated as an existing dependency to harden rather than a new dependency to add.
- Camera scanner uses environment-facing camera preference and handles permission errors.
- PC USB scanners and iPad/Bluetooth scanners are supported through the existing HID keyboard-style `useScanner` path when the scanner types into ROS and sends Enter.
- Manual lookup exists through `VariantSearchInput`, but not a raw manual barcode entry field.
- General LAN/PWA URLs are visible in Settings -> Station & Network and Remote Access.
- `/physical-inventory/scanner` routes signed-in staff directly to the active Physical Inventory scanner workspace.
- The PWA manifest includes a Physical Inventory Scanner shortcut.
- Settings -> Station & Network shows Physical Inventory Scanner URLs for each detected network address.
- Unknown scans are captured in the workspace instead of being a dead end.

Still limited:

- No offline queue for scanner submissions; current behavior should be treated as connection-required.
- No un-scan/reversal action in the scanner UI.
- No scanner-only Access PIN shell separate from the existing Back Office sign-in guard.

Recommended route:

- Use existing `CameraScanner`, `useScanner`, USB HID scanner, Bluetooth HID scanner, and Physical Inventory APIs.
- Treat scanner stations as online-only until an explicit offline queue is added.
- Add QR rendering later if staff prefer scanning a setup QR instead of copying the URL.

## 10. QBO and Accounting Readiness Review

Current readiness:

- `inventory_transactions` includes `physical_inventory` tx type.
- Daily QBO journal aggregation includes `po_receipt`, `adjustment`, `damaged`, `return_to_vendor`, and `physical_inventory`.
- Mappings use `INV_ASSET`, `INV_SHRINKAGE`, and `REVENUE_INVENTORY_ADJUSTMENT`.
- Missing mappings produce warnings rather than fallback mappings.
- This pass now writes `unit_cost` on physical inventory movement rows.
- Session reports now expose accounting impact rows by session.
- Publish blocks non-zero quantity movement rows with zero unit cost.
- First inventory/import cleanup can be classified separately from normal counts through `baseline_type`.

Remaining gaps:

- Daily journal aggregation is by business date, not by Physical Inventory session, so accounting review must cross-reference movement rows manually.
- No explicit accountant signoff state on the Physical Inventory session.

Recommendation:

- Use the Physical Inventory workspace accounting report for session review and Metabase sourcing.
- Add accountant signoff only if accounting needs a separate approval after Manager Access publish.

## 11. Multi-Day and Business-Open Counting Readiness Review

Ready:

- Sessions can remain `open` across days.
- `save` records a heartbeat without closing the session.
- Active sessions can be resumed.
- Receiving is blocked while a session is `open` or `reviewing`.
- POS sales can continue.
- This pass corrected POS sale handling so sales before a SKU is counted are not deducted again, and publish ledger deltas are based on current live stock.

Not fully ready:

- No planned/paused state.
- No per-area assignment or progress model.
- No full movement reconciliation for returns, exchanges, stock adjustments, damage/loss, RTV, or other non-sale movements during the count.
- No report column for expected at start, movement delta by type, adjusted expected, counted, final variance, and stock adjustment delta.
- No ability to decide whether an item counted before/after a non-sale movement should include that movement.

Recommended data model:

- `physical_inventory_movement_reconciliations`: session, variant, movement type, reference, quantity delta, happened_at, included_in_count boolean.
- Or a materialized review query over a complete inventory movement ledger with movement cutoff per SKU/count event.

## 12. First Inventory and Imported-Data Cleanup Readiness

Ready for controlled first-inventory cleanup sessions with Manager Access, baseline classification, discovered-scan cleanup, and zero-cost movement blocking. Still needs store procedure discipline for duplicate/import data cleanup outside the count engine.

Still missing:

- Duplicate SKU/barcode issue report.
- Orphaned imported record report.
- High-impact variance threshold/signoff.
- Printable cleanup report for accountant/owner review.

Added fields/tables:

- `baseline_type` on `physical_inventory_sessions`: `normal`, `first_inventory`, `baseline_correction`.
- `physical_inventory_discovered_items`.
- `physical_inventory_approvals`.
- `physical_inventory_accounting_impacts`.

## 13. Manual Test Checklist

Manager setup:

- [ ] Open Physical Inventory.
- [ ] Create a new Physical Inventory session.
- [ ] Select normal count, first inventory cleanup, or baseline correction.
- [ ] Select whole store or category scope.
- [ ] Confirm expected inventory baseline/snapshot is captured.
- [ ] Confirm Physical Inventory Scanner URLs are visible in Settings -> Station & Network.
- [ ] Confirm a phone or iPad can open `/physical-inventory/scanner` from the LAN URL.

Phone scanner:

- [ ] Open Riverside on iOS from the LAN URL.
- [ ] Open Riverside on Android from the LAN URL.
- [ ] Save/add to home screen.
- [ ] Log in with Access PIN.
- [ ] Open the Physical Inventory Scanner shortcut or `/physical-inventory/scanner`.
- [ ] Grant camera permission.
- [ ] Scan a known barcode.
- [ ] Manually search/select a SKU.
- [ ] Scan multiple quantities.
- [ ] Confirm recent counts show correctly.
- [ ] Deny camera permission and confirm scanner shows a clear error and manual lookup remains available.
- [ ] Scan from a PC with a USB scanner and confirm ROS treats the HID input as a scan.
- [ ] Scan from an iPad with a Bluetooth scanner and confirm ROS treats the HID input as a scan.

Item not found:

- [ ] Scan an unknown barcode.
- [ ] Confirm the unknown code is captured in Discovered Scans.
- [ ] Resolve the code after updating product barcode/SKU, or mark it ignored.
- [ ] Confirm publish is blocked while the discovered scan is pending.

Business-open counting:

- [ ] Start count with baseline.
- [ ] Sell an item before it is counted.
- [ ] Count the item after the sale and confirm publish does not deduct the sale twice.
- [ ] Count an item before it is sold.
- [ ] Sell it before publish and confirm publish preserves the POS sale.
- [ ] Attempt PO receiving while count is open/reviewing and confirm it is blocked.
- [ ] Process a return/adjustment during count and confirm this remains a documented gap.

Review/approval:

- [ ] Open Physical Inventory review.
- [ ] Confirm counted and uncounted rows are visible.
- [ ] Correct a mistaken count row with a reason.
- [ ] Confirm correction audit is recorded.
- [ ] Confirm unresolved differences are not inflated by zero-variance rows.
- [ ] Confirm zero-cost movement rows block publish.
- [ ] Publish with Manager Access signoff.
- [ ] Confirm live inventory updates to approved quantities.
- [ ] Confirm double publish is blocked by session status.
- [ ] Confirm historical session remains visible.
- [ ] Confirm Physical Inventory Reports show the session variance, scan stream, discovered scan, accounting, and approval rows.

QBO/accounting:

- [ ] Publish a shortage with non-zero cost.
- [ ] Confirm `inventory_transactions.unit_cost` is populated.
- [ ] Propose the daily QBO journal.
- [ ] Confirm shrink/loss and overage/gain mapping warnings behave as expected.
- [ ] Confirm no fallback QBO mapping is used.
- [ ] Confirm zero-cost movement rows are blocked before publish.

Reports/printing:

- [ ] Confirm Physical Inventory reports are in the Physical Inventory workspace, not global Reports.
- [ ] Confirm the report API rows can be used as a Metabase source.
- [ ] Print/export workspace tables manually if paper binder output is needed.

## 14. GO / CAUTION / NO-GO Recommendation

GO for controlled manager-run Physical Inventory sessions.

Reason: the core session/publish engine now includes direct scanner access, discovered item capture/resolution, Physical Inventory workspace reports, Manager Access publish signoff, zero-cost movement blockers, and first-inventory/baseline classification.

CAUTION remains for the first full production live-inventory cutover.

Conditions:

- Use only Manager/Admin staff with `physical_inventory.mutate`.
- Keep receiving paused until publish/cancel.
- Resolve or ignore every discovered scan before publish.
- Correct zero-cost variants before publish when the row has a quantity movement.
- Reconcile QBO through daily staging and the Physical Inventory workspace accounting report.
- Control non-sale movements during active counts because returns, RTV, damage/loss, and manual adjustments are not fully reconciled by the count review.
