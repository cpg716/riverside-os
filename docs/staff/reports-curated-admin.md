# Reports (curated) — admin and functional guide

**Audience:** **Store administrators**, owners, and IT implementing **Riverside OS** reporting policy.

**Purpose:** Run the **Back Office → Reports** workspace safely: **who sees what**, how **basis** works, where **margin** is restricted, how staff search by task/question, and how this surface relates to **Metabase** and the **`reporting.*`** schema.

**Staff-facing walkthrough:** **[reports-curated-manual.md](reports-curated-manual.md)**

---

## Product shape

- **Reports** = fixed tile grid + detail pane + client-side search index. Available tiles map to **one** HTTP surface (mostly **`GET /api/insights/*`**, plus **`GET /api/customers/rms-charge/records`** for the CRM-shaped tile). Planned tiles are catalog-only and do not call the server. Catalog lives in **`client/src/lib/reportsCatalog.ts`**.
- **Insights** = **`InsightsShell`** + Metabase iframe; exploratory analytics and **separate** Metabase RBAC.
- **Non-goals:** No second SPA; commission reporting stays under **Staff → Commissions → Reports** for staff-level review.

## Search metadata

Each **`ReportDef`** carries staff-facing discovery metadata:

- **`category`**: **Sales**, **Inventory**, **Register**, **Weddings**, **Customers**, **Finance**, **Staff**, or **Operations**.
- **`keywords`**: plain-language search terms such as **tax**, **drawer**, **cash**, **pickup**, **balance**, **slow stock**, **open orders**, **no-show**, or **appointments**.
- **`questions`**: natural staff questions such as **What sold best last month?** or **Who still owes money?**
- **`audience`**: **Staff**, **Manager**, **Owner**, or **Admin**.
- **`sensitivity`**: **Staff-safe**, **Manager**, or **Admin-only**.

The workspace performs weighted client-side matching against title, description, category, keywords, questions, and audience. It does not use AI, Meilisearch, or backend search.

---

## RBAC matrix (Curated Reports v1)

Effective rule: for each **`ReportDef`**, **`reportVisible`** requires **`adminOnly` → `staffRole === admin`** (from **`GET /api/staff/effective-permissions`**), then **every** key in **`permissionsAll`**, optionally **`permissionsAny`** if used.

| Catalog `id` (implementation) | Staff-facing title | Required permissions | Admin-only | Status |
|------------------------------|--------------------|----------------------|------------|--------|
| `sales_pivot` | **Sales Breakdown** | **insights.view** | No | Available |
| `margin_pivot` | **Margin & Cost Breakdown** | **insights.view** | **Yes** (role **admin**) | Available |
| `best_sellers` | **Best Sellers** | **insights.view** | No | Available |
| `dead_stock` | **Slow Stock** | **insights.view** | No | Available |
| `wedding_health` | **Wedding Pipeline** | **insights.view** | No | Available |
| `commission_ledger` | **Commission Snapshot** | **insights.view** | No | Available |
| `nys_tax_audit` | **New York Tax Audit** | **insights.view** | No | Available |
| `staff_performance` | **Staff Sales Performance** | **insights.view** | No | Available |
| `rms_charges` | **RMS Charge Summary** | **insights.view** | No | Available |
| `rms_charge_crm` | **Customer RMS Charge Records** | **customers.rms_charge** | No | Available |
| `register_sessions` | **Closed Register Drawers** | **insights.view** | No | Available |
| `register_override_mix` | **Discount & Override Reasons** | **insights.view** | No | Available |
| `register_day_activity` | **Register Day Summary** | **register.reports** | No | Available |
| `wedding_saved_views` | **Saved Wedding Report Views** | **insights.view** | No | Available |
| `merchant_activity` | **Card Processing Summary** | **insights.view** | No | Available |
| `appointments_no_show` | **Appointments & No-Show Report** | **insights.view** | No | Available |
| `wedding_event_readiness` | **Wedding Event Readiness Report** | **insights.view** | No | Available |
| `staff_schedule_coverage_sales` | **Staff Schedule Coverage vs Sales Report** | **insights.view** | No | Available |
| `customer_follow_up` | **Customer Follow-Up Report** | **insights.view** | No | Available |
| `exception_risk` | **Exception & Risk Report** | **insights.view** | No | Available |

Server routes must enforce the **same** rules as today (margin pivot **Admin** on the API, not only UI). NL or AI tooling must treat **margin** as restricted; see **`docs/AI_REPORTING_DATA_CATALOG.md`**.

New report tiles must not point at placeholder SQL or fake endpoints. Keep future roadmap tiles catalog-only until a real report endpoint is approved and implemented.

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

## New endpoint coverage

The five operational reports added after the original v1 catalog are backed by real read-only endpoints:

| Route | Report |
|-------|--------|
| `GET /api/insights/appointments-no-show` | **Appointments & No-Show Report** |
| `GET /api/insights/wedding-event-readiness` | **Wedding Event Readiness Report** |
| `GET /api/insights/staff-schedule-coverage-sales` | **Staff Schedule Coverage vs Sales Report** |
| `GET /api/insights/customer-follow-up` | **Customer Follow-Up Report** |
| `GET /api/insights/exception-risk` | **Exception & Risk Report** |

All five require **insights.view** and accept the standard curated Reports date window when the tile shows From / To.

---

## Operational tasks

1. **Grant** **insights.view** to roles that should see **Reports** (and **Insights** tab).
2. **Grant** **register.reports** if managers need **Register day activity** in Back Office (they may already have it for Z / operations).
3. **Grant** **customers.rms_charge** for CRM-aligned **RMS charge records** tile (aligns with **Customers → RMS charge**).
4. **Confirm** E2E / training staff: **Playwright** **`reports-workspace.spec.ts`** expects migration **53** admin **`1234`** for margin visibility in CI; **`api-gates`** uses **`seed_e2e_non_admin_staff.sql`** for **403** on margin — see **`docs/E2E_REGRESSION_MATRIX.md`**.

---

## When to extend the catalog

1. Add or adjust **`ReportDef`** in **`reportsCatalog.ts`** (path builder, `permissionsAll`, `adminOnly`, response kind).
2. Add category, keywords, questions, audience, and sensitivity metadata.
3. If the tile is planned, set `status: "planned"` and explain the missing endpoint in `plannedReason`.
4. Document available routes in **`docs/AI_REPORTING_DATA_CATALOG.md`** (Curated Reports table + main API tables).
5. Add **Playwright** coverage if the tile is **safety-critical** (financial / margin).
6. Add a line to **`docs/staff/reports-curated-manual.md`** tile table for trainers.

---

## See also

- **[PLAN_METABASE_INSIGHTS_EMBED.md](../PLAN_METABASE_INSIGHTS_EMBED.md)** (architecture)
- **[AI_REPORTING_DATA_CATALOG.md](../AI_REPORTING_DATA_CATALOG.md)**
- **[METABASE_REPORTING.md](../METABASE_REPORTING.md)**
- **`client/src/components/reports/ReportsWorkspace.tsx`**
- **`docs/E2E_REGRESSION_MATRIX.md`**

**Last reviewed:** 2026-05-01
