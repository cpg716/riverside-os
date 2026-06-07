# Insights (Metabase) and commission reports

**Audience:** Owners, managers, accountants, and anyone with reporting or payout permissions.

**Where in ROS**

- **Back Office → Reports** — **curated** read-only reports (sales and margin pivots, register exports, tax audit, wedding health, best sellers, and more) backed by **`/api/insights/*`**. Same tab uses **`insights.view`**; **Margin pivot** is **Admin role only**. Use **Open Insights (Metabase)** in this workspace for deep exploration. **Staff manual:** **[reports-curated-manual.md](reports-curated-manual.md)**. **Admin / store policy:** **[reports-curated-admin.md](reports-curated-admin.md)**.
- **Back Office → Insights** — opens the **Insights shell**: thin Riverside header plus a **full-page Metabase** iframe (same site, path **`/metabase/`** behind the scenes). There are **no** Insights subsections in the sidebar.
- **Back Office → Staff → Commissions → Reports** — commission reporting by period and staff member (Riverside UI, not Metabase).

**Related permissions**

- **Reports tab:** **insights.view** (plus **Admin** for margin pivot)
- **Insights tab:** **insights.view**
- **Staff → Commissions → Reports:** **insights.view**
- **Staff → Commissions → SPIFFs & Combos:** **staff.manage_commission**

**In-app Help:** open **Help** in the header — **Reports (curated)** (`reports-manual.md`) and **Insights (Metabase)** (`insights-manual.md`).

---

## Staff Metabase login vs admin Metabase login

**Riverside** checks **`insights.view`** to show **Insights**. On configured stations, Riverside also launches Metabase with the saved **Staff** or **Admin** Metabase account based on the signed-in staff member. If automatic launch is unavailable, **Metabase** uses its **own** username and password (or SSO if your store enabled JWT on paid Metabase).

**Store standard:** Maintain **two classes** of Metabase user:

