# Booked vs Fulfilled reporting

**Status:** Canonical technical source for reporting basis, fulfillment recognition timing, and API / Metabase alignment. For the financial concept explainer, see [`BOOKED_VS_FULFILLED.md`](BOOKED_VS_FULFILLED.md). For the full reporting doc map, start at [`REPORTING.md`](REPORTING.md).

Riverside OS uses two time axes for revenue-style analytics:

| Axis | Meaning | Typical use |
|------|---------|-------------|
| **Booked** | **`transactions.booked_at`** (sale / register day). Includes deposits on **open** transactions. | Register activity, “what we rang,” pipeline. |
| **Fulfilled** | **Pickup / takeaway:** **`transaction_lines.fulfilled_at`**. **Ship:** first qualifying **`shipment_event`** on the order’s **`shipment`** — `label_purchased`, or staff patch to **in_transit** / **delivered** (message patterns match `server/src/logic/shipment.rs` updates). | Sales tax audit, commission **realized** / finalize windows, **fulfilled** sales pivots, Metabase “fulfilled revenue” cuts. |

**Single source in SQL:** `reporting.transaction_recognition_at(transaction_id, ...)` (updated in migration **142**). Server-side dynamic SQL must stay aligned with **`server/src/logic/report_basis.rs`** (`TRANSACTION_RECOGNITION_TS_SQL`, `transaction_date_filter_sql`, `transaction_recognition_tax_filter_sql`).

## API (`GET /api/insights/*`)

- **`sales-pivot`** — Query **`basis`**: `booked` / `sale` / `booking` vs `fulfilled` / `pickup` / `fulfillment`. Fulfilled uses fulfillment filter + fulfilled date for **`group_by=date`**.
- **`register-day-activity`** — Query **`basis`**: `booked` (default) vs `fulfilled`. Fulfilled timeline uses fulfillment timestamp. Z-close EOD snapshots remain **booked** only.
- **`register-override-mix`** — Optional **`basis`** + `from` / `to` (flattened): fulfilled = fulfillment window.
- **`nys-tax-audit`** — **Fulfillment only** (no `basis`): lines are included when the order’s fulfillment instant falls in `from` / `to`.
- **`commission-ledger`** — **Unpaid** = open lines with **booked** date in range (pipeline). **Realized** / **paid out** = fulfilled lines with **fulfillment** instant in range.
- **`commission-finalize`** (POST) — Finalizes lines whose **fulfillment** instant falls in the posted range (same rule as ledger realized).
- **`staff-performance`** — Optional **`basis`** for 7-day **revenue_momentum** (booked vs fulfilled).
- **`loyalty-velocity`** — Time-series of loyalty points earned vs. burned (Earn vs Burn).

## Metabase (`reporting` schema)

After migration **142**:

- **`reporting.transactions_v1`** / **`reporting.transaction_lines_v1`** — **`transaction_business_date`** = booked local day; **`transaction_recognition_at`**, **`transaction_recognition_business_date`** = fulfillment.
- **`reporting.daily_transaction_totals`** — Aggregates by **booked** business date only (unchanged semantics).
- **`reporting.daily_transaction_totals_fulfilled`** — Aggregates by **fulfillment** business day (cancelled excluded; `recognition_at IS NOT NULL`).
- **`view_loyalty_customer_snapshot`** — Per-customer loyalty stats (Earnings vs Redemptions vs Balance).
- **`view_loyalty_daily_velocity`** — Daily earn vs burn velocity charts.

**`metabase_ro`:** `GRANT SELECT` on ALL TABLES IN SCHEMA reporting.

## Roadmap / gaps

- Storefront “picked up” vs “shipped” customer-facing states and a dedicated **`transactions.shipped_at`** (or carrier webhook event) would simplify fulfillment recognition; today rely on **Shipments** hub events.
- **`/api/insights/best-sellers`** and **`/dead-stock`** use the same **`basis`** query parameter as **`/api/insights/sales-pivot`** (**`booked`** → **`transactions.booked_at`**; **`fulfilled`** → fulfillment instant per **`transaction_date_filter_sql`** / **`reporting.transaction_recognition_at`** — see migration **142**).
- **`/api/insights/margin-pivot`** (**Admin only**) uses the same **`basis`** and **`group_by`** as **`sales-pivot`**; margin is pre-tax line revenue minus **`SUM(transaction_lines.unit_cost × quantity)`** (cost frozen at checkout).
- **Metabase** (**`reporting.transaction_lines_v1`**, migration **142**): same line-level **`unit_cost`**, **`line_extended_cost`**, **`line_gross_margin_pre_tax`**; filter by **`transaction_business_date`** (booked) or **`transaction_recognition_business_date`** (fulfilled) to match API **`basis`**.

## Related docs

- **`docs/METABASE_REPORTING.md`** — Phase 2 views, OSS access model.
- **`ThingsBeforeLaunch.md`** — Metabase + migration **106** checklist.
- **`docs/AI_REPORTING_DATA_CATALOG.md`** — Route-level permissions and parameters.
- **`docs/BOOKED_VS_FULFILLED.md`** — Financial theory and ledger flows.
