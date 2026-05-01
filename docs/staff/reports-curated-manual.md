# Reports (curated library)

**Audience:** Owners, managers, and staff who need **trusted daily numbers** without building Metabase questions.

**Where in ROS:** Back Office → sidebar **Reports** (chart icon, labeled **BO**). This is **not** the POS rail **Reports** tab (lane register tools). Those are covered in **[pos-reports.md](pos-reports.md)** and **[operations-home.md](operations-home.md)** (Daily Sales under Operations).

**Primary permission:** **insights.view** for most tiles. Your role may also need **customers.rms_charge** or **register.reports** for specific tiles (see below). **Margin pivot** appears only for users whose **Back Office role is Admin**.

**Partner doc (store leads):** **[reports-curated-admin.md](reports-curated-admin.md)** — permissions, basis rules, and governance.

---

## What this screen is for

**Reports** is a **fixed catalog** of read-only reports. Each tile calls **one** Riverside API, so what you see matches **store permissions** (unlike Metabase, where access is controlled separately inside Metabase).

Use **Reports** when you need a **quick answer**: sales by dimension, best sellers, tax buckets, register history, wedding pipeline health, and similar. You can now search by the task or question you have, not only by report title.

Use **Insights** (Metabase) when you need to **explore**, save ad-hoc questions, or use dashboards your admins built there. On the Reports page, **Open Insights (Metabase)** switches to that shell.

**Metabase logins:** Riverside does **not** automatically make you a Metabase “admin.” Your store should give you a **staff** or **admin** **Metabase** username for Insights; that controls margin and other sensitive views **inside Metabase** (see **[insights-back-office.md](insights-back-office.md)**).

---

## How to use the Reports library

1. Sign in to **Back Office** (staff code and PIN when required).
2. Select **Reports** in the left rail.
3. Use **Search reports by task, question, or keyword** if you already know what you need.
   - Examples: **pickup**, **balance**, **tax**, **cash**, **drawer**, **slow stock**, **appointments**, **no-show**, **open orders**.
   - You can also search by natural questions like **What sold best last month?** or **Who still owes money?**
4. **Choose a report card** to open the detail view.
5. When the detail shows **From** / **To**, pick the **date range** (store-local dates as shown by the control).
6. When **Basis** appears, choose:
   - **Booked (sale date)** — when the sale was rung (pipeline / “what we sold”).
   - **Completed (recognition)** — when qualifying fulfillment events happened (pickup / ship per your store rules). Same ideas as Metabase reporting; see **[REPORTING_BOOKED_AND_RECOGNITION.md](../REPORTING_BOOKED_AND_RECOGNITION.md)** if you need detail.
7. For **Sales Breakdown** and **Margin & Cost Breakdown** (Admin only), use **Group by** to change the breakdown (brand, category, salesperson, customer, or day).
8. Use **Refresh** if you change filters. Use **CSV** (when shown) to download the current table.

## Search labels on report cards

Each report card includes labels that help you pick the right report quickly:

| Label | Meaning |
|-------|---------|
| **Category** | Report area: **Sales**, **Inventory**, **Register**, **Weddings**, **Customers**, **Finance**, **Staff**, or **Operations** |
| **Audience** | Usual reader: **Staff**, **Manager**, **Owner**, or **Admin** |
| **Sensitivity** | Access expectation: **Staff-safe**, **Manager**, or **Admin-only** |

**Admin-only** reports remain separated. If you do not have Admin access, those cards do not appear.

**Shortcuts on the page**

- **POS register day and lane reports** — sends you toward **Operations → Daily Sales** (or POS Reports) for lane-focused tools.
- **Commission reports** — sends you to **Staff** for all-staff or individual staff commission detail.

---

## Report tiles (what you might see)

Tiles **only appear** if you have **every** required permission for that tile (and **Admin** for margin). If something is missing, ask an admin; do not share your staff code.

