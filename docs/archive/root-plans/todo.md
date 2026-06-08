# ROS Project State

## Completed — April 2026 Hardening Sprint

All items below represent the full audit remediation executed against the codebase.

### Sprint 1 — Security (all critical, previously dev-bypassed)
- [x] **CRIT-1** `middleware/mod.rs` — real admin header auth (x-riverside-staff-code + x-riverside-staff-pin, Admin role enforced)
- [x] **CRIT-2** `auth/pins.rs` — PIN verification runs against stored Argon2 hash (was `let _ = pin;` bypass)
- [x] **CRIT-3** `auth/pins.rs` — `authenticate_admin` enforces `DbStaffRole::Admin` (was accepting any active staff)
- [x] **BUG-3** `orders.rs` — fixed malformed `COALESCE` SQL that crashed all order detail and receipt requests
- [x] **BUG-5** `orders.rs` — `update_order_item` now opens the DB transaction before the UPDATE (was racing)
- [x] **WED-1** `WeddingLookupDrawer.tsx` — Simplified Wedding Party view in POS with status pills
- [x] **WED-2** `orders.rs` + `Cart.tsx` — **Group Wedding Payment System** with multi-member disbursements

### Sprint 2 — Data integrity + database
- [x] **Migration 24** — 9 perf indexes, `session_ordinal BIGSERIAL`, `reserved_stock`, stock floor constraint, refund-queue uniqueness guard
- [x] **Migrations 21–23 applied** — `order_activity_log`, `order_refund_queue`, barcode, gift cards, loyalty
- [x] **INTEGRITY-1** `orders.rs` — Fulfilled status requires **all items picked up AND fully paid** (was pay-only gate)
- [x] **BUG-4** `orders.rs` — `process_refund` guards against driving `amount_paid` negative (`GREATEST` protection)
- [x] **INTEGRITY-2** `orders.rs` — customer name handles first-only or last-only correctly (was showing `None None`)
- [x] **INTEGRITY-3** `orders.rs` — `ON CONFLICT … DO NOTHING` on refund queue prevents duplicates
- [x] **INTEGRITY-4** `orders.rs` — stock decrement checks `rows_affected()`; returns 404 if variant missing
- [x] **Q1 — Special/custom order stock model** implemented:
  - Checkout skips `stock_on_hand` for `special_order` / `custom` fulfillment types
  - `purchase_orders.rs` — PO receipt auto-allocates to `reserved_stock` for open special orders
  - Pickup decrements both `stock_on_hand` and `reserved_stock` for special/custom items
  - `services/inventory.rs` — `ResolvedSkuItem` now returns `stock_on_hand`, `reserved_stock`, `available_stock`
- [x] **PERF-0** `sessions.rs` — `session_ordinal` column replaces correlated subquery in `get_current_session` and `open_session`
- [x] **PERF-0** `insights.rs` — `session_ordinal` column replaces correlated subquery in `register_session_history`
- [x] **AUTH** `sessions.rs` — `begin_reconcile` now requires `cashier_code` auth

### Sprint 3 — Performance + scaling
- [x] **BUG-1** `insights.rs` — N+1 momentum loop (70+ queries per request) → 1 batch query + HashMap pivot
- [x] **UX-3** `insights.rs` — `SalesPivotResponse { rows, truncated }` wrapper; LIMIT 201 cap detection
- [x] **PERF** `settings.rs` — `ReceiptConfig.timezone` IANA field (default `America/New_York`)
- [x] **UX-1** `orders.rs` — ZPL receipt timestamps rendered in local timezone (`chrono-tz`)
- [x] **Cargo.toml** — `chrono-tz = "0.9"`, `tracing = "0.1"`, `tracing-subscriber = "0.3"` added
- [x] **Client** — Native Insights pivot UI retired; **Insights** = **`InsightsShell`** + Metabase iframe; commission ops in **`CommissionPayoutsPanel`** (Staff → Commission payouts)

### Sprint 4 — Observability + polish
- [x] **OBS-1** `main.rs` — **`init_tracing_with_optional_otel`**: `RUST_LOG` **EnvFilter** + optional OTLP + fmt + **`ServerLogRing`** — **`docs/OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md`**
- [x] **OBS-2** All 26 `eprintln!` calls across 14 handler files replaced with structured `tracing::error!` / `tracing::warn!`
- [x] **CODE-4** `orders.rs` — customer timeline notes only emit for milestones (`checkout`, `pickup`, `refund_processed`)
- [x] **CODE-1** `Sidebar.tsx` — `cashierName` and `isRegisterOpen` props hooked to live App state (no hardcoded "Jonathan Roy")
- [x] **CODE-1** `App.tsx` — `cashierName` and `isRegisterOpen` wired into `<Sidebar>` component

