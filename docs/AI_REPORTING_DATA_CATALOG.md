# AI and natural-language reporting — data source catalog (Riverside OS)

**Status:** Canonical route and permission catalog for curated Reports, NL reporting, and reporting executors. For the reporting doc map, start at [`REPORTING.md`](REPORTING.md). For the AI / ROSIE doc map, start at [`AI.md`](AI.md).

This document lists **data sources** a **staff-facing, RBAC-gated** **natural language reporting** feature could use to answer questions, build **tables**, or suggest **charts**. It is the **specification target** for a future **`POST /api/ai/reports/*`** BFF in [`ROS_AI_INTEGRATION_PLAN.md`](../ROS_AI_INTEGRATION_PLAN.md) Pillar 4 — **that route family is not implemented in `server/` yet**; today’s executors (human or agent) should map intents to the **whitelisted `GET /api/insights/*`** and **`reporting.*`** views below, with the **same RBAC** as a direct REST call. **Every source used in production NL specs must be labeled for role access** per **§ RBAC labeling contract** below.

**Companion (all AI personas):** For **intent routing** (procedure vs metric vs permission vs **ROSIE** planning), **live store SOP** (`GET /api/staff/store-sop`), and **safe answering rules**, read [**`AI_CONTEXT_FOR_ASSISTANTS.md`**](AI_CONTEXT_FOR_ASSISTANTS.md) first. **This catalog** is the **API-level** map: whitelisted **GET** surfaces, curated **Reports** tiles, and Metabase **`reporting.*`** context — not a substitute for **`docs/staff/*`** procedure guides or **[`GET /api/help/search`](AI_CONTEXT_FOR_ASSISTANTS.md)** (procedures in **`ros_help`** when Meilisearch is configured; empty hits when not).

**Safety (non-negotiable):** The model must **not** emit arbitrary SQL. Interpretation should map to a **versioned, whitelisted report spec** executed by existing Rust + PostgreSQL + `rust_decimal` paths. Money and aggregates stay **server-computed**; the AI may **narrate** structured JSON only.

**Financial Integrity Invariants:**
- **Variable Shadowing**: When implementing or narrating checkout logic, ensure `transaction_id` (Retail Sale) and `payment_tx_id` (Movement) remain distinct to preserve `payment_allocations` integrity.
- **Tax Category Casing**: NYS tax exemption ($110 threshold for Clothing/Footwear) is **case-insensitive**. Report specs must treat "Clothing" and "clothing" as identical to maintain parity with POS/Server logic.

**Primary staff analytics UI (2026):** Interactive exploration and dashboards for most reporting are **Metabase** inside **Back Office → Insights** (same-origin **`/metabase/`** iframe). **`GET /api/insights/*`** remains for **operational** reads (commission ledger, register/RMS exports, wedding saved views, etc.), **Back Office → Reports**, **Customers → RMS charge**, and NL-reporting executors — not as a parallel full chart UI. **Phase 2 (migrations 90+):** PostgreSQL schema **`reporting`** — **`orders_core`**, **`order_lines`** (migration **107/123**: checkout-frozen **`unit_cost`**, **`line_extended_cost`**, **`line_gross_margin_pre_tax`** — aligned with **`GET /api/insights/margin-pivot`**), **`daily_order_totals`**, **`layaway_snapshot`** (operational status + balance tracking — migration **123**), **`loyalty_customer_snapshot`** (flattened names/phone/metrics), **`loyalty_daily_velocity`** (velocity charts). DB role **`metabase_ro`** has access to these human-readable views. All order-grain views include **`order_short_id`** (first 8 chars of UUID) and **`customer_phone`** / **`customer_email`** for direct readability.

**AI never changes operational data:** NL reporting and any ROS-AI **data** path must be **read-only** with respect to **business / transactional** tables (orders, customers, inventory, payments, weddings, ledger, etc.). Executors may run **SELECT**-shaped (or equivalent read) logic already used by Insights; they must **not** INSERT/UPDATE/DELETE store data as a side effect of chat or interpret. **Saving a report spec** is **metadata** (how to re-run reads), not a mutation of source records—see [`ROS_AI_INTEGRATION_PLAN.md`](../ROS_AI_INTEGRATION_PLAN.md) design principles.

**Permissions (summary):** The **AI gateway** must enforce the **same** keys and composite auth patterns as the REST handlers. Prefer **`insights.view`** for analytics-shaped reads, **`settings.admin`** for backups/stats, **`orders.view`** for order detail, **`catalog.view`** / **`procurement.view`** for inventory and PO lists, **`weddings.view`** for wedding aggregates, and **`staff.view`** for roster/schedule. **Authoritative maintenance rules** — required keys per domain, drift policy, and spec mapping — are in **§ RBAC labeling contract** (do not rely on this paragraph alone when implementing executors).

**Note on `GET /api/insights/sales-pivot`:** The handler now **`require_staff_with_permission`** with **`insights.view`** (same as most other `/api/insights/*` reads). NL and BFF layers must still pass staff credentials.

**Canonical router map:** [`server/src/api/mod.rs`](../server/src/api/mod.rs) (`build_router`). **§0** lists **staff-facing read nests** used for reporting, CRM depth, Metabase parity, **Curated Reports**, and **in-app Help** ( **`/api/help/*`** ). It is a **maintained checklist**, not a generated OpenAPI dump — validate with **`python3 scripts/scan_axum_get_routes_hint.py`** and `build_router` when adding routes. **POST**-only actions (finalize commission, QBO sync, checkout, etc.) are summarized under **§15** and are **out of scope** for passive NL “scrape” executors.

### ROSIE (`PLAN_LOCAL_LLM_HELP.md`) — how this catalog is consumed

**ROSIE** (**RiversideOS Intelligence Engine**) uses this file as the **executable allowlist** for numeric/analytic tools:

- **`reporting_run`** (or equivalent) **`spec_id`** values **must** resolve to **one** row in **§0 Curated Reports** (`report_id` ↔ `GET` path) or to another **§0** GET row with an explicitly documented internal alias in server-side tool registry code.
- **Parameters** passed to the executor **must** be a subset of the query keys described in §0 for that route (e.g. **`basis`**, **`from`**, **`to`**, **`group_by`**, **`limit`**). Reject unknown keys.
- **§15** is the **training / prompt** supplement for **`basis`**, booked vs fulfilled, truncation, and NL → route mapping — keep it synchronized when insights handlers change.
- **Constitution** (routing, refusal, RBAC posture, **§13 ROSIE contract** incl. **§13.6** governed learning) lives in [**`AI_CONTEXT_FOR_ASSISTANTS.md`**](AI_CONTEXT_FOR_ASSISTANTS.md); **architecture** (sidecar, Tauri, voice, tool **names**, **controlled learning** matrix) in [**`PLAN_LOCAL_LLM_HELP.md`**](PLAN_LOCAL_LLM_HELP.md). All three documents are a **versioned bundle** — bump **`POLICY_PACK_VERSION`** when any of them change materially.
- **Learning:** When **§0** / **§15** or Curated **`report_id`** rows change, refresh **RAG chunks** and any **instruction** data derived from this file — do **not** teach new routes from raw DB introspection alone.

---

## RBAC labeling contract (catalog maintenance)

**Goal:** Any NL reporting executor, and a future **`POST /api/ai/reports/*`** gateway when implemented, must **not** expand access beyond what the same staff member could get by calling the API directly ([`ROS_AI_INTEGRATION_PLAN.md`](../ROS_AI_INTEGRATION_PLAN.md) — RBAC parity). This catalog is the **working map** from **routes and domains** to **effective access** for NL reporting.

### Rules

0. **Read-only operational data** — Catalogued routes used by NL executors are **GET** / read-shaped for a reason: the AI layer **must not** widen them into writes. If a feature needs a **POST** (e.g. commission finalize), it stays **outside** autonomous AI execution—staff use normal UI/API with explicit confirmation.
1. **Explicit permission keys** — When a handler uses `require_staff_with_permission`, document the **exact** key string from [`server/src/auth/permissions.rs`](../server/src/auth/permissions.rs) (e.g. **`insights.view`**, **`catalog.view`**). Use inline **`backticks`** in tables for machine-stable names.
2. **Composite auth** — When a route uses **staff headers only**, **staff or open POS register session**, **per-order read auth**, or custom logic, say so explicitly (e.g. **“staff or POS session”**, **“same as order detail”**) so the AI executor reuses the **same middleware/helpers**, not a looser internal path.
3. **Admin-only, unauthenticated, M2M** — Mark **Admin role only** (e.g. legacy cost/margin-only surfaces), **no staff auth in handler today**, or **machine token (`COUNTERPOINT_SYNC_TOKEN`)** so implementers do not accidentally expose aggregates.
4. **Drift control** — Any new **`GET`** (or read-shaped) route in `build_router` must update this doc **in the same PR** with access labeling. Sources marked **TBD** or missing keys stay **out of the executed whitelist** until fixed.
5. **Spec ↔ catalog** — Each **versioned report spec** field (metric, `group_by`, backing route id) should **point at** one or more catalog rows; at execution time the server checks **every** permission attached to those rows (per **§13**). If a phrase implies a slice the user cannot access, return **403** or a **trimmed** spec — see plan.

