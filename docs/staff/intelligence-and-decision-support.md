# Intelligence & Decision Support

**Audience:** Owners, Managers, Inventory Leads, and staff using ROSIE for guided help.

**Where in ROS:**
- **Inventory Workspace** (Product Intelligence Drawer)
- **Staff -> Commission Reports** (Truth Trace)
- **Help Center -> Ask ROSIE / Chat with ROSIE**

---

## ROSIE operational copilots

ROSIE can now act as a guided operational copilot for common recovery questions:

- close blockers
- refund or return recovery
- inventory mismatch triage
- QBO exception interpretation
- receiving assistance
- inventory lookup
- appointment scheduling guidance

ROSIE answers stream into the Help Center and show sources when available. Sources may include manuals, Store SOP, approved read tools, reports, or server-authored operational playbooks.

ROSIE may also show **Suggested Actions**. These start a guided follow-up or point staff toward the correct workflow. They do not post receiving, change inventory, approve refunds, close registers, sync QBO, or book appointments.

ROSIE remembers only short-session context, such as the current Help article and the last question/answer summary. Treat that as conversational context, not business truth. Current screen state, server facts, manuals, Store SOP, and manager decisions are still authoritative.

For voice use, speak the operational need plainly: "help me receive stock," "look up this SKU," or "help schedule an appointment." ROSIE can guide the steps and read back a summary, but staff must confirm final work in the normal Riverside OS screen.

## 1. Product Intelligence Drawer

**Purpose:** Rapid SKU resolution and context-aware inventory data.

When شما scan an item or select a variant in the **Inventory Workspace**, the **Intelligence Drawer** provides:
- **Velocity Metrics**: 45-day sales volume.
- **Stock Status**: On-hand vs. Reserved.
- **Auto-Resolve**: Automatic SKU fetching and fulfillment mapping for incoming stock.

---

## 2. Commission Trust Center (Truth Trace)

**Purpose:** Transparency for commission reporting. Answers the question: *"Why did this line report this exact amount?"*

### The "Truth Trace"
In the **Commission Reports** panel, you can click **Trace** on a line to see a **Truth Trace**. This is a human-readable summary of the calculation context for that sale.

### Precedence Rules
The intended commission model is staff base rate plus fixed incentive add-ons:
1. **Staff Base Rate** from the Staff Profile, effective-dated.
2. **Fixed SPIFF** add-on when configured.
3. **Combo Incentive** add-on when configured.
4. **Return / exchange / manual adjustment** events in Phase 2.

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

## 4. Inventory Brain (Replenishment)

**Purpose:** Data-driven reordering based on actual sales velocity, not just min/max guesses.

### Queues
- **Replenishment**: Variants that will run out of stock in < 14 days based on 45-day sales patterns.
- **Clearance**: Slow-moving inventory with high stock levels and 0 sales in the last 45 days.

---

## Retired Features (v0.1.x Legacy)

The following features were retired or postponed during the v0.2.0 stabilization sweep:
- **Omni-Search Command Palette**: Universal keyboard triggering has been retired in favor of the optimized Global Search Drawer.

---

## See Also
- [reports-curated-manual.md](reports-curated-manual.md)
- [insights-back-office.md](insights-back-office.md)
- [inventory-back-office.md](inventory-back-office.md)
- [settings-back-office.md](settings-back-office.md)
- [../ROSIE_OPERATING_CONTRACT.md](../ROSIE_OPERATING_CONTRACT.md)

**Last Reviewed:** 2026-05-17
