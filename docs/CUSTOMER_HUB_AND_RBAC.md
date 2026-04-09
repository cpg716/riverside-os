# Customer Relationship Hub — API and RBAC

**Audience:** Developers and operators configuring **Staff → Role access** / **User overrides**.

**Purpose:** Single map from **HTTP routes** to **permission keys** and **middleware** for the Back Office **Relationship hub** drawer (`CustomerRelationshipHubDrawer`) and aligned POS/customer reads. Staff-facing behavior is summarized in [`docs/staff/customers-back-office.md`](staff/customers-back-office.md) and [`docs/staff/permissions-and-access.md`](staff/permissions-and-access.md).

---

## Middleware pattern

Hub-aligned routes use **`require_staff_perm_or_pos_session`** (`server/src/middleware/mod.rs`): the caller is allowed if either:

1. **Valid open register session** headers (`x-riverside-pos-session-id` + `x-riverside-pos-session-token`), or  
2. **Authenticated staff** with the required permission in **effective permissions** (`GET /api/staff/effective-permissions`).

Many browse/search/create paths use **`require_customer_access`** (signed-in staff or valid POS register session). **Merge** (`POST /api/customers/merge`), **duplicate review queue** (list / enqueue / dismiss), **group membership** changes, and **store credit adjust** are gated by **dedicated permission keys** — see [`server/src/api/customers.rs`](../server/src/api/customers.rs) and [`docs/STAFF_PERMISSIONS.md`](STAFF_PERMISSIONS.md).

---

## Permission keys (`server/src/auth/permissions.rs`)

| Key | Routes (representative) |
|-----|---------------------------|
| **`customers.hub_view`** | `GET /api/customers/{id}/hub`, `GET …/profile`, `GET …/weddings`, `GET /api/customers/{id}` (profile row), `GET …/store-credit` (summary), `GET …/open-deposit` (party-deposit balance + ledger preview) |
| **`customers.hub_edit`** | `PATCH /api/customers/{id}` (includes **`marketing_*_opt_in`**, **`transactional_sms_opt_in`** for operational pickup/alteration texts — migration **71**) |
| **`customers.timeline`** | `GET …/timeline` (includes **shipping** activity from **`shipment_event`** for this customer), `POST …/notes` |
| **`customers.measurements`** | `GET …/measurements`, `PATCH …/measurements` |
| **`orders.view`** | `GET …/order-history` (hub **Orders** tab) |
| **`shipments.view`** | Hub **Shipments** tab (list/detail scoped to customer; same key for **Customers → Shipments** workspace) — migration **75**, **[`docs/SHIPPING_AND_SHIPMENTS_HUB.md`](SHIPPING_AND_SHIPMENTS_HUB.md)** |

**Related (unchanged):** **`customers.merge`**, **`customer_groups.manage`**, **`store_credit.manage`** (**`POST …/store-credit/adjust`** remains staff + key only), **`customers_duplicate_review`** for duplicate queue tools.

**Shipments (hub + workspace):** **`shipments.manage`** is required for manual create, rates, apply-quote, PATCH, and staff notes on **`/api/shipments/*`** — see **[`docs/SHIPPING_AND_SHIPMENTS_HUB.md`](SHIPPING_AND_SHIPMENTS_HUB.md)**.

**R2S ledger (not hub drawer):** **`customers.rms_charge`** gates **`GET /api/customers/rms-charge/records`** and the **Customers → RMS charge** workspace — **[`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`](POS_PARKED_SALES_AND_RMS_CHARGES.md)** (migration **69**, **[`docs/STAFF_PERMISSIONS.md`](STAFF_PERMISSIONS.md)**).

---

## Public `/shop` accounts vs staff hub (migration **77**)

- **`customers.customer_created_source`**: **`store`** (default for POS-created and most imports) vs **`online_store`** when the row is first created via **`POST /api/store/account/register`**. Staff-facing profile / hub payloads surface this as **Channel** where implemented.
- Linking a password (**`POST /api/store/account/activate`**) attaches **`customer_online_credential`** to the **same** CRM row; **`GET /api/store/account/orders`** and order detail are scoped to **`orders.customer_id`** (web orders only in the store-safe list). Full public API and env: **[`docs/ONLINE_STORE.md`](ONLINE_STORE.md)**.

---

## Database seeds

**Migration [`migrations/63_customer_hub_rbac.sql`](../migrations/63_customer_hub_rbac.sql)** inserts the four **`customers.*`** hub keys for **`admin`**, **`salesperson`**, and **`sales_support`** (all **`true`** by default). **`Admin`** role still receives the **full catalog** in application code. Tune per role or use **`staff_permission_override`** as needed.

**Migration [`migrations/64_cashier_customer_duplicate_merge_rbac.sql`](../migrations/64_cashier_customer_duplicate_merge_rbac.sql)** sets **`customers_duplicate_review`** and **`customers.merge`** to **allowed** for **`salesperson`** and **`sales_support`** (duplicate queue APIs, hub **Profile → Queue pair**, and two-customer merge in **Customers**). Migration **62** had denied **`customers_duplicate_review`** for those roles; **64** aligns defaults with cashier/floor CRM practice.

---

## Client gating

- **`CustomerRelationshipHubDrawer`**: waits for **`permissionsLoaded`**, requires **`customers.hub_view`** to load the hub; tabs **Orders** / **Measurements** / **Shipments** hidden without **`orders.view`** / **`customers.measurements`** / **`shipments.view`**; timeline and notes require **`customers.timeline`**; profile/marketing/VIP edits require **`customers.hub_edit`**.
- **`AddCustomerDrawer`** (inside `CustomersWorkspace`): initial **VIP** PATCH and **note** POST after create are skipped with a toast if **`customers.hub_edit`** / **`customers.timeline`** are missing.

---

## HTTP errors

Missing permission returns **403** with `{ "error": "missing permission", "permission": "<key>" }` from middleware; `CustomerError::Forbidden` maps customer-router failures to **403** with `{ "error": "…" }`.

---

## See also

- [`docs/STAFF_PERMISSIONS.md`](STAFF_PERMISSIONS.md) — full RBAC matrix and operational notes  
- [`docs/SHIPPING_AND_SHIPMENTS_HUB.md`](SHIPPING_AND_SHIPMENTS_HUB.md) — **`shipments.*`**, Customers → Shipments, hub tab  
- [`docs/CUSTOMERS_LIGHTSPEED_REFERENCE.md`](CUSTOMERS_LIGHTSPEED_REFERENCE.md) — CRM feature parity  
- [`docs/SEARCH_AND_PAGINATION.md`](SEARCH_AND_PAGINATION.md) — browse / order-history paging  
- [`AGENTS.md`](../AGENTS.md) — migrations **63**–**64** summary (hub keys + cashier duplicate/merge defaults)  

**Last reviewed:** 2026-04-06 (migration **83** — **`customer_open_deposit_*`**, **`GET …/open-deposit`**)
