# Reports (curated) — admin and functional guide

**Audience:** **Store administrators**, owners, and IT implementing **Riverside OS** reporting policy.

**Purpose:** Run the **Back Office → Reports** workspace safely: **who sees what**, how **basis** works, where **margin** is restricted, and how this surface relates to **Metabase** and the **`reporting.*`** schema.

**Staff-facing walkthrough:** **[reports-curated-manual.md](reports-curated-manual.md)**

---

## Product shape

- **Reports** = fixed tile grid + detail pane; each tile maps to **one** HTTP surface (mostly **`GET /api/insights/*`**, plus **`GET /api/customers/rms-charge/records`** for the CRM-shaped tile). Catalog lives in **`client/src/lib/reportsCatalog.ts`**.
- **Insights** = **`InsightsShell`** + Metabase iframe; exploratory analytics and **separate** Metabase RBAC.
- **Non-goals:** No second SPA; no commission **finalize** inside Reports (that stays **Staff → Commission payouts** with **insights.commission_finalize**).

---

## RBAC matrix (Curated Reports v1)

Effective rule: for each **`ReportDef`**, **`reportVisible`** requires **`adminOnly` → `staffRole === admin`** (from **`GET /api/staff/effective-permissions`**), then **every** key in **`permissionsAll`**, optionally **`permissionsAny`** if used.

| Catalog `id` (implementation) | Required permissions | Admin-only |
|------------------------------|----------------------|------------|
| `sales_pivot` | **insights.view** | No |
| `margin_pivot` | **insights.view** | **Yes** (role **admin**) |
| `best_sellers` | **insights.view** | No |
| `dead_stock` | **insights.view** | No |
| `wedding_health` | **insights.view** | No |
| `commission_ledger` | **insights.view** | No |
| `nys_tax_audit` | **insights.view** | No |
| `staff_performance` | **insights.view** | No |
| `rms_charges` | **insights.view** | No |
| `rms_charge_crm` | **customers.rms_charge** | No |
| `register_sessions` | **insights.view** | No |
| `register_override_mix` | **insights.view** | No |
| `register_day_activity` | **register.reports** | No |
| `wedding_saved_views` | **insights.view** | No |

Server routes must enforce the **same** rules as today (margin pivot **Admin** on the API, not only UI). NL or AI tooling must treat **margin** as restricted; see **`docs/AI_REPORTING_DATA_CATALOG.md`**.

**Sidebar tab gate:** **`reports`** tab visibility uses **insights.view** in **`SIDEBAR_TAB_PERMISSION`** (`BackofficeAuthContext.tsx`). Users **without** that key should not see the tab.

---

## Booked vs recognition (basis)

Many tiles pass **`basis`** (`booked` vs `completed` / recognition). Store policy and definitions are documented in **[REPORTING_BOOKED_AND_RECOGNITION.md](../REPORTING_BOOKED_AND_RECOGNITION.md)**. Train managers on which basis to use before **payroll** or **tax** discussions.

---

## Margin and cost (sensitive)

- **Margin pivot** uses pre-tax revenue minus **COGS** from **line unit cost × quantity** frozen at checkout (server **`margin_pivot`** logic). Only **Admin** staff see the tile; **non-Admin** callers must get **403** from **`GET /api/insights/margin-pivot`**.
- **Metabase (Insights)** does **not** inherit Riverside Admin vs salesperson. Use **separate Metabase logins**: a **staff-class** Metabase user (limited collections, no margin / private cuts) and an **admin-class** Metabase user (full reporting including **`reporting.order_lines`** margin columns — migration **107**). Anyone with **`insights.view`** can open the Insights shell; **which Metabase account they use** determines sensitive data access. **[METABASE_REPORTING.md](../METABASE_REPORTING.md)** § Operational standard.

---

## Metabase vs curated Reports

| Concern | Curated Reports | Metabase |
|--------|-----------------|----------|
| RBAC | Riverside **staff permissions** + **Admin** role | Metabase **user / group** model |
| Margin | **Admin** Riverside role in app | **Admin Metabase login** + groups/collections in Metabase |
| Change control | Tile list is **code + catalog**; ship with PR | Questions/dashboards per **ops** process |

---

## Operational tasks

1. **Grant** **insights.view** to roles that should see **Reports** (and **Insights** tab).
2. **Grant** **register.reports** if managers need **Register day activity** in Back Office (they may already have it for Z / operations).
3. **Grant** **customers.rms_charge** for CRM-aligned **RMS charge records** tile (aligns with **Customers → RMS charge**).
4. **Confirm** E2E / training staff: **Playwright** **`reports-workspace.spec.ts`** expects migration **53** admin **`1234`** for margin visibility in CI; **`api-gates`** uses **`seed_e2e_non_admin_staff.sql`** for **403** on margin — see **`docs/E2E_REGRESSION_MATRIX.md`**.

---

## When to extend the catalog

1. Add or adjust **`ReportDef`** in **`reportsCatalog.ts`** (path builder, `permissionsAll`, `adminOnly`, response kind).
2. Document the route in **`docs/AI_REPORTING_DATA_CATALOG.md`** (Curated Reports table + main API tables).
3. Add **Playwright** coverage if the tile is **safety-critical** (financial / margin).
4. Add a line to **`docs/staff/reports-curated-manual.md`** tile table for trainers.

---

## See also

- **[PLAN_METABASE_INSIGHTS_EMBED.md](../PLAN_METABASE_INSIGHTS_EMBED.md)** (architecture)
- **[AI_REPORTING_DATA_CATALOG.md](../AI_REPORTING_DATA_CATALOG.md)**
- **[METABASE_REPORTING.md](../METABASE_REPORTING.md)**
- **`client/src/components/reports/ReportsWorkspace.tsx`**
- **`docs/E2E_REGRESSION_MATRIX.md`**

**Last reviewed:** 2026-04-08
