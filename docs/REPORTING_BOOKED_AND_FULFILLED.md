# Booked vs Fulfilled reporting

Riverside OS uses two time axes for revenue-style analytics:

| Axis | Meaning | Typical use |
|------|---------|-------------|
| **Booked** | **`transactions.booked_at`** (sale / register day). Includes deposits on **open** transactions. | Register activity, “what we rang,” pipeline. |
| **Fulfilled** | **Pickup / takeaway:** **`transaction_lines.fulfilled_at`**. **Ship:** first qualifying **`shipment_event`** on the order’s **`shipment`** — `label_purchased`, or staff patch to **in_transit** / **delivered** (message patterns match `server/src/logic/shipment.rs` updates). | Sales tax audit, commission **earned** windows, **fulfilled** sales pivots, Metabase “fulfilled revenue” cuts. |

**Single source in SQL:** `reporting.order_recognition_at(transaction_id, ...)` (baseline migration **106**, active migration layout in `migrations/001` / `007` / `019`). Server-side dynamic SQL must stay aligned with **`server/src/logic/report_basis.rs`** (`ORDER_RECOGNITION_TS_SQL`, `transaction_date_filter_sql`, `transaction_recognition_tax_filter_sql`).

Completed-basis range filters evaluate the recognition expression once against one half-open PostgreSQL timestamp range. Do not expand that predicate into separate null, lower-bound, and upper-bound copies: shipment recognition contains correlated evidence lookups, and repeated evaluation materially slows Daily Sales and other fulfilled-basis reports without changing the answer.

## API (`GET /api/insights/*`)

Back Office -> Reports exposes these curated report tiles through staff-facing names and a local search box. Staff can search by task or question (for example **tax**, **pickup**, **balance**, **slow stock**, or **What sold best last month?**) without changing the underlying basis rules below.

- **`sales-pivot`** — Query **`basis`**: `booked` / `sale` / `booking` vs `fulfilled` / `pickup` / `fulfillment`. Fulfilled uses fulfillment filter + fulfilled date for **`group_by=date`**.
- **`register-day-activity`** — Query **`basis`**: `booked` (default) vs `fulfilled`. Fulfilled timeline uses fulfillment timestamp. Z-close EOD snapshots remain **booked** only. Every interactive response is calculated in one read-only repeatable-read transaction. Complete View/Print/CSV output (up to 20,000 combined detail rows) and the post-close snapshot hold one database snapshot across all internal pages, verify exact totals and unique row identities, and refuse to expose or persist a partial set.
- **`register-override-mix`** — Optional **`basis`** + `from` / `to` (flattened): fulfilled = fulfillment window.
- **`nys-tax-audit`** — **Fulfillment only** (no `basis`): lines are included when the order’s fulfillment instant falls in `from` / `to`.
- **`commission-ledger`** — **Unpaid** = open lines with **booked** date in range (pipeline). **Earned in period** = append-only commission events with **fulfillment/recognition** instant in range.
- **`staff-performance`** — Optional **`basis`** for 7-day **revenue_momentum** (booked vs fulfilled).
- **`loyalty-velocity`** — Time-series of loyalty points earned vs. burned (Earn vs Burn).

## Metabase (`reporting` schema)

Current reporting schema:

- **`reporting.transactions_core`** / **`reporting.order_lines`** — **`booked_business_date`** / **`order_business_date`** = booked local day; **`recognition_at`** / **`order_recognition_at`** and **`recognition_business_date`** / **`order_recognition_business_date`** = fulfillment.
- **`reporting.daily_order_totals`** — Aggregates by **booked** business date only (unchanged semantics).
- **`reporting.daily_order_totals_fulfilled`** — Aggregates by **fulfillment** business day (cancelled excluded; `recognition_at IS NOT NULL`).
- **`reporting.loyalty_customer_snapshot`** — Per-customer loyalty stats (Earnings vs Redemptions vs Balance).
- **`reporting.loyalty_daily_velocity`** — Daily earn vs burn velocity charts.
- **`reporting.transaction_status_integrity`** — Exception view for mismatches between `transactions.status`, line fulfillment state, and missing fulfillment timestamps. Check this before trusting a disputed receipt, loyalty balance, commission window, QBO staging row, or fulfilled-revenue report.
- **`reporting.counterpoint_import_financial_integrity`** — Read-only comparison of each imported Counterpoint Transaction header, current line total, stored paid amount, allocated tenders, booking timestamps, and audit evidence. Critical differences require source review; the view never chooses a replacement financial value.
- **`reporting.counterpoint_booking_date_repair_manifest`** — Dry-run list of imported current-line and initial-booking timestamps that differ from the retained Counterpoint Transaction booking time. The guarded repair uses this exact manifest and cannot update transaction headers, payments, allocations, or tender amounts.