### Quick reference — data domain → typical access

| Data domain | Typical permission / pattern | Where detailed |
|-------------|------------------------------|----------------|
| Insights / pivots | **`insights.view`**; finalize = **`insights.commission_finalize`** (POST) | §0 `/api/insights/*`, §1 |
| Orders / refunds | **`orders.view`**, **`orders.refund_process`**; some reads need register session | §0 `/api/transactions/*`, §2 |
| Register / sessions | **`register.reports`** + session rules | §0 `/api/sessions/*`, §2 |
| Customers (browse, hub, …) | Authenticated **staff** or **open POS session** (`require_customer_access`) for many reads/creates; sensitive writes use **`customers.merge`**, **`customers_duplicate_review`**, **`customer_groups.manage`**, **`store_credit.manage`** | §0 `/api/customers/*`, §5–7 |
| Catalog / products | **`catalog.view`**, **`catalog.edit`** (mutations) | §0 `/api/products/*`, §3 |
| Procurement / POs | **`procurement.view`**, **`procurement.mutate`** | §0 `/api/purchase-orders/*`, §3 |
| Vendors | Usually alongside **`catalog.view`** / procurement | §0 `/api/vendors/*`, §3 |
| Physical inventory | **`physical_inventory.view`** (+ mutate keys for writes) | §0 `/api/inventory/physical/*`, §3 |
| Weddings | **`weddings.view`** for dashboard-style reads | §0 `/api/weddings/*`, §6 |
| Staff / schedule / roster | **`staff.view`**, **`staff.view_audit`**, schedule endpoints as routed | §0 `/api/staff/*` |
| Tasks | **`tasks.manage`**, **`tasks.view_team`**; self **`/api/tasks/me`** | §0 `/api/tasks/*` |
| Notifications | **`notifications.view`** | §0 `/api/notifications/*` |
| Alterations | **`alterations.manage`** | §0 `/api/alterations/*` |
| Gift cards | **`gift_cards.manage`** | §0 `/api/gift-cards/*` |
| Loyalty | **`loyalty.program_settings`**; ledger may allow POS session | §0 `/api/loyalty/*` |
| Settings / backups / DB stats | **`settings.admin`** | §0 `/api/settings/*` |
| QBO read surfaces | Match **each** route’s middleware in router (sensitive) | §0 `/api/qbo/*` |
| Counterpoint health | **M2M** — not default staff NL | §0 `/api/sync/counterpoint/*` |
| Shipments (Shippo hub) | **`shipments.view`** (list/detail); **`shipments.manage`** (create, rates, label, notes) | §0 `/api/shipments/*`, [`SHIPPING_AND_SHIPMENTS_HUB.md`](SHIPPING_AND_SHIPMENTS_HUB.md) |

**Role assignment:** which keys each **role** gets is documented in [**`STAFF_PERMISSIONS.md`**](STAFF_PERMISSIONS.md). **Admin** implies the full permission catalog in ROS; other roles only receive keys from **`staff_role_permission`** plus overrides.

---

## 0. Exhaustive read inventory by API nest

Use this section as a **checklist**: every nest under `/api/*` should appear here. If you add a new `GET` route, update this doc in the same PR.

**Column convention:** Prefer **`Permission / access`** (or merge permission + notes into one column) so **role access** is visible on every row. Where a table still uses **Notes** only, resolve access using **§ RBAC labeling contract** and the **Quick reference** table above; tighten the row when you touch that nest.

### Curated Reports v1 (Back Office UI)

The **Reports** sidebar tab ([`client/src/components/reports/ReportsWorkspace.tsx`](../client/src/components/reports/ReportsWorkspace.tsx)) surfaces a **fixed library** mapped in [`client/src/lib/reportsCatalog.ts`](../client/src/lib/reportsCatalog.ts). Each tile calls **one** documented route below (no duplicate SQL). **Finalize** commission remains **Staff → Commission payouts**; **lane register stories** link to **Operations → Register reports**.

| Report id | Backing route(s) | Permission notes |
|-----------|------------------|------------------|
| `sales_pivot` | `GET /api/insights/sales-pivot` | **`insights.view`** |
| `margin_pivot` | `GET /api/insights/margin-pivot` | **Admin role** only |
| `best_sellers` | `GET /api/insights/best-sellers` | **`insights.view`** |
| `dead_stock` | `GET /api/insights/dead-stock` | **`insights.view`** |
| `wedding_health` | `GET /api/insights/wedding-health` | **`insights.view`** |
| `commission_ledger` | `GET /api/insights/commission-ledger` | **`insights.view`** (read snapshot; finalize elsewhere) |
| `nys_tax_audit` | `GET /api/insights/nys-tax-audit` | **`insights.view`** |
| `staff_performance` | `GET /api/insights/staff-performance` | **`insights.view`** |
| `rms_charges` | `GET /api/insights/rms-charges` | **`insights.view`** |
| `rms_charge_crm` | `GET /api/customers/rms-charge/records` | **`customers.rms_charge`** |
| `register_sessions` | `GET /api/insights/register-sessions` | **`insights.view`** |
| `register_override_mix` | `GET /api/insights/register-override-mix` | **`insights.view`** |
| `register_day_activity` | `GET /api/insights/register-day-activity` | **`register.reports`** (store-wide) |
| `wedding_saved_views` | `GET /api/insights/wedding-saved-views` (plus **`POST`** create / **`DELETE …/{id}`** in UI) | **`insights.view`** |

### `/api/help/*` (Help Center — procedures, not sales pivots)

| Method | Path | Permission / notes |
|--------|------|---------------------|
| GET | `/api/help/search` | **`require_help_viewer`**: authenticated **staff headers** **or** **valid open register session** (POS token headers). Query **`q`** (required text), **`limit`** (default 12). Returns **`{ "hits": [] }`** when **Meilisearch** is not configured on the server. Hits filtered by **`help_manual_policy`** and POS-only mode — see [`PLAN_HELP_CENTER.md`](../PLAN_HELP_CENTER.md). |
| GET | `/api/help/manuals` | Same viewer — visible manual list for the drawer. |
| GET | `/api/help/manuals/{manual_id}` | Same viewer — one manual body for display. |
| GET | `/api/help/admin/manuals` | **`help.manage`** — catalog for Settings overrides. |
| GET | `/api/help/admin/manuals/{manual_id}` | **`help.manage`** |
| PUT | `/api/help/admin/manuals/{manual_id}` | **`help.manage`** — replace manual markdown / policy (**write** — outside NL read whitelist). |
| DELETE | `/api/help/admin/manuals/{manual_id}` | **`help.manage`** |

**NL reporting:** Do **not** answer “how do I void a sale?” from **`/api/insights/*`** alone; pair **help search** + [**`docs/staff/*`**](staff/README.md) per [**`AI_CONTEXT_FOR_ASSISTANTS.md`**](AI_CONTEXT_FOR_ASSISTANTS.md).

### `/api/insights/*`