### Sprint 5 — Scanning & Physical Inventory
- [x] **SCAN-1** `useScanner.ts` — HID laser detection hook (<80ms timing heuristic)
- [x] **SCAN-2** `CameraScanner.tsx` — PWA-friendly camera scanning via `html5-qrcode`
- [x] **SCAN-3** `scanSounds.ts` — Web Audio API synthesized feedback (success/error tones)
- [x] **INV-1** `physical_inventory.rs` — multi-day session logic, snapshots, and review phases
- [x] **INV-2** `physical_inventory.rs` — **Sales Reconciliation** logic (Count - Sales Since Start)
- [x] **INV-3** `PhysicalInventoryWorkspace.tsx` — 3-phase management UI (Manager -> Counting -> Review)
- [x] **INV-4** `inventory.rs` — `batch-scan` (O(1) write) and `scan-resolve` endpoints
- [x] **REG-1** `ReceivingBay.tsx` — integrated new scanning engine and localforage batching

### Sprint 6 — Database & Reliability
- [x] **DB-1** `backups.rs` — atomic `pg_dump`/`pg_restore` management with custom format
- [x] **DB-2** `backups.rs` — automated 30-day retention and non-blocking cleanup
- [x] **DB-3** `backups.rs` — **Cloud Sync** to S3-compatible storage using OpenDAL
- [x] **DB-4** `settings.rs` — API surface for CRUD backups, restore, download, and DB stats
- [x] **PERF-1** `settings.rs` — `VACUUM ANALYZE` optimization endpoint

### Sprint 7 — Final Polish & Automation
- [x] **Task 1** `SchedulerWorkspace.tsx` — 7-day Week View grid restoration.
- [x] **Task 2** `customers.rs` — Advanced Customer Timeline (Appointments integrated).
- [x] **Task 3** `messaging.rs` — Automated Messaging Engine (SMS/Email pickup triggers).
- [x] **Task 4** `orders.rs` — Technical Polish (Bag Tag ZPL mode + Orders pagination).

### Sprint 8 — Bug reports + documentation alignment (2026-04)
- [x] **BUG-RPT-1** Migrations **101–103** — **`staff_bug_report`**, **`server_log_snapshot`**, **`correlation_id`** / **`dismissed`** / triage fields, retention (**`RIVERSIDE_BUG_REPORT_RETENTION_DAYS`**); **`ServerLogRing`** / **`AppState.server_log_ring`** — **`docs/PLAN_BUG_REPORTS.md`**
- [x] **BUG-RPT-2** `BugReportFlow` + **`client_meta.ros_navigation`** — tab, subsection, POS/wedding/insights mode, **`register_session_id`** for triage — `App.tsx`, **`clientDiagnostics`**
- [x] **DOC-1** README **freshness** paragraph + **`PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md`** tracker; **`PLAN_PODIUM_SMS`** intro/goals reconciled with **99+** CRM; **`ThingsBeforeLaunch`**, **`docs/staff/*`** Settings coverage

---

## Previously completed (pre-April 2026)

- [x] Phase 2.10: Weighted Procurement Engine (WAC, POs, Vendor Hub, freight capitalization).
- [x] Phase 2.11: Final UI/UX polish (Product Master sync, inventory discovery, commission finalize).
- [x] Phase 2.12: Staff & access workspace (Authority engine, PINs, credentialing, commission config).
- [x] Phase 2.13: Advanced Inventory Discovery (vendor filter, by-vendor grouping, commission admin gate, authority audit).
- [x] Phase 2.15: QBO Financial Bridge (mapping matrix, staging engine, ledger signals, authoritative deposits, OAuth, production sync, access-log audit, deposit-release hardening, reconciliation drill-down).
- [x] UX Alignment: Wave 1–3 (surface classification, checkout compression, QBO hierarchy, density tokens, primitive normalization, register lifecycle visibility, keyboard standards, financial confirmation patterns, E2E baselines).
- [x] Register sessions: open/close, X-report, cash adjustments, session HUD, session insights.
- [x] Attribution engine: cashier gate, salesperson attribution, attribution correction modal, access-log entries.
- [x] Gift cards: DB, issue, redeem, loyalty subtype gate.
- [x] Loyalty: program settings, points accrual, monthly eligible view.