- **Staff** — access **staff-safe** dashboards and collections only (typically **no** margin, **no** cost columns, **no** private exploratory folders unless leadership allows).
- **Admin** — full reporting in Metabase, including **margin** and sensitive cuts on **`reporting.*** views.

Give **staff-class** Metabase credentials to floor teams; reserve **admin-class** credentials for owners, finance, and IT. **Do not** use one shared “everyone” Metabase login if margin must stay private. Full ops checklist: **[METABASE_REPORTING.md](../METABASE_REPORTING.md)**.

**Back Office → Reports** is separate: **Margin pivot** there is gated by **Riverside Admin role** on the API, not by which Metabase user you use.

---

## Reports API vs Metabase access

Some operational insights are available immediately in **Back Office → Reports** because Riverside serves them through **`/api/insights/*`**. Metabase can only slice those topics freely after IT adds readable **`reporting.*`** views and models them in Metabase.

Current Reports-first topics:

- Appointments & No-Show
- Wedding Event Readiness
- Staff Schedule Coverage vs Sales
- Customer Follow-Up
- Exception & Risk
- Register Day Activity when staff need broad ad-hoc slicing

Use **Reports** for those until the matching Metabase views are added. Merchant Activity should use payment/merchant reconciliation views in Metabase; loyalty dashboards should use the loyalty reporting views.

**Status integrity check:** If fulfilled reports, receipt loyalty, commissions, QBO staging, or tax totals disagree, Admin / IT should inspect `reporting.transaction_status_integrity`. ROS register rows should be zero before relying on the affected reporting window; historical / imported rows need a reconciliation policy before bulk repair.

---

## How to use Insights (Metabase)

**Purpose:** Deep analytics — questions, dashboards, and (when enabled) SQL — using **Metabase’s** interface inside Riverside.

1. Select **Insights** in the left rail. The normal Back Office layout is replaced by the **Insights** shell.
2. If automatic launch is configured, Metabase opens without a manual login.
3. If Riverside shows a warning that automatic sign-in is unavailable, continue into the normal Metabase sign-in screen. This means the station fell back to standard Metabase login for this session.
4. If Metabase asks you to **log in**, use the **Metabase username** you were assigned (**staff** or **admin** class per store policy).
5. Work in Metabase as trained (filters, time ranges, collections your Metabase admins configured for **your** login).
6. Use **Back to Back Office** in the top bar when finished.

**Same browser:** Metabase keeps its own session. Log out of Metabase when switching between **staff** and **admin** Metabase identities on a shared PC, or use separate browser profiles per policy.

---

## Commissions → Reports (Staff workspace)

**Purpose:** Review commission reporting for all staff or one selected staff member over a day, week, month, year, or custom window. This is reporting-sensitive and is the owner/accounting view used for monthly review.

1. **Staff** → **Commissions** → **Reports** (unlock **Staff** with your code if prompted).
2. Set **From** / **To** (or use **Last 14 days**, **Prior 14 days**, or **Prior month payroll**), then **Refresh**.
3. Optional: pick a **Staff** member to run a staff-level report.
4. Review the earned-only payroll columns: **Rate**, **Rate since**, **Sales**, **By rate**, **SPIFF $**, and final **Earned commission**. Riverside uses **fulfillment / pickup / shipping recognition**, not booking, for earned commission timing.
5. Use **Print report** when the owner/accounting team needs the payroll review copy.
6. Use the bottom **Total commissions paid for period** row as the payroll-facing period total.

### Effective-dated commission changes

- Staff base commission changes require a **start date**.
- Riverside shows the current rate and **Rate since** date in the commission report.
- Recognized commission events snapshot the rate context used when the commission was earned; corrections use manual adjustments.

**Category commission rate overrides are retired from the staff-facing workflow.** Base rates live on Staff Profile. Fixed SPIFF and combo incentives are managed under **Staff** → **Commissions** → **SPIFFs & Combos**.

---

## RMS / R2S reporting (related)

Operational **RMS charge** and **RMS payment** lines are listed under **Customers → RMS charge** (permission **customers.rms_charge**). The API **`GET /api/insights/rms-charges`** still backs aggregated reporting for staff with **insights.view** (e.g. Metabase questions or **POS → Reports** for register context). See **[Parked sales and RMS charges](../POS_PARKED_SALES_AND_RMS_CHARGES.md)**.

---

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Blank iframe | Metabase or proxy not running | IT / **DEVELOPER.md** Metabase section |
| Metabase login loop | **Site URL** in Metabase admin must match how you open the store | IT |
| No **Insights** tab | Missing **insights.view** | Admin / **STAFF_PERMISSIONS.md** |
| No **Reports** tab inside **Commissions** | Need **insights.view** | Admin |

---

## When to get a manager

- Payroll questions after monthly review.
- Suspected **fraud** or returns affecting commission.

---

## See also

- [reports-curated-manual.md](reports-curated-manual.md) — day-to-day **Reports** workspace
- [reports-curated-admin.md](reports-curated-admin.md) — permissions margin policy Metabase alignment
- [../PLAN_METABASE_INSIGHTS_EMBED.md](../PLAN_METABASE_INSIGHTS_EMBED.md) — architecture and ops checklist
- [../METABASE_REPORTING.md](../METABASE_REPORTING.md) — governance views (Phase 2) pointer
- [../AI_REPORTING_DATA_CATALOG.md](../AI_REPORTING_DATA_CATALOG.md) — **`/api/insights/*`** for integrations / NL reporting
- [../POS_PARKED_SALES_AND_RMS_CHARGES.md](../POS_PARKED_SALES_AND_RMS_CHARGES.md)
- [../PRODUCT_ROADMAP_MENS_WEDDING_RETAIL.md](../PRODUCT_ROADMAP_MENS_WEDDING_RETAIL.md)

**Last reviewed:** 2026-05-16
