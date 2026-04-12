# Intelligence & Decision Support

**Audience:** Owners, Managers, and Inventory Leads.

**Where in ROS:**
- **Wedding Manager Dashboard** (Heatmap)
- **Inventory Workspace** (Intelligence Panel)
- **Staff -> Commission Payouts** (Truth Trace)

---

## What is the Intelligence Layer?

Riverside OS includes a set of "Decision Engines" that analyze your data to find risks and opportunities before they become problems. Unlike basic reports that just show you what happened, these tools suggest **what to do next**.

---

## 1. Wedding Health Heatmap

**Purpose:** Identify parties at risk of "silent failure" (e.g., missing measurements or unpaid balances) before the wedding week.

### How it works
The system scores every wedding party using a **40/40/20 formula**:
- **40% Payments**: How much of the total balance across all members has been paid.
- **40% Measurements**: What percentage of the party has completed their fittings.
- **20% Time**: How close we are to the actual wedding date.

### Reading the Heatmap
- **Green**: Healthy. Standard follow-up rules apply.
- **Amber**: Warning. Look for missing measurements or "late" payments.
- **Red**: High Risk. Urgent action required to ensure items arrive and fit on time.

**Actionable Path:** Click a red or amber cell to open the **Party Detail**. Use the **Podium SMS** shortcuts to ping the party members for payment or fittings.

---

## 2. Inventory Brain v2

**Purpose:** Move away from static "Min/Max" stocking to dynamic, sales-driven replenishment.

### How it works
The Inventory Brain analyzes the last **45 days** of sales to determine each item's **Velocity** (how fast it sells).

### Recommendations
When you view an item in the **Inventory Workspace**, you may see:
- **Replenish Suggestion**: Generated if your current stock is expected to run out in less than **14 days**.
- **Stock Rescue (Clearance)**: Identified if you have high stock levels but **zero sales** in the last 45 days.

### Trust Factor
Every recommendation includes a **Confidence Score** (0-100) and a **Justification**. Read the justification to see the exact math (e.g., *"This item sold 12 units in 30 days but you only have 2 left on-hand"*).

---

## 3. Commission Trust Center (Truth Trace)

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

**Actionable Path:** If a salesperson disputes a payout, open the **Truth Trace**. It will show exactly which rule "won" and why.

---

## Common Issues & Fixes

| Symptom | Likely Cause | Solution |
|---------|--------------|----------|
| Heatmap is all gray | Missing event date or no members | Ensure the wedding party has a date and linked members. |
| Score seems "too low" | One member is missing measurements | One "Red" status in a member can drag down the whole party score. |
| No Brain suggestions | New item (no history) | The system needs at least some sales history (or 45 days of age) to start suggest-mode. |

---

## See Also
- [reports-curated-manual.md](reports-curated-manual.md)
- [insights-back-office.md](insights-back-office.md)
- [weddings-back-office.md](weddings-back-office.md)
- [inventory-back-office.md](inventory-back-office.md)

**Last Reviewed:** 2026-04-12
