# Inventory Overview & Support (ROS v0.2.0)

**Audience:** Owners, Managers, and Inventory Leads.

**Where in ROS:**
- **Inventory Overview** (Landing page)
- **Staff -> Commission Payouts** (Truth Trace)

---

## 1. Stock Overview

**Purpose:** Rapid SKU resolution and context-aware inventory data.

On the **Inventory Overview** page, you can see real-time alerts for:
- **Velocity Metrics**: 45-day sales volume.
- **Notification Center**: Items needing manual review.
- **Stock Status**: On-hand vs. Available for Sale.

---

## 2. Commission Trust Center (Truth Trace)

**Purpose:** Transparency for complex payouts. Answers the question: *"Why did I earn this exact amount?"*

### The "Truth Trace"
In the **Commission Payouts** panel, you can click on any pending amount to see a **Truth Trace**. This is a human-readable summary of the rules applied to that sale.

### Precedence Rules
If multiple commission rules conflict, the system follows this order:
1. **Specific SKU Rule** (Highest - overrides everything)
2. **Specific Product Rule**
3. **Category Rule**
4. **General Category Override**
5. **Staff Base Rate** (Lowest - the default)

---

## 3. Wedding Health Heatmap

**Purpose:** Identify parties at risk of "silent failure" (e.g., missing measurements or unpaid balances) before the wedding week.

### How it works
The system scores every wedding party using a **40/40/20 formula**:
- **40% Payments**: Balance paid vs. total.
- **40% Measurements**: Fitting completion percentage.
- **20% Time**: Proximity to the wedding date.

### Visibility
In the **Wedding Manager** dashboard, a new **Health** tab provides a color-coded matrix. Clicking a cell opens a diagnostic view with actionable steps (e.g., "Ping via SMS").

---

## 4. Stock Alerts (Replenishment)

**Purpose:** Data-driven reordering based on actual sales activity.

### Queues
- **Reorder List**: Items that will run out of stock in < 14 days based on 45-day sales patterns.
- **Review List**: Slow-moving inventory with high stock levels and 0 sales in the last 45 days.

---

## Retired Features (v0.1.x Legacy)

The following features were retired or postponed during the v0.2.0 stabilization sweep:
- **Omni-Search Command Palette**: Universal keyboard triggering has been retired in favor of the optimized Global Search Drawer.

---

## See Also
- [reports-curated-manual.md](reports-curated-manual.md)
- [insights-back-office.md](insights-back-office.md)
- [inventory-back-office.md](inventory-back-office.md)

**Last Reviewed:** 2026-04-13
