# Insights (Metabase) and commission payouts

**Audience:** Owners, managers, accountants, and anyone with reporting or payout permissions.

**Where in ROS**

- **Back Office → Reports** — **curated** read-only reports (sales and margin pivots, register exports, tax audit, wedding health, best sellers, and more) backed by **`/api/insights/*`**. Same tab uses **`insights.view`**; **Margin pivot** is **Admin role only**. Use **Open Insights (Metabase)** in this workspace for deep exploration. **Staff manual:** **[reports-curated-manual.md](reports-curated-manual.md)**. **Admin / store policy:** **[reports-curated-admin.md](reports-curated-admin.md)**.
- **Back Office → Insights** — opens the **Insights shell**: thin Riverside header plus a **full-page Metabase** iframe (same site, path **`/metabase/`** behind the scenes). There are **no** Insights subsections in the sidebar.
- **Back Office → Staff → Commissions → Payouts** — **commission ledger** and **finalize payout** (Riverside UI, not Metabase).

**Related permissions**

- **Reports tab:** **insights.view** (plus **Admin** for margin pivot)
- **Insights tab:** **insights.view**
- **Staff → Commissions → Payouts:** **insights.view** **and** **insights.commission_finalize**
- **Staff → Commissions → Rates / Rules & SPIFFs:** **staff.manage_commission**

**In-app Help:** open **Help** in the header — **Reports (curated)** (`reports-manual.md`) and **Insights (Metabase)** (`insights-manual.md`).

---

## Staff Metabase login vs admin Metabase login

**Riverside** only checks **`insights.view`** to show **Insights**. **Metabase** uses its **own** username and password (or SSO if your store enabled JWT on paid Metabase).

**Store standard:** Maintain **two classes** of Metabase user:

- **Staff** — access **staff-safe** dashboards and collections only (typically **no** margin, **no** cost columns, **no** private exploratory folders unless leadership allows).
- **Admin** — full reporting in Metabase, including **margin** and sensitive cuts on **`reporting.*** views.

Give **staff-class** Metabase credentials to floor teams; reserve **admin-class** credentials for owners, finance, and IT. **Do not** use one shared “everyone” Metabase login if margin must stay private. Full ops checklist: **[METABASE_REPORTING.md](../METABASE_REPORTING.md)**.

**Back Office → Reports** is separate: **Margin pivot** there is gated by **Riverside Admin role** on the API, not by which Metabase user you use.

---

## How to use Insights (Metabase)

**Purpose:** Deep analytics — questions, dashboards, and (when enabled) SQL — using **Metabase’s** interface inside Riverside.

1. Select **Insights** in the left rail. The normal Back Office layout is replaced by the **Insights** shell.
2. If Riverside shows a warning that automatic sign-in is unavailable, continue into the normal Metabase sign-in screen. This means the station fell back to standard Metabase login for this session.
3. If Metabase asks you to **log in**, use the **Metabase username** you were assigned (**staff** or **admin** class per store policy). Riverside staff sign-in does **not** pass through to Metabase unless IT enabled optional JWT handoff.
4. Work in Metabase as trained (filters, time ranges, collections your Metabase admins configured for **your** login).
5. Use **Back to Back Office** in the top bar when finished.

**Same browser:** Metabase keeps its own session. Log out of Metabase when switching between **staff** and **admin** Metabase identities on a shared PC, or use separate browser profiles per policy.

---

## Commissions → Payouts (Staff workspace)

**Purpose:** **Finalize** realized commission for selected staff (and optional **unassigned** lines) for a date window. This is **payroll-sensitive**.

1. **Staff** → **Commissions** → **Payouts** (unlock **Staff** with your code if prompted).
2. Set **From** / **To** (or use **Last 14 days**, **Prior 14 days**, or **Prior month payroll**), then **Refresh**.
3. Optional: pick a **Staff** member to run a staff-level report even if the summary ledger is empty.
4. Review **Realized (pending)** amounts for the recognition window. Riverside uses **fulfillment / pickup / shipping recognition**, not booking, for payout timing.
5. Select rows you are paying, confirm **Selected pending payout**, then **Finalize payout** and complete the confirmation modal.

### Effective-dated commission changes

- Staff base commission changes now require a **start date**.
- Riverside can reconcile **eligible unfinalized** commission lines from that date.
- Finalized payouts stay locked.
- Salesperson attribution changes continue to recalculate immediately for eligible unfinalized lines.

**Category commission rates** (per product category) are edited under **Staff** → **Commissions** → **Rates** — not here.

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
| No **Payouts** tab inside **Commissions** | Need **insights.view** and **insights.commission_finalize** | Admin |
| Cannot finalize | Nothing selected or zero pending; or missing finalize permission | Owner |

---

## When to get a manager

- **Payroll** disputes after finalize.
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

**Last reviewed:** 2026-04-21