| Tile (approximate name) | What it is | Permissions |
|-------------------------|------------|-------------|
| **Sales Breakdown** | Revenue, tax, units, and transactions by **Group by** dimension | **insights.view** |
| **Margin & Cost Breakdown** | Gross margin and cost-loaded metrics (sensitive) | **insights.view** + **Admin** role |
| **Best Sellers** | Top products by units in range | **insights.view** |
| **Slow Stock** | On-hand products with little or no sales in range | **insights.view** |
| **Wedding Pipeline** | Upcoming events, members without orders, balances | **insights.view** |
| **Commission Snapshot** | Read-only commission snapshot for a date window (not finalize) | **insights.view** |
| **New York Tax Audit** | Clothing / footwear vs standard taxable buckets | **insights.view** |
| **Staff Sales Performance** | High-ticket and momentum-style stats | **insights.view** |
| **RMS Charge Summary** | Aggregated RMS / R2S charge and payment lines | **insights.view** |
| **Customer RMS Charge Records** | Paged list aligned with **Customers → RMS charge** | **customers.rms_charge** |
| **Closed Register Drawers** | Recent closes, variance-oriented summary | **insights.view** |
| **Discount & Override Reasons** | Counts of override and discount reasons | **insights.view** |
| **Register Day Summary** | Store-wide register day summary | **register.reports** |
| **Saved Wedding Report Views** | Your saved filter bundles | **insights.view** |
| **Card Processing Summary** | Daily card volume, fees, and net settlement values | **insights.view** |
| **Appointments & No-Show Report** | Appointment count, completed visits, cancellations/no-shows, type, salesperson, and wedding-linked vs walk-in | **insights.view** |
| **Wedding Event Readiness Report** | Upcoming weddings with missing measurements, unpaid balances, unfulfilled items, pending alterations, and pickup/shipment risk | **insights.view** |
| **Staff Schedule Coverage vs Sales Report** | Staffing coverage by day compared with sales volume, appointments, pickups, and register activity | **insights.view** |
| **Customer Follow-Up Report** | Customers with balances, pending pickups, recent transactions, upcoming wedding dates, stale RMS charges, or contact gaps | **insights.view** |
| **Exception & Risk Report** | Negative stock, stale fulfillment orders, overdue alterations, high discounts, failed payments, open register sessions, and unclosed tasks | **insights.view** |

Exact titles in the app may vary slightly as the catalog is updated; trust the **card description** on screen.

---

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| No **Reports** tab | Missing **insights.view** | Admin / **[STAFF_PERMISSIONS.md](../STAFF_PERMISSIONS.md)** |
| Tile missing | Need an extra key (e.g. **register.reports**) or margin is **Admin only** | Admin |
| Search returns nothing | Try a task word like **pickup**, **balance**, **tax**, or **slow stock** | Manager if the report should exist |
| Empty or truncated table | Widen dates; **Basis** may exclude rows you expect | Manager / **[REPORTING_BOOKED_AND_RECOGNITION.md](../REPORTING_BOOKED_AND_RECOGNITION.md)** |
| Error after open | Note the message; retry **Refresh** | IT if it persists |
| Need a chart or custom cut | Use **Open Insights (Metabase)** | Metabase training |

---

## When to get a manager

- Numbers that drive **payroll**, **commissions**, or **tax filing** (confirm basis and dates).
- Unexpected **margin** or **cost** rows (Admin-only tile; inventory / receiving may need review).
- **Access** changes (who should see **insights.view** or CRM RMS lists).

---

## See also

- **[insights-back-office.md](insights-back-office.md)** — Metabase shell and **commission reports**
- **[../AI_REPORTING_DATA_CATALOG.md](../AI_REPORTING_DATA_CATALOG.md)** — Curated Reports v1 table and API reference
- **[../REPORTING_BOOKED_AND_RECOGNITION.md](../REPORTING_BOOKED_AND_RECOGNITION.md)** — Booked vs recognition
- **[../POS_PARKED_SALES_AND_RMS_CHARGES.md](../POS_PARKED_SALES_AND_RMS_CHARGES.md)** — RMS charge vs payment
- **[pos-reports.md](pos-reports.md)** — POS **Reports** rail

**Last reviewed:** 2026-05-01