| Method | Path | Permission / notes |
|--------|------|---------------------|
| GET | `/api/insights/metabase-launch` | **`insights.view`**. Query **`return_to`** (default **`/metabase/`**). Returns **`iframe_src`** for the Insights iframe (static **`/metabase/`** or JWT SSO URL when **`insights_config`** + secret allow) — [**`METABASE_REPORTING.md`**](METABASE_REPORTING.md). |
| POST | `/api/insights/metabase-launch` | Same — JSON body **`{ "return_to": "..." }`**. |
| GET | `/api/insights/sales-pivot` | **`insights.view`**. Query: **`basis`** (`booked`/`sale`/… vs `fulfilled`/`pickup`/… — fulfillment uses pickup **`fulfilled_at`** or ship **`shipment_event`**; see [**`docs/REPORTING_BOOKED_AND_FULFILLED.md`**](REPORTING_BOOKED_AND_FULFILLED.md)), **`group_by`**, **`from`**, **`to`**. |
| GET | `/api/insights/margin-pivot` | **Admin role only** (staff headers + PIN). Same **`group_by`**, **`basis`**, **`from`**, **`to`** as sales-pivot. Rows add **`cost_of_goods`** (`SUM(unit_cost × qty)` frozen at checkout), **`gross_margin`** (pre-tax revenue − COGS), **`margin_percent`** (margin ÷ pre-tax revenue × 100). |
| GET | `/api/insights/commission-ledger` | **`insights.view`**. **Unpaid** = booked window on open lines; **fulfilled/paid** = **fulfillment** window on fulfilled lines (`from`/`to`). |
| GET | `/api/insights/nys-tax-audit` | **`insights.view`**. **`from`**, **`to`** only — always **fulfillment** date (fulfilled revenue), not booked. |
| GET | `/api/insights/staff-performance` | **`insights.view`**. Optional **`basis`** for 7-day revenue momentum (booked vs fulfilled). |
| GET | `/api/insights/register-sessions` | **`insights.view`** |
| GET | `/api/insights/register-day-activity` | **`register.reports`** (store-wide) or **open register session** (lane-scoped). Query: **`preset`**, **`from`**, **`to`**, **`register_session_id`**, **`basis`** (booked vs fulfilled). |
| GET | `/api/insights/rms-charges` | **`insights.view`**. Query: **`from`**, **`to`** (optional UTC **`NaiveDate`**; inclusive start, exclusive end — same semantics as other insights date ranges; default window **90 days** through tomorrow UTC). Returns up to **500** rows from **`pos_rms_charge_record`** with **`record_kind`** (**`charge`** = RMS/RMS90 tender, **`payment`** = cash/check collection on **RMS CHARGE PAYMENT** line) plus order/customer context (`payment_method`, `amount`, `order_short_ref`, `customer_display` / live name, etc.). **UI:** aggregate export for **Metabase** / integrations; register-scoped views use **POS → Reports**; filtered lists use **Customers → RMS charge** (**`GET /api/customers/rms-charge/records`**, **`customers.rms_charge`**). See [**`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`**](POS_PARKED_SALES_AND_RMS_CHARGES.md). |
| GET | `/api/insights/register-override-mix` | **`insights.view`**. Optional **`basis`** + date range (booked vs fulfilled for price-override line counts). |
| GET | `/api/insights/wedding-health` | **`insights.view`**. Aggregate wedding pipeline counts (event in next 30 days, members without order, open balances). |
| GET | `/api/insights/wedding-saved-views` | **`insights.view`** — list saved filter JSON for wedding tooling. |
| POST | `/api/insights/wedding-saved-views` | **`insights.view`** — create saved view (**mutation**; not passive reporting). |
| DELETE | `/api/insights/wedding-saved-views/{id}` | **`insights.view`** — delete saved view. |
| GET | `/api/insights/best-sellers` | **`insights.view`**. Query: **`from`**, **`to`**, **`basis`** (booked vs fulfilled — same as sales pivot), **`limit`** (default 100, max 500). Response: **`rows`** with **`variant_id`**, **`units_sold`**, **`net_sales`** (pre-tax line revenue `unit_price * quantity`), **`avg_unit_price`**, etc. |
| GET | `/api/insights/dead-stock` | **`insights.view`**. Same date/`basis` params + **`limit`**; optional **`max_units_sold`** (default **0** — on-hand SKUs with at most that many units sold in the window). Response: **`rows`** with on-hand, reserved, **`units_sold_in_period`**, **`retail_value_on_hand`** (list at variant retail). |

