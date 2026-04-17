# Intelligence Layer Guide — Riverside OS (Phase 3)

Riverside OS transitions from a passive ERP to a proactive operational decision engine in v0.1.11. This document details the three core intelligence engines and their implementation.

## 1. Wedding Health Scoring Engine
The Wedding Health engine identifies "silent failures" in wedding parties before they become day-of emergencies.

- **Logic**: `server/src/logic/wedding_health.rs`
- **Scoring Algorithm**:
  - **Payments (40%)**: Ratio of `balance_due` vs `total_price` across all party members.
  - **Measurements (40%)**: Percentage of members with `fitting_completed` status.
  - **Temporal Risk (20%)**: Proximity to the `wedding_date`.
- **UI Integration**: `WeddingHealthHeatmap.tsx` in the Wedding Manager dashboard.
- **Actionable Path**: Managers click "Red" heatmap cells to open the Party Detail and initiate Podium SMS nudges for missing measurements or balances.

## 2. Inventory Brain v2
Moves the catalog from static "min/max" levels to dynamic sales-velocity replenishment.

- **Logic**: `server/src/logic/inventory_brain.rs`
- **Analysis Window**: 45-day lookback on `order_items.booked_at`.
- **Prescriptive Actions**:
  - **Reorder**: Generated when `stock_on_hand` / `daily_velocity` < 14 days.
  - **Stock Rescue (Clearance)**: Identified when a SKU has > 10 units on-hand but 0 sales in the 45-day window.
- **UI Integration**: `IntelligencePanel.tsx` in the Inventory Workspace.
- **Trust Factor**: Every recommendation includes a "Confidence Score" and "Justification String" to explain the math to the user.

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

## Implementation Standard for Intelligence Features
When adding "Intelligence" to other domains (e.g., Marketing, Alterations):
1. **Never return raw numbers**: Always provide a `reason` or `explainer` string.
2. **Weighted Scoring**: Avoid binary yes/no flags; use 0–100 scores to allow the UI to color-code risk (Green > Amber > Red).
3. **Data Freshness**: Always tie recommendations to a specific analysis window (default 45 days).
