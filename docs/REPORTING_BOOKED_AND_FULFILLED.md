# Booked vs Fulfilled reporting

Riverside OS uses two time axes for revenue-style analytics:

| Axis | Meaning | Typical use |
|------|---------|-------------|
| **Booked** | **`transactions.booked_at`** (sale / register day). Includes deposits on **open** transactions. | Register activity, “what we rang,” pipeline. |
| **Fulfilled** | **Pickup / takeaway:** **`transaction_lines.fulfilled_at`**. **Ship:** first qualifying **`shipment_event`** on the order’s **`shipment`** — `label_purchased`, or staff patch to **in_transit** / **delivered** (message patterns match `server/src/logic/shipment.rs` updates). | Sales tax audit, commission **earned** windows, fulfilled sales pivots, native Insights **recognized revenue** reports. |

**Single source in SQL:** `reporting.order_recognition_at(transaction_id, ...)` (baseline migration **106**, active migration layout in `migrations/001` / `007` / `019`). Server-side dynamic SQL must stay aligned with **`server/src/logic/report_basis.rs`** (`ORDER_RECOGNITION_TS_SQL`, `transaction_date_filter_sql`, `transaction_recognition_tax_filter_sql`).

Completed-basis range filters evaluate the recognition expression once against one half-open PostgreSQL timestamp range. Do not expand that predicate into separate null, lower-bound, and upper-bound copies: shipment recognition contains correlated evidence lookups, and repeated evaluation materially slows Daily Sales and other fulfilled-basis reports without changing the answer.

## API (`GET /api/insights/*`)

Back Office -> Reports exposes these curated report tiles through staff-facing names and a local search box. Staff can search by task or question (for example **tax**, **pickup**, **balance**, **slow stock**, or **What sold best last month?**) without changing the underlying basis rules below.

- **`sales-pivot`** — Query **`basis`**: `booked` / `sale` / `booking` vs `fulfilled` / `pickup` / `fulfillment`. Fulfilled uses fulfillment filter + fulfilled date for **`group_by=date`**.
- **`register-day-activity`** — Query **`basis`**: `booked` (default) vs `fulfilled`. Fulfilled timeline uses fulfillment timestamp. Z-close EOD snapshots remain **booked** only. Shipping fees and alteration-service charges stay attached to their Transaction activity and are reported as separate service totals. Alteration charges are included in Daily Sales subtotal, Net Sales, Sales by Hour, sales counts, averages, and applicable commission sales. Shipping remains excluded from all sales and commission metrics. Tender reconciliation still includes payments and refunds collected for those services, including `card_present` refunds in the Credit Card Total. An allocation processed today against an older order appears as **Payment on Order** with the current payment receipt Transaction number, public target reference, applied amount, tender, and remaining balance. The Receipt action uses the payment-event Transaction Record while Detail uses the target order; one physical tender is counted once even when it has several allocations. Every interactive response is calculated in one read-only repeatable-read transaction. Complete View/Print/CSV output (up to 20,000 combined detail rows) and the post-close snapshot hold one database snapshot across all internal pages, verify exact totals and unique row identities, and refuse to expose or persist a partial set. Complete unfiltered booked output also sums activity Net Sales and tax independently and must match its summary to the cent; a mismatch blocks output and snapshot persistence.
- **`register-override-mix`** — Optional **`basis`** + `from` / `to` (flattened): fulfilled = fulfillment window.
- **`nys-tax-audit`** — **Fulfillment only** (no `basis`): lines are included when the order’s fulfillment instant falls in `from` / `to`.
- **`commission-ledger`** — **Unpaid** = open lines with **booked** date in range (pipeline). **Earned in period** = append-only commission events with **fulfillment/recognition** instant in range.
- **`staff-performance`** — Optional **`basis`** for 7-day **revenue_momentum** (booked vs fulfilled).
- **`loyalty-velocity`** — Time-series of loyalty points earned vs. burned (Earn vs Burn).

## Native Insights and Cube (`reporting` schema)

Current reporting schema:

- **`reporting.transactions_core`** / **`reporting.order_lines`** — **`booked_business_date`** / **`order_business_date`** = booked local day; **`recognition_at`** / **`order_recognition_at`** and **`recognition_business_date`** / **`order_recognition_business_date`** = fulfillment.
- **`reporting.daily_order_totals`** — Aggregates by **booked** business date only (unchanged semantics).
- **`reporting.daily_order_totals_fulfilled`** — Aggregates by **fulfillment** business day (cancelled excluded; `recognition_at IS NOT NULL`).
- **`reporting.loyalty_customer_snapshot`** — Per-customer loyalty stats (Earnings vs Redemptions vs Balance).
- **`reporting.loyalty_daily_velocity`** — Daily earn vs burn velocity charts.
- **`reporting.transaction_status_integrity`** — Exception view for mismatches between `transactions.status`, line fulfillment state, and missing fulfillment timestamps. Check this before trusting a disputed receipt, loyalty balance, commission window, QBO staging row, or fulfilled-revenue report.
- **`reporting.counterpoint_import_financial_integrity`** — Read-only comparison of each imported Counterpoint Transaction header, current line total, stored paid amount, allocated tenders, booking timestamps, and audit evidence. Critical differences require source review; the view never chooses a replacement financial value.
- **`reporting.counterpoint_booking_date_repair_manifest`** — Dry-run list of imported current-line and initial-booking timestamps that differ from the retained Counterpoint Transaction booking time. The guarded repair uses this exact manifest and cannot update transaction headers, payments, allocations, or tender amounts.

Counterpoint ticket ingest must explicitly copy `transactions.booked_at` into every imported `transaction_lines.booked_at`. Relying on the line column's `now()` default records the import day as a false booked sale, so a missing or malformed source timestamp is an import exception instead of a current-time fallback. Legacy `backfilled` initial booking events are dated from the parent Transaction in Daily Sales and booked Z-Reports. A migration aligns mismatched event and line timestamps to that source while retaining the former event timestamp in audit metadata; it does not alter totals or tenders. Other mismatches still use the reviewed ROS-only manifest path, which retains before/after evidence and leaves ambiguous or orphaned booking events for manual review. Counterpoint history is not reimported to perform these repairs.

Counterpoint `PS_TKT_HIST_LIN.LIN_TYP` also determines whether a closed-ticket row represents money or lifecycle context. Only `S`, `A`, and `R` rows enter booked sales; `U` rows remain fulfillment history. When a rerun encounters an existing legacy `U`-only Transaction, ROS preserves the Transaction, lines, payments, returns, and fulfillment evidence and adds an audited reporting exclusion to its old initial-booking events. The authoritative order/layaway audit event remains on its original business date, preventing the later lifecycle ticket from becoming a second booked sale.

The Returns, Exchanges & Refunds report separates three ledgers instead of summing the same obligation repeatedly: returned-item rows describe merchandise and tax, refund-queue rows show due and remaining liability, and only successfully posted negative payment rows show value actually refunded. Failed, declined, voided, cancelled, or error provider movements never count as refund paid.

That report is an audited paged response, ordered by activity time and stable row identity. Each page carries the same as-of timestamp, total count, and full-dataset fingerprint. The Reports workspace verifies those values and rejects duplicate or missing rows before rendering charts, a table, print output, or CSV. Ranges above 20,000 rows fail closed and must be narrowed; the former silent 1,000-row cutoff is not used.

Lane-scoped Register Day requests require the query's `register_session_id` to match a valid POS session secret. A staff caller without that matching secret must hold `register.reports`; an open session UUID by itself grants no report access.

**`cube_ro`:** reporting-schema-only login used by Cube Core. Migration 185 revokes **`public.*`** access, grants **`SELECT`** on **`reporting.*`**, and sets a 20-second statement timeout.

## Roadmap / gaps

- Storefront “picked up” vs “shipped” customer-facing states and a dedicated **`transactions.shipped_at`** (or carrier webhook event) would simplify fulfillment recognition; today rely on **Shipments** hub events.
- **`/api/insights/best-sellers`** and **`/dead-stock`** use the same **`basis`** query parameter as **`/api/insights/sales-pivot`** (**`booked`** → **`transactions.booked_at`**; **`fulfilled`** → fulfillment instant per **`transaction_date_filter_sql`** / **`reporting.order_recognition_at`**).
- **`/api/insights/margin-pivot`** (**Admin only**) uses the same **`basis`** and **`group_by`** as **`sales-pivot`**; margin is pre-tax line revenue minus **`SUM(transaction_lines.unit_cost × quantity)`** (cost frozen at checkout).
- **Native Insights** models separate **`booked_items`** and **`recognized_items`** Cube datasets over **`reporting.order_lines`**. Their cost and margin measures are enforced as Riverside Admin-only by the Rust semantic catalog.
- Operational Reports catalog tiles for appointment no-shows, wedding readiness, schedule coverage, customer follow-up, and exception risk use dedicated read-only endpoints. They must not be used as a substitute for the booked vs fulfilled API contracts above.

## Related docs

- **`docs/METABASE_REPORTING.md`** — Phase 2 views, OSS access model.
- **`docs/PRODUCTION_DEPLOYMENT_GO_NO_GO_CHECKLIST.md`** — current launch readiness checklist.
- **`docs/AI_REPORTING_DATA_CATALOG.md`** — Route-level permissions and parameters.
- **`docs/BOOKED_VS_FULFILLED.md`** — Financial theory and ledger flows.
