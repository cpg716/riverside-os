# Booked vs Fulfilled reporting

Riverside OS uses two time axes for revenue-style analytics:

| Axis | Meaning | Typical use |
|------|---------|-------------|
| **Booked** | **`orders.booked_at`** (sale / register day). Includes deposits on **open** orders. | Register activity, “what we rang,” pipeline. |
| **Fulfilled** | **Pickup / takeaway:** **`orders.fulfilled_at`** when **`fulfillment_method = pickup`** (default). **Ship:** first qualifying **`shipment_event`** on the order’s **`shipment`** — `label_purchased`, or staff patch to **in_transit** / **delivered** (message patterns match `server/src/logic/shipment.rs` updates). | Sales tax audit, commission **realized** / finalize windows, **fulfilled** sales pivots, Metabase “fulfilled revenue” cuts. |

**Single source in SQL:** `reporting.order_recognition_at(order_id, fulfillment_method, status, fulfilled_at)` (migration **`106_reporting_order_recognition.sql`**). Server-side dynamic SQL must stay aligned with **`server/src/logic/report_basis.rs`** (`ORDER_RECOGNITION_TS_SQL`, `order_date_filter_sql`, `order_recognition_tax_filter_sql`).

## API (`GET /api/insights/*`)

- **`sales-pivot`** — Query **`basis`**: `booked` / `sale` / `booking` vs `fulfilled` / `pickup` / `fulfillment`. Fulfilled uses fulfillment filter + fulfilled date for **`group_by=date`**.
- **`register-day-activity`** — Query **`basis`**: `booked` (default) vs `fulfilled`. Fulfilled timeline uses fulfillment timestamp. Z-close EOD snapshots remain **booked** only.
- **`register-override-mix`** — Optional **`basis`** + `from` / `to` (flattened): fulfilled = fulfillment window.
- **`nys-tax-audit`** — **Fulfillment only** (no `basis`): lines are included when the order’s fulfillment instant falls in `from` / `to`.
- **`commission-ledger`** — **Unpaid** = open lines with **booked** date in range (pipeline). **Realized** / **paid out** = fulfilled lines with **fulfillment** instant in range.
- **`commission-finalize`** (POST) — Finalizes lines whose **fulfillment** instant falls in the posted range (same rule as ledger realized).
- **`staff-performance`** — Optional **`basis`** for 7-day **revenue_momentum** (booked vs fulfilled).

## Metabase (`reporting` schema)

After migration **106**:

- **`reporting.orders_core`** / **`reporting.order_lines`** — **`order_business_date`** = booked local day; **`order_recognition_at`**, **`order_recognition_business_date`** = fulfillment. **`fulfillment_method`** on **`orders_core`**.
- **`reporting.daily_order_totals`** — Aggregates by **booked** business date only (unchanged semantics; comment in migration).
- **`reporting.daily_order_totals_fulfilled`** — Aggregates by **fulfillment** business day (cancelled excluded; `recognition_at IS NOT NULL`).

**`metabase_ro`:** `GRANT EXECUTE` on **`reporting.order_recognition_at`**.

## Roadmap / gaps

- Storefront “picked up” vs “shipped” customer-facing states and a dedicated **`orders.shipped_at`** (or carrier webhook event) would simplify fulfillment recognition; today rely on **Shipments** hub events.
- **`/api/insights/best-sellers`** and **`/dead-stock`** use the same **`basis`** query parameter as **`/api/insights/sales-pivot`** (**`booked`** → **`orders.booked_at`**; **`fulfilled`** → fulfillment instant per **`order_date_filter_sql`** / **`reporting.order_recognition_at`** — see migration **106**).
- **`/api/insights/margin-pivot`** (**Admin only**) uses the same **`basis`** and **`group_by`** as **`sales-pivot`**; margin is pre-tax line revenue minus **`SUM(order_items.unit_cost × quantity)`** (cost frozen at checkout).
- **Metabase** (**`reporting.order_lines`**, migration **107**): same line-level **`unit_cost`**, **`line_extended_cost`**, **`line_gross_margin_pre_tax`**; filter by **`order_business_date`** (booked) or **`order_recognition_business_date`** (fulfilled) to match API **`basis`**.

## Related docs

- **`docs/METABASE_REPORTING.md`** — Phase 2 views, OSS access model.
- **`ThingsBeforeLaunch.md`** — Metabase + migration **106** checklist.
- **`docs/AI_REPORTING_DATA_CATALOG.md`** — Route-level permissions and parameters.
- **`docs/BOOKED_VS_FULFILLED.md`** — Financial theory and ledger flows.
