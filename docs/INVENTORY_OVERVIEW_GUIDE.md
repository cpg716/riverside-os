# Inventory Overview & Decision Support — Riverside OS (Phase 3)

Riverside OS provides proactive stock management and decision support. This document details the core engines and their implementation.

## 1. Wedding Health Scoring
The Wedding Health engine identifies "silent failures" in wedding parties before they become day-of emergencies.

- **Logic**: `server/src/logic/wedding_health.rs`
- **Scoring Algorithm**:
  - **Payments (40%)**: Ratio of `balance_due` vs `total_price` across all party members.
  - **Measurements (40%)**: Percentage of members with `fitting_completed` status.
  - **Temporal Risk (20%)**: Proximity to the `wedding_date`.
- **UI Integration**: `WeddingHealthHeatmap.tsx` in the Registry Dashboard.
- **Actionable Path**: Managers click "Red" heatmap cells to open the Party Detail and initiate Podium SMS nudges for missing measurements or balances.

## 2. Inventory Overview & Stock Alerts
Moves the catalog from static "min/max" levels to dynamic sales-activity replenishment.

- **Logic**: `server/src/logic/inventory_brain.rs`
- **Analysis Window**: 45-day lookback on `transaction_lines`.
- **Prescriptive Actions**:
  - **Reorder List**: Generated when stock levels are low relative to 45-day sales.
  - **Review List (Clearance)**: Identified when a SKU has high stock but 0 sales in the 45-day window.
- **UI Integration**: `InventoryOverviewPanel.tsx` in the Inventory Overview.
- **Staff Explainer**: Every recommendation includes a "Priority Level" and a simple reason (e.g., "High demand in last 2 weeks").

## 3. Commission Trust Center (Truth Trace)
Automates the audit path for complex commission splits and SPIFF overrides.

- **Logic**: `server/src/logic/sales_commission.rs` (Calculation) & `server/src/logic/commission_trace.rs` (Audit).
- **The "Truth Trace"**: A human-readable logic explainer that answers: *"Why did I earn exactly this amount on this line?"*
- **Precedence Logic**:
  1. **Variant-specific Rule** (Highest)
  2. **Product-specific Rule**
  3. **Category-specific Rule**
  4. **Legacy Category Override**
  5. **Staff Base Rate** (Fallback)
- **UI Integration**: `CommissionTraceModal.tsx` accessible via the Drill-down Audit in the Commission Payouts panel.

## Implementation Standard for Support Features
1. **Never return raw numbers**: Always provide a `reason` or `explainer` string.
2. **Weighted Scoring**: Avoid binary yes/no flags; use 0–100 scores to allow the UI to color-code risk (Green > Amber > Red).
3. **Data Freshness**: Always tie recommendations to a specific analysis window (default 45 days).
