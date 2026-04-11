---
id: reports
title: "Reports (curated)"
order: 14
summary: "Back Office Reports library: fixed tiles, booked vs completed basis, CSV, Admin-only margin; vs Insights (Metabase)."
tags: reports, analytics, insights, pivot, margin, rbac
---

# Reports (curated) — in-app guide

**Back Office → Reports** shows a **catalog** of read-only reports. Each card is wired to **Riverside** APIs and **your permissions** (not Metabase’s).

## Who can open it

You need **insights.view** to see the **Reports** tab. Some cards need extra keys (for example **register.reports** or **customers.rms_charge**). **Margin pivot** is **Admin only**.

## Quick steps

1. Open **Reports** in the left rail.
2. Tap a **report card** to load the table.
3. Set **From** / **To**, **Basis** (booked sale date vs completed / recognition), and **Group by** when the form offers them.
4. Use **Refresh** after changes and **CSV** when you need a spreadsheet.

**Booked** = when the sale was rung. **Completed** = recognition-style timing for fulfilled lines (see store policy). Ask a lead if you are unsure which to use for payroll or tax questions.

## Reports vs Insights

- **Reports** — fixed list, fast answers, **Riverside RBAC** (only **Admin** Riverside roles get **Margin pivot** here).
- **Insights** — **Metabase**. Your store should give you a **staff** or **admin** **Metabase** login; that controls margin and private collections inside Metabase.

Use **Open Insights (Metabase)** on the Reports page when you need dashboards or custom questions.

## Payouts and register tools

- **NYS tax audit**: Drill-down into clothing vs non-clothing sales for audit.
- **Merchant activity**: Daily Stripe volume, fees, and net settlement values matched to business days.
- **RMS charges**: Export of store-account charges vs payments.

## Full documentation

Trainers and admins: see **`docs/staff/reports-curated-manual.md`** and **`docs/staff/reports-curated-admin.md`** in the repository staff help pack.