### `/api/transactions/*`

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/transactions/` | List/filter orders (**`orders.view`**). |
| GET | `/api/transactions/refunds/due` | Refund queue (**`orders.refund_process`**). |
| GET | `/api/transactions/{transaction_id}` | Order detail + lines + tenders (read auth: BO or register session). |
| GET | `/api/transactions/{transaction_id}/audit` | **`order_activity_log`** (see §7). |
| GET | `/api/transactions/{transaction_id}/receipt.zpl` | Receipt ZPL (reporting less common; label/reprint use case). Optional query **`gift`**, **`transaction_line_ids`** (subset lines). |
| GET | `/api/transactions/{transaction_id}/receipt.html` | Merged Receipt Builder HTML (or placeholder if template unset). Same auth as order detail; optional **`register_session_id`**, **`gift`**, **`transaction_line_ids`**. |
| POST | `/api/transactions/{transaction_id}/receipt/send-email` | Podium **email** with inline HTML body; requires exported template. Body may include **`gift`**, **`transaction_line_ids`**. [**`docs/RECEIPT_BUILDER_AND_DELIVERY.md`**](RECEIPT_BUILDER_AND_DELIVERY.md). |
| POST | `/api/transactions/{transaction_id}/receipt/send-sms` | Podium **SMS** or **MMS** (optional **`png_base64`**); body may include **`gift`**, **`transaction_line_ids`**. [**`docs/RECEIPT_BUILDER_AND_DELIVERY.md`**](RECEIPT_BUILDER_AND_DELIVERY.md). |

### `/api/sessions/*`

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/sessions/current` | Active register session (staff or POS token). |
| GET | `/api/sessions/{id}/reconciliation` | Session reconciliation JSON. |
| GET | `/api/sessions/{id}/x-report` | X-report (**`register.reports`** + session rules). |

### `/api/staff/*` (includes `/api/staff/schedule/*`)

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/staff/effective-permissions` | Role, permissions, avatar (self). |
| GET | `/api/staff/self/pricing-limits` | Discount cap context for POS. |
| GET | `/api/staff/self/register-metrics` | Attributed sales for store day (**salesperson** / **sales_support** gating in logic). |
| GET | `/api/staff/list-for-pos` | Cashier picker / POS staff list. |
| GET | `/api/staff/store-sop` | Store **staff playbook** markdown (`store_settings.staff_sop_markdown`); any authenticated staff. |
| GET | `/api/staff/admin/access-log` | **`staff.view_audit`** |
| GET | `/api/staff/admin/roster` | **`staff.view`** — roster + MTD sales snippet per row. |
| GET | `/api/staff/admin/category-commissions` | Category default commission rates. |
| GET | `/api/staff/admin/role-permissions` | Matrix of role → permission keys. |
| GET | `/api/staff/admin/pricing-limits` | Role pricing caps. |
| GET | `/api/staff/admin/{staff_id}/permission-overrides` | Per-staff allow/deny overrides. |
| GET | `/api/staff/schedule/eligible` | Staff eligible for scheduling. |
| GET | `/api/staff/schedule/weekly/{staff_id}` | Weekly pattern. |
| GET | `/api/staff/schedule/effective` | Effective working days / exceptions. |
| GET | `/api/staff/schedule/validate-booking` | Validation helper for appointments (query params). |

### `/api/tasks/*`

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/tasks/me` | Open instances for current staff. |
| GET | `/api/tasks/instances/{instance_id}` | Instance detail. |
| GET | `/api/tasks/admin/templates` | **`tasks.manage`** |
| GET | `/api/tasks/admin/templates/{template_id}/items` | **`tasks.manage`** — template line items. |
| GET | `/api/tasks/admin/assignments` | **`tasks.manage`** — recurring assignment definitions. |
| GET | `/api/tasks/admin/team-open` | **`tasks.view_team`** / admin patterns |
| GET | `/api/tasks/admin/history` | **`tasks.manage`** |

### `/api/notifications/*`

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/notifications/` | Inbox list (**`notifications.view`**). |
| GET | `/api/notifications/unread-count` | Badge counts. |

### `/api/customers/*`

**Permission / access (typical GETs):** authenticated **staff** (Back Office headers) **or** **open POS register session** — base **`require_customer_access`** remains on browse/search/create and similar. **Relationship Hub–aligned routes** use **`require_staff_perm_or_pos_session`** with **`customers.hub_view`**, **`customers.hub_edit`** (**`PATCH`** profile), **`customers.timeline`**, **`customers.measurements`**, and **`orders.view`** for per-customer order history — see [**`docs/STAFF_PERMISSIONS.md`**](STAFF_PERMISSIONS.md). NL executors must not use a looser internal path. Mutations such as merge, duplicate review queue (list / enqueue / dismiss), groups, and store-credit adjust still use **`customers.merge`**, **`customers_duplicate_review`**, **`customer_groups.manage`**, **`store_credit.manage`**, etc., on their respective handlers.

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/customers/search` | Typeahead search (min length rules). |
| GET | `/api/customers/browse` | Paged browse + filters. |
| GET | `/api/customers/groups` | Customer groups list. |
| GET | `/api/customers/{id}` | Customer card. |
| GET | `/api/customers/{id}/hub` | Relationship hub payload. |
| GET | `/api/customers/{id}/profile` | Profile fields. |
| GET | `/api/customers/{id}/timeline` | Merged activity (§7). |
| GET | `/api/customers/{id}/order-history` | Orders for CRM. |
| GET | `/api/customers/{id}/measurements` | Measurement vault. |
| GET | `/api/customers/{id}/store-credit` | Store credit summary. |
| GET | `/api/customers/{id}/weddings` | Linked wedding parties. |

### `/api/products/*`

**Permission / access:** read/list/hub/timeline routes require **`catalog.view`** (and some list paths also allow **`procurement.view`** where the handler explicitly does — confirm in [`server/src/api/products.rs`](../server/src/api/products.rs)). Writes and import require **`catalog.edit`** (out of scope for passive NL reads).

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/products/` | Product list (catalog). |
| GET | `/api/products/control-board` | Same as inventory control-board (paged SKUs). Optional **Meilisearch** for **`search`** when configured — [SEARCH_AND_PAGINATION.md](SEARCH_AND_PAGINATION.md). |
| GET | `/api/products/{product_id}/hub` | Product hub (matrix, flags, etc.). |
| GET | `/api/products/{product_id}/timeline` | Product change / event timeline. |
| GET | `/api/products/{product_id}/variants` | Variant grid for product. |
| GET | `/api/products/{product_id}/bundle-components` | Bundle BOM. |
| GET | `/api/products/{product_id}/po-summary` | PO / procurement summary for product. |

### `/api/inventory/*`

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/inventory/scan/{sku}` | Single-SKU resolve (POS). |
| GET | `/api/inventory/scan-resolve` | Multi-strategy scan resolution. |
| GET | `/api/inventory/control-board` | Delegates to products control-board (same Meilisearch **`search`** behavior). |
| GET | `/api/inventory/intelligence/{variant_id}` | Variant intelligence payload (reads). |

### `/api/inventory/physical/*`

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/inventory/physical/sessions` | Session list (**`physical_inventory.view`**). |
| GET | `/api/inventory/physical/sessions/active` | Active session. |
| GET | `/api/inventory/physical/sessions/{id}` | Session detail (includes audit trail context via server). |
| GET | `/api/inventory/physical/sessions/{id}/review` | Review-phase snapshot. |

### `/api/categories/*`

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/categories/` | Flat list. |
| GET | `/api/categories/tree` | Nested tree. |
| GET | `/api/categories/audit` | **`category_audit_log`** (§7). |

### `/api/discount-events/*`

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/discount-events/` | All events (limit 200). |
| GET | `/api/discount-events/active` | Currently active window. |
| GET | `/api/discount-events/usage-report` | **`discount_event_usage`** aggregated by event + date range (**`catalog.view`**). |
| GET | `/api/discount-events/{id}` | One event. |
| GET | `/api/discount-events/{id}/variants` | Variant membership. |

### `/api/purchase-orders/*`

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/purchase-orders/` | PO list (**`procurement.view`**). |
| GET | `/api/purchase-orders/{po_id}` | PO detail + lines. |

### `/api/vendors/*`

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/vendors/` | Vendor list. |
| GET | `/api/vendors/{vendor_id}/hub` | Vendor hub (brands, metadata). |
| GET | `/api/vendors/{vendor_id}/brands` | Brand list under vendor. |

### `/api/alterations/*`

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/alterations/` | Alteration queue list (**`alterations.manage`**). |

### `/api/gift-cards/*`

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/gift-cards/` | Card list (**`gift_cards.manage`**); query **`open_only`**, **`sort=recent_activity`**. |
| GET | `/api/gift-cards/open` | Open cards (usable balance, not expired), recent activity first — staff or POS session. |
| GET | `/api/gift-cards/code/{code}` | Lookup by code (staff or POS session). |
| GET | `/api/gift-cards/code/{code}/events` | Event ledger by code (staff or POS session). |
| GET | `/api/gift-cards/{id}/events` | **`gift_card_events`** ledger for card (**`gift_cards.manage`**). |

### `/api/loyalty/*`

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/loyalty/settings` | Program settings (**`loyalty.program_settings`**). |
| GET | `/api/loyalty/monthly-eligible` | Eligible customers snapshot. |
| GET | `/api/loyalty/ledger?customer_id=` | **`loyalty_point_ledger`** per customer (staff or POS session). |

### `/api/weddings/*`

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/weddings/events` | **SSE** stream — not a batch JSON export; AI integrations should use REST aggregates, not scrape the stream. |
| GET | `/api/weddings/morning-compass` | Dashboard bundle (**`weddings.view`**). |
| GET | `/api/weddings/activity-feed` | Activity rows (**`weddings.view`**). |
| GET | `/api/weddings/actions` | Pipeline rows for UI + ops; see field note below (**`party_balance_due`** per party). |
| GET | `/api/weddings/appointments` | Store appointments list. |
| GET | `/api/weddings/parties` | Paged party list. |
| GET | `/api/weddings/parties/{party_id}` | Party detail. |
| GET | `/api/weddings/parties/{party_id}/ledger` | Party ledger. |
| GET | `/api/weddings/parties/{party_id}/financial-context` | Financial snapshot. |
| GET | `/api/weddings/members/{member_id}` | Member detail. |

**`GET /api/weddings/actions`** — Query **`days`**: optional horizon for “event within N days” filtering in the SQL (default **90**, clamped **1–365**). Response JSON: **`needs_measure`**, **`needs_order`** — each an array of **`ActionRow`** objects: **`wedding_party_id`**, **`wedding_member_id`**, **`party_name`**, **`customer_name`**, **`role`**, **`status`**, **`event_date`**, **`party_balance_due`**. The balance field is the **sum of `orders.balance_due`** for **all members of that wedding party** (repeated on every row for the same party when multiple members appear). Serialize as **string** decimals in JSON. Implementation: [`server/src/logic/wedding_queries.rs`](../server/src/logic/wedding_queries.rs) (`query_wedding_actions`), type [`ActionRow`](../server/src/logic/wedding_api_types.rs).

### `/api/qbo/*` (read-heavy)

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/qbo/integration` | Connection status. |
| GET | `/api/qbo/credentials` | Masked / status (sensitive). |
| GET | `/api/qbo/accounts-cache` | Cached QBO account list. |
| GET | `/api/qbo/mappings` | Saved mappings. |
| GET | `/api/qbo/staging` | Staging rows. |
| GET | `/api/qbo/staging/{id}/drilldown` | Line-level drilldown. |

### `/api/settings/*`

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/settings/receipt` | Receipt / timezone config (**`settings.admin`**). |
| GET | `/api/settings/backups` | Backup file list. |
| GET | `/api/settings/backups/download/{filename}` | File download (treat as sensitive). |
| GET | `/api/settings/backup/config` | Cloud / retention settings JSON. |
| GET | `/api/settings/database/stats` | DB stats (**`settings.admin`**). |
| GET | `/api/settings/weather` | Weather integration settings. |
| GET | `/api/settings/staff-sop` | Store playbook markdown (**`settings.admin`**). |
| PUT | `/api/settings/staff-sop` | Replace playbook body `{ "markdown": "..." }` (UTF-8 byte cap); audit **`staff_sop_update`**. |

### `/api/weather/*`

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/weather/forecast` | Current forecast payload. |
| GET | `/api/weather/history` | Historical / snapshot history per product rules. |

### `/api/shipments/*`

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/shipments/` | List (**`shipments.view`**). Query: **`customer_id`**, **`status`**, **`source`**, **`open_only`**, **`limit`** (default 80, max 200), **`offset`**. Response **`items`**: id, source, status, order/customer links, tracking, carrier, **dest_summary**, amounts — [**`SHIPPING_AND_SHIPMENTS_HUB.md`**](SHIPPING_AND_SHIPMENTS_HUB.md). |
| GET | `/api/shipments/{id}` | Detail + **`events`** timeline (**`shipments.view`**). |
| POST | `/api/shipments/` | Create manual shipment (**`shipments.manage`**). |
| POST | `/api/shipments/{id}/rates` | Shippo rate shop (**`shipments.manage`**). |
| POST | `/api/shipments/{id}/apply-quote` | Apply chosen quote (**`shipments.manage`**). |
| POST | `/api/shipments/{id}/purchase-label` | Buy label (**`shipments.manage`**). |
| POST | `/api/shipments/{id}/notes` | Staff note (**`shipments.manage`**). |
| PATCH | `/api/shipments/{id}` | Update shipment (**`shipments.manage`**). |

Fulfillment / revenue questions that depend on **ship dates** align with **`shipment_event`** and **fulfillment** **`basis`** on insights — see [**`docs/REPORTING_BOOKED_AND_FULFILLED.md`**](REPORTING_BOOKED_AND_FULFILLED.md).

### `/api/sync/counterpoint/*` (machine)

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/sync/counterpoint/health` | **M2M** — requires `COUNTERPOINT_SYNC_TOKEN`; not a normal staff NL reporting source unless proxied with governance. |
| GET | `/api/sync/counterpoint/orders` | Stub **501** — not a data source. |

### `/api/payments/*` and `/api/hardware/*`

- **`POST`-only** in current router — no JSON **read** surface for reporting (§15).

---

## 1. First-class analytics APIs (`/api/insights/*`)

These endpoints are built for **pivot-style** and **ops** reporting. They are the best candidates for **whitelist** mapping. **Embeds:** **`GET`/`POST /api/insights/metabase-launch`** resolves the **Metabase** **`iframe_src`** for **Back Office → Insights** (**`insights.view`**); see [**`METABASE_REPORTING.md`**](METABASE_REPORTING.md).

| Endpoint | Method | Auth / permission (typical) | What it returns | Natural-language examples |
|----------|--------|----------------------------|-----------------|---------------------------|
| `/api/insights/metabase-launch` | GET / POST | **`insights.view`** | JSON **`iframe_src`** — static **`/metabase/`** or JWT SSO URL when configured | “Open Insights” (UI use; NL rarely needs this) |
| `/api/insights/sales-pivot` | GET | Should be gated as **`insights.view`** for NL reporting | Rows: **bucket**, **gross_revenue**, **tax_collected**, **order_count**, **line_units**; optional **weather_snapshot**, **closing_comments** (when `group_by=date`); **customer_id** when `group_by=customer`. **truncated** if capped at 200 rows. | “Sales by brand last month”, “Tax by category”, “Units by salesperson”, “Daily sales with weather” |
| | | Query: **`group_by`**: `brand`, `salesperson`, `category`, `customer`, `date` | | |
| | | **`basis`**: `booked`/`sale` vs `fulfilled`/`pickup` (fulfillment: pickup **`fulfilled_at`**, ship from **`shipment_event`**) | | |
| | | **`from` / `to`**: UTC dates; default ~90-day window | | |
| `/api/insights/margin-pivot` | GET | **Admin role only** — same auth pattern as **cost** surfaces; not **`insights.view`** alone | Same buckets as sales-pivot plus **cost_of_goods**, **gross_margin**, **margin_percent** (pre-tax); **truncated** cap | “Gross margin by brand”, “Margin % by category (fulfilled sales)” |
| | | Query: same **`group_by`**, **`basis`**, **`from`/`to`** as **`/sales-pivot`** | | |
| `/api/insights/commission-ledger` | GET | **`insights.view`** | Per staff: **unpaid_commission** (booked window, open lines), **fulfilled_pending_payout** / **paid_out_commission** (**fulfillment** window on fulfilled lines) | “Who is owed commission?”, “Pending payout this quarter” |
| `/api/insights/commission-finalize` | POST | **`insights.commission_finalize`** | **Mutating** — finalize payout lines (not passive reporting) | “Finalize commissions” (must stay **explicit** UX) |
| `/api/insights/nys-tax-audit` | GET | **`insights.view`** | Clothing/footwear vs standard path tax buckets on lines whose order **fulfillment** falls in range (no `basis` param) | “NYS tax audit summary”, “Exempt vs standard lines” |
| `/api/insights/staff-performance` | GET | **`insights.view`** | Per staff: **high_value_line_units**, **high_value_net_revenue** (lines over $500 net), **revenue_momentum** (7 daily UTC buckets; **`basis`** = booked vs fulfilled) | “High-ticket sellers”, “Last 7 days momentum by rep” |
| `/api/insights/register-sessions` | GET | **`insights.view`** | Closed sessions: **ordinal**, **opened_at**, **closed_at**, **cashier**, **opening_float**, **expected/actual cash**, **discrepancy** | “Drawer over/short trends”, “Who closed last week” |
| `/api/insights/register-day-activity` | GET | **`register.reports`** or **open lane session** | **`RegisterDaySummary`**: aggregates + activity feed; **`basis`** booked vs fulfilled | “POS → Reports daily activity” |
| `/api/insights/register-override-mix` | GET | **`insights.view`** | Counts by **price_override_reason**; optional **`basis`** + dates (booked vs fulfilled) | “Why are we overriding price?”, “Manager override reasons” |
| `/api/insights/wedding-health` | GET | **`insights.view`** | **parties_event_next_30_days**, **wedding_members_without_order**, **wedding_members_with_open_balance** | “Wedding pipeline risk”, “Open balances” |
| `/api/insights/wedding-saved-views` | GET / POST | **`insights.view`** | List / create saved **filters** JSON for wedding insights UI (**POST** = mutation) | “Save/load named wedding views” |
| `/api/insights/wedding-saved-views/{id}` | DELETE | **`insights.view`** | Delete one saved view | — |
| `/api/insights/best-sellers` | GET | **`insights.view`** | Top variants by **units sold** in range; **`basis`** = booked vs fulfilled (aligned with **`order_date_filter_sql`**) | “Best sellers last 90 days”, “Top SKUs by units” |
| `/api/insights/dead-stock` | GET | **`insights.view`** | On-hand variants with **low units sold** in window; **`max_units_sold`** threshold | “Slow movers”, “Dead stock with list retail value” |

**Implementation reference:** [`server/src/api/insights.rs`](../server/src/api/insights.rs).

**Chart mapping hints:**

- **Sales pivot** → bar or horizontal bar (**bucket** vs **gross_revenue**); stacked bar if comparing **tax** vs **net** (derive net = gross − tax if needed in spec).
- **Margin pivot** (Admin) → bar (**bucket** vs **gross_margin** or **margin_percent**); only whitelist if NL executor enforces **Admin** parity.
- **Commission ledger** → grouped bar per staff (**unpaid** / **pending** / **paid**).
- **Staff performance** → sparkline or multi-line (**revenue_momentum** arrays).
- **Register sessions** → table or scatter (**closed_at** vs **discrepancy**).
- **Register override mix** → pie or bar (**reason** vs **line_count**).

---

## 2. Orders and payments (transactional reporting)

| Source | Route area | Typical permission | Useful fields / filters |
|--------|------------|-------------------|-------------------------|
| Order list / detail | `/api/transactions/*` | [**`orders.view`**](STAFF_PERMISSIONS.md) (+ modify/refund keys for writes) | Status, **booked_at**, **fulfilled_at**, **balance_due**, customer link, lines, tenders, returns |
| **Order activity / audit** | `GET /api/transactions/{transaction_id}/audit` | **`orders.view`** + same read auth as order (BO or register session) | **`order_activity_log`**: **event_kind**, **summary**, **metadata**, **created_at** (per order, last 100) |
| Refund queue | `/api/transactions/*` | **`orders.refund_process`** | Open refund work |
| Customer order history | `/api/customers/{id}/order-history` | Customer + order read paths | Timeline for one customer |
| Sessions / X-report | `/api/sessions/*` | Register session + **`register.reports`** patterns | Tender mix, session-level reconciliation |
| Register metrics (attributed sales) | `GET /api/staff/self/register-metrics` | Staff auth; role-gated in logic | **line_count**, **attributed_gross**, store **calendar date** |

**NL examples:** “Open orders with balance”, “Orders fulfilled Tuesday”, “Refunds pending”.

**Implementation:** [`server/src/api/transactions.rs`](../server/src/api/transactions.rs), [`server/src/api/sessions.rs`](../server/src/api/sessions.rs), [`server/src/logic/register_staff_metrics.rs`](../server/src/logic/register_staff_metrics.rs).

---

## 3. Catalog, inventory, and procurement

| Source | Route area | Typical permission | Useful fields / filters |
|--------|------------|-------------------|-------------------------|
| Control board / SKUs | `/api/inventory/control-board`, `/api/products/control-board` | **`catalog.view`** | Paged SKUs; optional Meilisearch text **`search`**; see [SEARCH_AND_PAGINATION.md](SEARCH_AND_PAGINATION.md). |
| Scan / resolve | `/api/inventory/scan/{sku}`, `/api/inventory/scan-resolve` | Catalog + POS session patterns | Single-line lookup for “what is this barcode?” |
| Variant intelligence | `/api/inventory/intelligence/{variant_id}` | **`catalog.view`** | Consolidated variant reads for hub-style answers. |
| Product hub / timeline | `/api/products/{id}/hub`, `/timeline`, `/variants`, `/bundle-components`, `/po-summary` | **`catalog.view`** | Deep SKU context, change history, procurement. |
| Product import | `POST /api/products/import` | **`catalog.edit`** | Bulk load (not a chart endpoint). |
| Purchase orders | `/api/purchase-orders/*` | **`procurement.view`** / **`procurement.mutate`** | PO list, detail, lines, receive. |
| Vendors | `/api/vendors/*`, `/api/vendors/{id}/hub`, `/brands` | **`catalog.view`** / procurement | Vendor codes, brand rollups. |
| Categories | `/api/categories/*`, `/tree`, `/audit` | **`catalog.view`** | Tree, **is_clothing_footwear**, audit log. |
| Discount events | `/api/discount-events/*` | **`catalog.view`** | Events, **active**, variant membership, **`/usage-report`** (aggregated **`discount_event_usage`** by date range). |
| Physical inventory | `/api/inventory/physical/*` | [**`physical_inventory.view`**](../INVENTORY_GUIDE.md) (+ mutate keys for writes) | Sessions list, **active**, **session by id**, **review** snapshot, counts (via detail). |

**NL examples:** “Low available stock by category”, “Open POs by vendor”, “Discount event usage last 90 days”, “Product timeline for SKU X”.

**Docs:** [**`INVENTORY_GUIDE.md`**](../INVENTORY_GUIDE.md), [**`docs/SEARCH_AND_PAGINATION.md`**](SEARCH_AND_PAGINATION.md), [**`docs/CATALOG_IMPORT.md`**](CATALOG_IMPORT.md).

---

## 4. Customers and CRM

| Source | Route area | Typical permission | Useful fields / filters |
|--------|------------|-------------------|-------------------------|
| Browse / search | `GET /api/customers/browse`, `/search` | Staff policies | Paged list, **customer_code**, name, phone. |
| Groups | `GET /api/customers/groups` | Group management keys | Segment / VIP reporting. |
| Core profile | `GET /api/customers/{id}`, `/profile` | Customer read | Identity, flags, marketing opt-in. |
| Hub | `GET /api/customers/{id}/hub` | Customer read | Aggregated CRM hub payload. |
| Timeline | `GET /api/customers/{id}/timeline` | Customer read | Activity stream (§7). |
| Order history | `GET /api/customers/{id}/order-history` | Customer + [**`orders.view`**](STAFF_PERMISSIONS.md) patterns | Receipt list for one person. |
| Measurements | `GET /api/customers/{id}/measurements` | Customer read | Sizing vault. |
| Store credit | `GET /api/customers/{id}/store-credit` | **`store_credit.manage`** / read rules | Liability snapshot. |
| Weddings link | `GET /api/customers/{id}/weddings` | **`weddings.view`** | Parties tied to customer. |
| Merge | `POST /api/customers/merge` | **`customers.merge`** | **Write** — not passive reporting. |
| Duplicate review queue | `GET /api/customers/duplicate-review-queue`, `POST …/enqueue`, `POST …/dismiss` | **`customers_duplicate_review`** | **Write** — staff queue for possible duplicates. |

**NL examples:** “New customers this month” (needs spec + query), “Customers in group X”.

**Docs:** [**`docs/CUSTOMERS_LIGHTSPEED_REFERENCE.md`**](CUSTOMERS_LIGHTSPEED_REFERENCE.md).

---

## 5. Weddings and appointments

| Source | Route area | Typical permission | Useful fields / filters |
|--------|------------|-------------------|-------------------------|
| Party list / detail | `GET /api/weddings/parties`, `/parties/{id}` | **`weddings.view`** | Pagination + party record. |
| Member | `GET /api/weddings/members/{id}` | **`weddings.view`** | Member + outfit context. |
| Ledger / financial | `GET /api/weddings/parties/{id}/ledger`, `/financial-context` | **`weddings.view`** | Money owed, allocations context. |
| Morning compass / activity | `GET /api/weddings/morning-compass`, `/activity-feed` | **`weddings.view`** + staff headers | Ops dashboards. |
| Actions catalog | `GET /api/weddings/actions` | **`weddings.view`** | **`needs_measure`** / **`needs_order`** rows; includes **`party_balance_due`** (party-level open order balance, string decimal). |
| Appointments | `GET /api/weddings/appointments` | **`weddings.view`** | Store calendar rows. |
| Live SSE | `GET /api/weddings/events` | Stream | **Do not** treat as tabular export (§0, §15). |

**NL examples:** “Parties with event in next 14 days”, “Members without linked order” (overlap with **wedding-health**).

**Docs:** [**`docs/WEDDING_GROUP_PAY_AND_RETURNS.md`**](WEDDING_GROUP_PAY_AND_RETURNS.md), [**`docs/APPOINTMENTS_AND_CALENDAR.md`**](APPOINTMENTS_AND_CALENDAR.md).

---

## 6. Staff, tasks, schedule, notifications

| Source | Route area | Typical permission | Useful fields / filters |
|--------|------------|-------------------|-------------------------|
| Roster / admin | `/api/staff/admin/roster`, `/admin/access-log`, `/admin/category-commissions`, `/admin/role-permissions`, `/admin/pricing-limits`, `/admin/{id}/permission-overrides` | **`staff.view`**, **`staff.view_audit`**, **`staff.manage_access`**, **`staff.manage_commission`** as applicable | Full matrix in **§0**. |
| Self / POS | `/api/staff/effective-permissions`, `/list-for-pos`, `/store-sop`, `/self/pricing-limits`, `/self/register-metrics` | Authenticated staff | Permissions, caps, **store SOP text**, **register metrics**. |
| Schedule | `/api/staff/schedule/*` | **`staff.view`** | Eligible staff, weekly template, effective days, booking validation. |
| Tasks | `/api/tasks/*` | **`tasks.complete`**, **`tasks.manage`**, **`tasks.view_team`** | **§0** lists `me`, instance detail, admin templates, team-open, history. |
| Notifications | `/api/notifications/*`, `/unread-count` | **`notifications.view`** | Inbox + counts (**broadcast** is POST). |

**NL examples:** “Who is scheduled today?”, “Open team tasks”, “Unread notifications for admins”.

**Docs:** [**`docs/STAFF_SCHEDULE_AND_CALENDAR.md`**](STAFF_SCHEDULE_AND_CALENDAR.md), [**`docs/STAFF_TASKS_AND_REGISTER_SHIFT.md`**](STAFF_TASKS_AND_REGISTER_SHIFT.md), [**`docs/PLAN_NOTIFICATION_CENTER.md`**](PLAN_NOTIFICATION_CENTER.md).

---

## 7. Audit and activity logs (staff, customers, catalog, inventory, weddings)

These are **event streams** and **trails**, not sales pivots. Many are **PII-sensitive** or **security-sensitive**; NL reporting should require **explicit permission** and often **narrow scope** (single order, single customer, date-bounded export). Several tables exist **only inside** business logic (e.g. checkout **price_override_audit** JSON on lines) and may **not** have a dedicated aggregate API yet — treat as **gap** unless you add a whitelisted read.

### Staff / employee access log

| Source | Route | Permission | Storage / payload |
|--------|-------|------------|-------------------|
| **Staff access log** | `GET /api/staff/admin/access-log?limit=` (1–1000, default 200) | **`staff.view_audit`** | **`staff_access_log`**: **staff_id**, **event_kind**, **metadata** (JSON), **created_at**; joined to **staff** name/avatar. **Global recent events** — suitable for “what did staff do lately?” only with strict governance. |

**Implementation:** [`server/src/api/staff.rs`](../server/src/api/staff.rs) (`admin_access_log`). Events are inserted from auth and sensitive actions (e.g. [`server/src/auth/pins.rs`](../server/src/auth/pins.rs) and other `log_staff_access` call sites).

### Customer timeline / “customer log”

| Source | Route | Permission | Notes |
|--------|-------|------------|--------|
| **Customer timeline** | `GET /api/customers/{customer_id}/timeline` | Customer read paths as implemented | **Merged** stream: milestones (e.g. checkout, fulfillment, refund per product rules), [**`customer_timeline_notes`**](CUSTOMER_HUB_AND_RBAC.md), **`wedding_activity_log`** references, etc. Built in [`server/src/api/customers.rs`](../server/src/api/customers.rs) (`build_customer_timeline`). |
| **Manual timeline note** | `POST /api/customers/{customer_id}/notes` | Per route | Staff-authored notes (not automatic system log). |

AGENTS.md notes **customer timeline** emits only **business** milestones for some edits — NL answers should not assume every field change appears here.

### Order-level audit

Already listed in **§2**: `GET /api/transactions/{transaction_id}/audit` → **`order_activity_log`**.

Additional **structured** audit may live on **order lines** (e.g. **price_override_audit** in checkout payload) — expose only via **order detail** / **line** APIs if surfaced; do not invent SQL.

### Category change audit

| Source | Route | Permission | Notes |
|--------|-------|------------|--------|
| **Category audit** | `GET /api/categories/audit?limit=` | **`catalog.view`** | **`category_audit_log`**: field, old/new values, **changed_by**, **created_at**. |

### Physical inventory audit

| Source | Notes |
|--------|--------|
| **`physical_inventory_audit`** | Rows written during count sessions (review, close, variance, cancel). **No single “list all audits”** analytics endpoint is implied in the catalog — today consumption is **session-scoped** via physical inventory flows. For NL reporting, whitelist **session detail** responses or add a dedicated read API. |

### Wedding activity (operational feed)

| Source | Route | Permission | Notes |
|--------|-------|------------|--------|
| **Activity feed** | `GET /api/weddings/activity-feed` | **`weddings.view`** + staff headers | Recent wedding-related **events** for dashboards (not the same as **staff_access_log**). |

### QBO / integration audit

| Source | Notes |
|--------|--------|
| **QBO history / staging** | `/api/qbo/*` — sync and staging rows act as an **accounting audit trail**; map NL questions to **existing** history endpoints. |

### What is **not** fully exposed as “logs” for AI today

- **Broad cross-customer** timeline search (privacy).
- **Unified** “all audit tables” query — would require new **admin-only** reporting APIs with filters.
- **Raw** `order_attribution_audit` or every **middleware** trace — use **order** and **staff** APIs where wired.

---

## 8. Gift cards, loyalty, alterations

| Source | Route area | Typical permission | Notes |
|--------|------------|-------------------|--------|
| Gift cards | `GET /api/gift-cards/`, `/code/{code}` | **`gift_cards.manage`** (+ POS reads where allowed) | List + lookup. |
| Gift card events | `GET /api/gift-cards/{id}/events` | Same | **`gift_card_events`** — issue, redeem, adjust trail per card. |
| Loyalty settings / eligible | `GET /api/loyalty/settings`, `/monthly-eligible` | **`loyalty.program_settings`** | Program config + monthly cohort. |
| Loyalty ledger | `GET /api/loyalty/ledger?customer_id=` | Staff or POS session | **`loyalty_point_ledger`** (last 200 rows per customer). |
| Alterations | `GET /api/alterations/` | **`alterations.manage`** | Queue list. |

**NL examples:** “Gift card event history for card ending 1234”, “Points ledger for customer X”, “Alterations due this week”.

---

## 9. QBO bridge (accounting-facing)

| Source | Route area | Typical permission | Notes |
|--------|------------|-------------------|--------|
| Integration / credentials | `GET /api/qbo/integration`, `/credentials` | **`qbo.view`** | Connection health (credentials are sensitive). |
| Accounts / mappings | `GET /api/qbo/accounts-cache`, `/mappings` | **`qbo.view`** | Cached CoA + saved maps. |
| Staging | `GET /api/qbo/staging`, `/staging/{id}/drilldown` | **`qbo.view`** | Pending journals + line drilldown. |

**NL examples:** “What is in QBO staging?”, “Last mapping change” — only via these GETs, never raw SQL.

**Docs:** [**`docs/QBO_JOURNAL_TEST_MATRIX.md`**](QBO_JOURNAL_TEST_MATRIX.md).

---

## 10. Weather and store settings (contextual)

| Source | Route area | Notes |
|--------|------------|--------|
| Weather | `GET /api/weather/forecast`, `/history` | Often unauthenticated or low-friction; do not leak API keys in prompts |
| Receipt / ops | `GET /api/settings/receipt` | **`settings.admin`** |
| Backups | `GET /api/settings/backups`, `/backups/download/{file}`, `/backup/config` | **`settings.admin`** |
| Database | `GET /api/settings/database/stats` | **`settings.admin`** |
| Weather config | `GET /api/settings/weather` | **`settings.admin`** |
| Store staff playbook | `GET`/`PUT /api/settings/staff-sop` | **`settings.admin`** |
| Store staff playbook (read) | `GET /api/staff/store-sop` | Authenticated staff |

**Docs:** [**`docs/WEATHER_VISUAL_CROSSING.md`**](WEATHER_VISUAL_CROSSING.md).

---

## 11. PostgreSQL domains (conceptual — for spec design only)

These tables/views back the APIs above. **Do not** expose raw ad-hoc SQL to the LLM; use them to **name** dimensions when versioning report specs. **Access is never “by table” for staff** — map each spec dimension to **API routes** in §0–§10 and inherit **§ RBAC labeling contract** / **Quick reference** permissions from those routes (e.g. sales core → **`orders.view`** / **`insights.view`** depending on endpoint).

- **Sales core:** `orders`, `order_items`, `payment_transactions`, `payment_allocations`, `order_return_lines`, `order_activity_log`, `order_attribution_audit` (where used)
- **Catalog:** `products`, `product_variants`, `categories`, `vendors`, `discount_events`, `discount_event_variants`, **`discount_event_usage`**
- **Procurement:** `purchase_orders`, PO lines, receipts
- **CRM:** `customers`, customer groups, measurements, `customer_timeline_notes`, store credit tables (see **`store_credit`** APIs)
- **Weddings:** `wedding_parties`, `wedding_members`, `wedding_appointments`, `wedding_activity_log`, ledgers
- **Staff / ops:** `staff`, `staff_role_permission`, `register_sessions`, `staff_access_log`
- **Tasks / notifications:** task tables, `app_notification`, `staff_notification`
- **Inventory ops:** `physical_inventory_*` sessions, `physical_inventory_audit`, `category_audit_log`
- **Gift / loyalty (Reporting):** `reporting.loyalty_customer_snapshot` (metrics + phone/email), `reporting.loyalty_daily_velocity`.
- **Operational Status:** `reporting.layaway_snapshot` (human-readable status and balances for open/forfeited layaways).
- **Logistics:** **`shipment`**, **`shipment_event`** (hub + timeline via **`GET /api/shipments/*`**)

---

## 12. Gaps and placeholders

- **Margin pivot** is **`GET /api/insights/margin-pivot`** (**Admin only**); NL / AI executors must treat it as **restricted** (same **Admin** check as the handler), not as **`insights.view`**.
- **`GET /api/help/search`** returns **no hits** when **`RIVERSIDE_MEILISEARCH_URL`** (or equivalent) is unset — assistants should fall back to **manual list** endpoints, **`docs/staff/*`**, or **FAQ**; do not infer that “no results” means the feature is off if manuals exist.
- **`counterpoint_sync_runs`** is populated by the Counterpoint bridge but has **no `GET` route** in `build_router` — NL “sync health over time” needs a new whitelisted endpoint or ops SQL outside the AI path.
- **`/api/sync/counterpoint/orders`** is a **501 stub** — not a data source.

---

## 13. Suggested whitelist dimensions (v1 spec sketch)

When implementing Pillar 4, consider allowing **only** combinations like. **Each bullet must carry `required_permissions` in implementation** (copy keys from this catalog / `permissions.rs`); the executor refuses the whole spec if the session lacks **any** required key for the chosen backing routes.

- **Time:** `from`, `to`, **`basis`**: sale vs pickup — **inherits** from chosen sales API (usually **`insights.view`** when backed by **`/api/insights/sales-pivot`**).
- **Sales group_by:** brand, salesperson, category, customer, date — **`insights.view`** when backed by **`/api/insights/sales-pivot`**; **customer** grouping may imply **customer-identifying** output → ensure same gates as pivot + CRM rules.
- **Metrics:** gross_revenue, tax_collected, order_count, line_units (pivot); **Admin-only** margin pivot adds **cost_of_goods**, **gross_margin**, **margin_percent**; commission buckets; register discrepancy; wedding health counts — **split by backing route**: pivot/commission/register/wedding rows each list their own keys (see §1).
- **Orders / lines (non-pivot):** any spec that calls **`/api/transactions/*`** — **`orders.view`** (+ session rules where the REST layer requires them).
- **Catalog / procurement:** control-board, PO list, vendor hub — **`catalog.view`** / **`procurement.view`** as in §3.
- **Audit (optional v2):** staff_access_log recent window; per-order `order_activity_log`; per-customer timeline; category_audit_log — **separate** `required_permissions` per stream (**`staff.view_audit`**, **`orders.view`**, staff/POS customer access, **`catalog.view`**, etc.) and **export** policies aligned with Insights.

Version the spec (`spec_version: 1`) and bump when Insights APIs change. **Add a changelog row** when permission labels for a backing route change.

---

## 14. Surfaces intentionally excluded from “scrape for reporting”

| Surface | Why |
|---------|-----|
| **`POST /api/payments/intent`** | Stripe client-secret flow — not an analytics read. |
| **`POST /api/hardware/print`** | Printer bridge — no business metrics. |
| **`POST /api/auth/qbo/callback`** | OAuth redirect handler — not reporting data. |
| **`GET /api/weddings/events` (SSE)** | Real-time stream; use **REST** aggregates (`morning-compass`, `activity-feed`, party list) for batch/NLP. |
| **`/api/sync/counterpoint/*` (except health)** | **POST** ingest + token auth; not staff dashboard data. |
| **Raw Postgres / ad-hoc SQL** | Forbidden for model-driven execution (Pillar 4). |

---

## 15. LLM training supplement — time, `basis`, money, and intent routing

This section is **dense on purpose**: use it for **system prompts**, **synthetic Q&A**, and **tool-calling curricula** (**ROSIE** **`reporting_run`** grounding). It repeats some §1 facts in **decision-tree** form so models learn **stable** patterns. Pair with [**`AI_CONTEXT_FOR_ASSISTANTS.md`**](AI_CONTEXT_FOR_ASSISTANTS.md) **§9–§13** for non-numeric behavior and **§13** for ROSIE executor rules.

### 15.1 Booked vs fulfillment (commit this distinction)

- **Booked** attributes revenue/expense to the **business day of the sale** (`orders.booked_at` transformed by store timezone in reporting views). Staff language: “rang through,” “checkout date,” “sold date.”
- **Fulfillment** (fulfilled / pickup / ship) attributes revenue to the **business day the business considers the performance obligation satisfied** — pickup uses **`fulfilled_at`**; ship uses **`shipment_event`** / hub events per [**`REPORTING_BOOKED_AND_FULFILLED.md`**](REPORTING_BOOKED_AND_FULFILLED.md). Staff language: “picked up,” “out the door,” “shipped.”

**Training rule:** If the user does **not** specify, **do not** assume. Teach the model to **ask one clarifying question** or to **present both** definitions when giving generic training material.

### 15.2 Which endpoints care about `basis`?

**Typical pattern:** Pivot-style endpoints accept **`basis`** (exact enum labels are implemented in [`server/src/api/insights.rs`](../server/src/api/insights.rs) + logic — treat **`booked`/`sale`**-family vs **`fulfilled`/`pickup`/`fulfillment`**-family as [**documented in `REPORTING_BOOKED_AND_FULFILLED.md`**](REPORTING_BOOKED_AND_FULFILLED.md)).

| Endpoint / area | `basis`? | Notes |
|-----------------|----------|--------|
| **`GET /api/insights/sales-pivot`** | **Yes** | Primary teaching example for `group_by` + `basis`. |
| **`GET /api/insights/margin-pivot`** | **Yes** | Same shape; **Admin only**. |
| **`GET /api/insights/best-sellers`**, **`dead-stock`** | **Yes** | Units/revenue in window follow same booked-vs-fulfillment split. |
| **`GET /api/insights/staff-performance`** | **Partial** | Momentum arrays keyed by **`basis`** where implemented. |
| **`GET /api/insights/register-override-mix`** | **Optional** | Override counts in booked vs fulfillment windows. |
| **`GET /api/insights/register-day-activity`** | **Yes** | Register story uses **`basis`**. |
| **`GET /api/insights/nys-tax-audit`** | **No `basis`** | **Always fulfillment window** — tax buckets on **fulfilled** lines only. |
| **`GET /api/insights/commission-ledger`** | **Dual windows** | **Unpaid** bucket: **booked** window on **open** lines; **fulfilled/paid** sides: **fulfillment** on **fulfilled** lines — see §1 table and code. |
| **`GET /api/insights/rms-charges`** | **Date filter** | **`from`/`to`** as **UTC NaiveDate**; inclusive start, **exclusive** end; default ~90d — teach **not** to mix up with store-local “calendar day” without conversion. |

### 15.3 Date parameters (UTC vs store calendar)

- Many insights queries use **`from`** and **`to`** as **calendar dates** in **UTC** for HTTP ergonomics; **business-day** attribution then applies **store timezone** inside SQL (`reporting.effective_store_timezone()`). **Training:** “UTC date on the wire” ≠ “naïve NY calendar cut” unless you’ve verified the handler.
- **NYS tax audit** and other profit/revenue **fulfillment** reports align with **fulfillment date** rules — if the model **collapses** everything to booked, **tax answers will be wrong**.

### 15.4 Money and aggregates in JSON

- Treat **`gross_revenue`**, **`tax_collected`**, **`balance_due`**, **`party_balance_due`**, and similar fields as **authoritative** only from **JSON the server returned** — often **strings** for decimals.
- **Margin percent** on **`margin-pivot`** is **pre-tax** margin ÷ **pre-tax revenue** × 100 (see §0 row); do not reinterpret as “after tax.”
- **Truncation:** **`sales-pivot`** / **`margin-pivot`** can return **`truncated`** when row caps hit (~200 in catalog §1) — teach the model to **mention** truncation when explaining exports.

### 15.5 NL intent → route (expanded routing table)

Train on mapping **utterances** → **first API** (after permissions):

| User utterance pattern | First-line API / doc | Permission sketch |
|------------------------|----------------------|-------------------|
| “Sales by **brand** / salesperson / category / day” | **`GET /api/insights/sales-pivot`** + `group_by` | **`insights.view`** |
| “**Margin** / COGS / cost by …” | **`GET /api/insights/margin-pivot`** | **Admin** (Riverside + handler gate) |
| “**Commission** owed / paid / pending” | **`GET /api/insights/commission-ledger`** | **`insights.view`** |
| “**1102** / clothing tax / NYS audit” | **`GET /api/insights/nys-tax-audit`** | **`insights.view`** |
| “**High ticket** / $500+ lines / rep momentum” | **`GET /api/insights/staff-performance`** | **`insights.view`** |
| “**Drawer** over/short / Z / session history” | **`GET /api/insights/register-sessions`** or **`register-day-activity`** | **`insights.view`** / **`register.reports`** |
| “**Price overrides** reasons” | **`GET /api/insights/register-override-mix`** | **`insights.view`** |
| “**Wedding** pipeline / no order / balance” | **`GET /api/insights/wedding-health`** or **`GET /api/weddings/actions`** | **`weddings.view`** |
| “**RMS** / R2S **charge** export” | **`GET /api/insights/rms-charges`** | **`insights.view`** |
| “RMS list on **customer**” | **`GET /api/customers/rms-charge/records`** | **`customers.rms_charge`** |
| “**Best sellers** / dead stock / slow movers” | **`GET /api/insights/best-sellers`**, **`dead-stock`** | **`insights.view`** |
| “Open **orders** / refund queue / one order detail” | **`GET /api/transactions/`**, **`/refunds/due`**, **`/{id}`** | **`orders.view`** / **`orders.refund_process`** |

### 15.6 Metabase vs REST (when the model should answer which)

- **Ad-hoc exploration, charts, cohorts, saved questions:** **Metabase** (after **`metabase-launch`** / SSO) — subject to **Metabase** permissions.
- **Curated fixed reports, POS-friendly tiles, explicit API contract:** **Back Office → Reports** → **`reportsCatalog.ts`** mapped GETs (§0 Curated table).
- **Operational integrations / RMS / register day feed:** prefer **documented GET** so RBAC stays in **Axum** — do not teach “connect AI directly to Postgres” in production.

### 15.7 Synthetic training Q&A snippets (copy into datasets)

Prefix each with a **system** reminder: “Only use Riverside APIs and documents; never fabricate SQL or live numbers.”

**Q1:** “What’s the difference between booked and pickup reporting?”  
**A:** “**Booked** uses the sale/checkout business date. **Fulfillment** (often called fulfilled/pickup in APIs) moves revenue to **pickup** (`fulfilled_at`) or **ship** events. Pivots take a **`basis`** parameter; **NYS tax audit** is fulfillment-only. See [**`REPORTING_BOOKED_AND_FULFILLED.md`**](REPORTING_BOOKED_AND_FULFILLED.md).“

**Q2:** “Why does margin say 403?”  
**A:** “**`GET /api/insights/margin-pivot`** is **Admin-only** in Riverside, not merely **`insights.view`**. Metabase margin may also need **admin-class** Metabase accounts — see [**`METABASE_REPORTING.md`**](METABASE_REPORTING.md) and **`ThingsBeforeLaunch.md`**.“

**Q3:** “How do I answer “sales last week” precisely?”  
**A:** “Confirm whether “last week” means **booked** or **fulfilled**, pick **`from`/`to`**, call **`sales-pivot`** with matching **`basis`**, and respect **200-row truncation** if present.”

**Q4:** “Where do ship dates affect revenue?”  
**A:** “For fulfillment **basis**, shipped orders use **`shipment_event`** / hub semantics per [**`REPORTING_BOOKED_AND_FULFILLED.md`**](REPORTING_BOOKED_AND_FULFILLED.md); [**`GET /api/shipments/*`**](SHIPPING_AND_SHIPMENTS_HUB.md) lists operational shipments (**`shipments.view`**).”

---

## References

- [**`AI_CONTEXT_FOR_ASSISTANTS.md`**](AI_CONTEXT_FOR_ASSISTANTS.md) — routing: procedures vs §15; **ROSIE** **§13** runtime contract; training §9–§12
- [**`PLAN_LOCAL_LLM_HELP.md`**](PLAN_LOCAL_LLM_HELP.md) — **three-document bundle**, tool **“Hands”** table, system prompt stub, architecture, and ROSIE runtime rollout constraints
- [`ROS_AI_INTEGRATION_PLAN.md`](../ROS_AI_INTEGRATION_PLAN.md) — Pillar 4 saved reports + narrate + RBAC parity; retired **`/api/ai`** (**migration 78**)
- [`ThingsBeforeLaunch.md`](../ThingsBeforeLaunch.md) — Metabase Staff vs Admin, **migration 107**, LLM go-live checklist
- [**`PLAN_HELP_CENTER.md`**](../PLAN_HELP_CENTER.md), [**`docs/MANUAL_CREATION.md`**](MANUAL_CREATION.md) — **`ros_help`**, manual ingest, **`help.manage`**
- [**`docs/STAFF_PERMISSIONS.md`**](STAFF_PERMISSIONS.md) — role × permission matrix and middleware patterns
- [**`docs/AI_INTEGRATION_OUTLOOK.md`**](AI_INTEGRATION_OUTLOOK.md) — product intent
- [**`docs/METABASE_REPORTING.md`**](METABASE_REPORTING.md), [**`docs/REPORTING_BOOKED_AND_FULFILLED.md`**](REPORTING_BOOKED_AND_FULFILLED.md) — Phase 1 proxy vs Phase 2 **`reporting.*`** / booked vs fulfillment
- [`server/src/api/insights.rs`](../server/src/api/insights.rs) — insights handlers
- [`server/src/api/help.rs`](../server/src/api/help.rs) — Help Center routes
- [`server/src/auth/permissions.rs`](../server/src/auth/permissions.rs) — permission key constants (source of truth for strings)

**Last reviewed:** 2026-04-08 (§15 training supplement; **ROSIE** subsection under canonical router)