Counterpoint ticket ingest must explicitly copy `transactions.booked_at` into every imported `transaction_lines.booked_at`. Relying on the line column's `now()` default records the import day as a false booked sale, so a missing or malformed source timestamp is an import exception instead of a current-time fallback. Existing mismatches are repaired only through the reviewed manifest path, which retains before/after evidence and leaves ambiguous or orphaned booking events for manual review. Rerunning an imported source suppresses the synthetic line-deletion event and marks the superseded initial event as excluded audit history before the source-dated replacement is inserted.

The Returns, Exchanges & Refunds report separates three ledgers instead of summing the same obligation repeatedly: returned-item rows describe merchandise and tax, refund-queue rows show due and remaining liability, and only successfully posted negative payment rows show value actually refunded. Failed, declined, voided, cancelled, or error provider movements never count as refund paid.

That report is an audited paged response, ordered by activity time and stable row identity. Each page carries the same as-of timestamp, total count, and full-dataset fingerprint. The Reports workspace verifies those values and rejects duplicate or missing rows before rendering charts, a table, print output, or CSV. Ranges above 20,000 rows fail closed and must be narrowed; the former silent 1,000-row cutoff is not used.

Lane-scoped Register Day requests require the query's `register_session_id` to match a valid POS session secret. A staff caller without that matching secret must hold `register.reports`; an open session UUID by itself grants no report access.

**`metabase_ro`:** `GRANT SELECT` on ALL TABLES IN SCHEMA reporting.

## Roadmap / gaps

- Storefront “picked up” vs “shipped” customer-facing states and a dedicated **`transactions.shipped_at`** (or carrier webhook event) would simplify fulfillment recognition; today rely on **Shipments** hub events.
- **`/api/insights/best-sellers`** and **`/dead-stock`** use the same **`basis`** query parameter as **`/api/insights/sales-pivot`** (**`booked`** → **`transactions.booked_at`**; **`fulfilled`** → fulfillment instant per **`transaction_date_filter_sql`** / **`reporting.order_recognition_at`**).
- **`/api/insights/margin-pivot`** (**Admin only**) uses the same **`basis`** and **`group_by`** as **`sales-pivot`**; margin is pre-tax line revenue minus **`SUM(transaction_lines.unit_cost × quantity)`** (cost frozen at checkout).
- **Metabase** (**`reporting.order_lines`**): same line-level **`unit_cost`**, **`line_extended_cost`**, **`line_gross_margin_pre_tax`**; filter by **`order_business_date`** (booked) or **`order_recognition_business_date`** (fulfilled) to match API **`basis`**.
- Operational Reports catalog tiles for appointment no-shows, wedding readiness, schedule coverage, customer follow-up, and exception risk use dedicated read-only endpoints. They must not be used as a substitute for the booked vs fulfilled API contracts above.

## Related docs

- **`docs/METABASE_REPORTING.md`** — Phase 2 views, OSS access model.
- **`docs/PRODUCTION_DEPLOYMENT_GO_NO_GO_CHECKLIST.md`** — current launch readiness checklist.
- **`docs/AI_REPORTING_DATA_CATALOG.md`** — Route-level permissions and parameters.
- **`docs/BOOKED_VS_FULFILLED.md`** — Financial theory and ledger flows.
