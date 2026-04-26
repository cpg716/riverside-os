---
id: insights
title: "Insights (Metabase)"
order: 15
summary: "Metabase analytics in-app, Metabase login, Staff commission reports, permissions. For the curated Reports library, open the Reports (curated) manual in Help."
tags: insights, metabase, reports, analytics, commission
---

# Insights (Metabase) — staff guide

This guide covers **Insights** (powered by **Metabase**) and **commission reports** (under **Staff**). For **Back Office → Reports** (curated tiles, basis, CSV, Admin-only margin), open **Help → Reports (curated)**.

---

## What this is

- **Insights** in the left sidebar opens a **full-screen shell** with a thin Riverside header and a large **embedded Metabase** window.
- **Exploratory reporting** (questions, dashboards, SQL where your store allows it) happens **inside Metabase**, not in old built-in chart tabs.
- **Riverside** and **Metabase** use **separate logins**. Your staff code and PIN do **not** automatically sign you into Metabase.

## When to use it

Use **Insights** when staff need exploratory dashboards, saved Metabase questions, or analytics views that go beyond the fixed Riverside **Reports** card library.

---

## Open Insights

1. Sign in to **Back Office** (staff code and PIN when required).
2. In the main navigation, select **Insights** (chart icon, labeled **BO**).
3. The main layout switches to the **Insights** shell. The center area loads **Metabase** from the same site address under **`/metabase/`** (your store may hide this path; you just see the analytics app).

If you **do not** see **Insights**, your role may not include **insights.view**. Ask an admin to check **Staff → Role access** or your **User overrides** (see **`docs/STAFF_PERMISSIONS.md`**).

---

## Sign in to Metabase

The first time (or after a logout or browser data clear), Metabase may show its **own** login page inside the frame.

1. Use the **Metabase username** you were assigned. Stores should use **at least two classes** of Metabase login: **staff** (staff-safe dashboards only — typically **no** margin or cost) and **admin** (full reporting, including margin on **`reporting.*** views). **`insights.view`** in Riverside only opens the shell; **your Metabase login** controls private data inside Metabase.
2. After a successful login, Metabase keeps a **session cookie** in the **same browser** as Riverside, so returning to **Insights** usually stays signed in.

**Security notes**

- Treat **admin** Metabase credentials like **financial** access: do not share them with everyone who has **`insights.view`**.
- **Log out** of Metabase when switching between staff and admin Metabase identities on a shared PC, or use separate browser profiles, per store policy.
- Anyone who can log into Metabase as **user X** sees everything **user X** is allowed in Metabase (collections, groups). See **`docs/METABASE_REPORTING.md`**.

---

## Using Metabase day to day

- Build or open **questions** and **dashboards** the way Metabase documents describe (filters, time ranges, exports — depending on what your admins enabled).
- Use **Back to Back Office** in the Riverside header when you are done; you return to the normal sidebar layout.
- The **notification bell** in the Insights header is still Riverside’s inbox (same as elsewhere).

---

## Commission reports (Staff workspace)

Commission reporting is **not** inside the Metabase iframe. It uses Riverside APIs and lives under **Staff**.

**Permissions:** You need **insights.view** to see commission reports. If the subsection is missing, ask an admin.

1. Unlock **Staff** with your staff code if prompted.
2. Open **Staff** → **Commissions** → **Reports**.
3. Set the **date range** (or use presets), then **Refresh** to load the report.
4. Pick a staff member for individual drilldown, or leave staff blank for all-staff reporting.
5. Expand a staff row and use **Trace** when you need line-level calculation context.

Fixed SPIFF and combo incentives are managed under **Staff** → **Commissions** → **SPIFFs & Combos**. Staff base commission rates are set on each Staff Profile.

---

## Troubleshooting

| Symptom | What to try |
|--------|----------------|
| Blank or gray iframe | Metabase service may be down, or the store proxy is off — contact IT. |
| Metabase login loop or broken links | **Site URL** in Metabase admin must match how staff open the store (including **`/metabase`** if you use that path). |
| 404 or “proxy disabled” | Server ops may have turned off the Metabase upstream — see **DEVELOPER.md** (Metabase section). |
| Cannot see **Commission reports** | You need **insights.view**. |

---

## Related POS reporting

**POS → Reports** (inside **POS** mode) is for **register session** snapshots (tenders, cash context). It is **not** the same as **Back Office Insights**. **Back Office → Reports** offers **fixed** sales and margin pivots and related tiles (see **Help → Reports (curated)**). **Custom** dashboards and deep exploration use **Metabase** here under **Insights**.

**RMS / R2S** charge and payment history for operations is also available under **Customers → RMS charge** and in **POS → Reports** for session-scoped views; see **`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`**.

---

## See also

- **`docs/PLAN_METABASE_INSIGHTS_EMBED.md`** — architecture, proxy, Phase 2 reporting views (planned).
- **`docs/STAFF_PERMISSIONS.md`** — **insights.view**, **staff.manage_commission**.
- **`docs/AI_REPORTING_DATA_CATALOG.md`** — API catalog for **`/api/insights/*`** (operational reads; not a substitute for Metabase exploration).
- **Staff guide (longer):** **`docs/staff/insights-back-office.md`**
