# Customers — Lightspeed X-Series docs (reference comparison)

This note summarizes [Lightspeed Retail (X-Series)](https://www.lightspeedhq.com/) customer help articles and maps them to **Riverside OS** today. Use it for product planning and operator training, not as a promise of parity.

Sources (retrieved for comparison):

- [Merging customers](https://x-series-support.lightspeedhq.com/hc/en-us/articles/25534181802011-Merging-customers)
- [Adding, updating, and deleting customers](https://x-series-support.lightspeedhq.com/hc/en-us/articles/25533749652251-Adding-updating-and-deleting-customers-in-Retail-POS-X-Series)
- [Managing customers](https://x-series-support.lightspeedhq.com/hc/en-us/articles/25534063246235-Managing-customers-in-Retail-POS-X-Series)
- [Using customer groups](https://x-series-support.lightspeedhq.com/hc/en-us/articles/25534113975323-Using-customer-groups-in-Retail-POS-X-Series)

---

## 1. Merging customers

**Lightspeed:** Pick a **primary** profile; for each duplicate choose **merge and delete**, **merge and keep**, or **do not merge**. Transfers **sales history, store credit, loyalty, on-account** balances to the primary. Notes merge may **not** work with Advanced Marketing, some apps, or Customer API integrations.

**ROS today:** **First-class merge** (migration **42**, logic in `server/src/logic/customer_merge.rs`):

- **`POST /api/customers/merge`** with **`dry_run: true`** returns a **preview** (counts of orders, wedding members, group memberships, alterations, store credit on the absorbed record, etc.).
- **`dry_run: false`** runs a **single transaction** that re-points related rows to the **master** customer and deactivates the duplicate (see implementation for full coverage).
- Gated by **`customers.merge`** (`CUSTOMERS_MERGE`); Back Office UI in **`CustomersWorkspace`** (preview + confirm).

**Stable key:** **`customer_code`** remains the cross-system identity for imports (`POST /api/customers/import/lightspeed`, Counterpoint upsert).

**Takeaway:** Operational deduplication should use **merge**, not ad-hoc deletes. External integrations (like Lightspeed) may still have constraints after a merge—treat ROS as source of truth for post-merge codes.

---

## 2. Adding / updating / deleting / bulk import

**Lightspeed:** Add from **Sell** or **Customers**; tabs for contact, addresses, extra fields; **customer settings** for on-account limits, loyalty, custom tax. **Bulk** CSV/XLSX with column mapping, **error export** with an “Issue” column, optional **continue anyway**, loyalty **currency conversion** on import. **`customer_code` cannot be changed via spreadsheet** (would duplicate) — must edit in UI.

**ROS today:**

- **Create / patch:** `POST /api/customers`, `PATCH /api/customers/{id}` — profile, marketing flags, VIP; **hub** and **timeline** in Back Office (`CustomersWorkspace`, relationship hub drawer).
- **Import:** **`POST /api/customers/import/lightspeed`** — JSON rows (same conceptual fields as X-Series CSV), upsert on **`customer_code`** (`server/src/logic/lightspeed_customers.rs`). Response includes **`issues`**: per-row **`missing_customer_code`** or **`email_conflict`** (email dropped because another customer owns it). Back Office **downloads a CSV** of issues when the array is non-empty. New ROS-native customers get a server-allocated code (`ROS-########`); Lightspeed rows keep retailer codes.
- **Counterpoint:** `POST /api/sync/counterpoint/customers` — upsert on `cust_no` → `customer_code`.
- **Bulk update UX:** Row-level **issue CSV** on import addresses part of Lightspeed’s “error export”; full **round-trip export → fix → re-import** is still manual outside ROS.
- **Delete / anonymize:** Lightspeed **anonymizes** history on delete and blocks delete with open balances. ROS does **not** mirror that flow in the public customer API surface documented in **`DEVELOPER.md`**; **`customers.is_active`** exists in schema (migration 31) but is not part of the standard `UpdateCustomerRequest` — confirm before documenting soft-delete behavior in product copy.

**Takeaways:**

- Treat **`customer_code`** as **immutable** for imports (same lesson as Lightspeed).
- A **conflict-report export** on future bulk import would reduce support load.
- **On-account limits** and **per-customer tax** are retail-grade features ROS may add when AR/tax rules need them.

---

## 3. Managing customers (search, history, reporting)

**Lightspeed:** Attach customer on **Sell** from search. Search uses **first name, last name, customer code** (code can be barcode / phone). **View sales** from profile; **Store credit, Account, Loyalty** tabs. **Reports** filter by customer; **export** customer spreadsheet; **API** for external CRM.

**ROS today:**

- **POS / CRM:** Customer attach via Cart / search (`GET /api/customers/search?q=` — min 2 chars; optional **`limit`/`offset`**; includes wedding context when applicable). Back Office browse uses **`GET /api/customers/browse`** with **`limit`/`offset`** (**Load more**); optional **`group_code`** filter (members of a `customer_groups.code`). With **Meilisearch** configured, text **`q`** on search/browse can use the search index (hybrid SQL); see **`docs/SEARCH_AND_PAGINATION.md`**.
- **Stable identity:** **`customer_code`** is the scan-friendly / cross-system key (aligned with Lightspeed’s emphasis on code).
- **360° view:** **`GET /api/customers/{id}/hub`**, **timeline**, weddings — formalwear-centric vs generic “View sales” list.
- **Order history (CRM):** **`GET /api/customers/{id}/order-history`** — paged list with optional booked-date range; **Orders** tab on the relationship hub drawer. Requires **`orders.view`** (or valid **open register** session) with **`require_staff_perm_or_pos_session`** — see **[`docs/CUSTOMER_HUB_AND_RBAC.md`](CUSTOMER_HUB_AND_RBAC.md)**. **Insights** sales pivot supports **`group_by=customer`** (requires **`insights.view`**) for store-wide revenue by customer in a date window.
- **Hub / timeline / measurements / profile PATCH:** **`customers.hub_view`**, **`customers.hub_edit`**, **`customers.timeline`**, **`customers.measurements`** — same doc and migration **63**.
- **Store credit:** **`GET /api/customers/{id}/store-credit`** — balance/summary for authorized staff or register session; **`POST /api/customers/{id}/store-credit/adjust`** — ledger adjustment (**`store_credit.manage`**). Checkout accepts tender method **`store_credit`** when **`customer_id`** is present (`server/src/logic/transaction_checkout.rs`).
- **Reporting:** **Insights** (including customer pivot) and order queries; no dedicated Lightspeed-style “export all customers + sales” spreadsheet yet.
- **Export:** No dedicated “export all customers” in this comparison path; **Lightspeed import** is inbound-focused.

**Takeaway:** ROS is strong on **wedding + timeline + merge/groups/store credit**; add **customer-scoped bulk export** when ops asks for Lightspeed-style reporting parity.

---

## 4. Customer groups

**Lightspeed:** **Groups** for **promotions**, **price books**, and **reporting**; CSV column **`customer_group_name`**; create groups with ID + name; assign on create/edit customer.

**ROS today:** **`customer_groups`** + **`customer_group_members`** (migration **42**); seeded rows for common labels; **`GET /api/customers/groups`** (list + member counts); **`POST` / `DELETE /api/customers/group-members`** to assign/remove (**`customer_groups.manage`**). Browse filter by **`group_code`**.

**Not yet:** **Group-based price books** or **promo engine** tied to group membership — that needs catalog/pricing rules beyond CRM.

**Takeaways:**

- **Segmentation / reporting / browse filters** are supported today; **VIP** and marketing flags still complement groups.
- **Group-based price books** remain a larger catalog project when the business needs Lightspeed-style promo linkage.

---

## Quick parity matrix

| Capability | Lightspeed (articles) | ROS (current direction) |
|------------|------------------------|-------------------------|
| Merge duplicates | Yes (with constraints) | Yes — **`POST /api/customers/merge`** + preview (**`customers.merge`**); default **`salesperson`** / **`sales_support`** after migration **64** |
| Customer groups → promos / price books | Yes | Groups **yes** for membership + browse; **no** group price books yet |
| Bulk import + column map + error file | Yes | Lightspeed JSON import; **issues JSON + auto CSV** for bad rows; no generic multi-format CSV mapper |
| Immutable code on bulk import | Yes | Yes (`customer_code` upsert key) |
| Delete / anonymize with balance rules | Yes | Not aligned in doc’d API |
| Search by name + code | Yes | Search + browse; code is first-class |
| Per-customer sales list in CRM | Yes | Hub/timeline/orders via other paths |
| Store credit | Yes | **Accounts + ledger + checkout tender** + BO adjust (`store_credit.manage`) |
| On-account / AR limits UI | Yes | Order **balance_due**; formal **AR limits / aging** not yet |
| API to external CRM | Yes | REST `/api/customers/*` for integrators |

---

## Related in-repo docs

- **`docs/SEARCH_AND_PAGINATION.md`** — Customer `search` / `browse` limits, offsets, and UI paging.
- **`DEVELOPER.md`** — `/api/customers`, migration **28** (`customer_code`), Lightspeed import, merge/groups/store credit routes.
- **`docs/STAFF_PERMISSIONS.md`** — **`customers.merge`**, **`customers_duplicate_review`**, **`customer_groups.manage`**, **`store_credit.manage`** (merge + groups/credit seeds: **42**–**43**; cashier duplicate/merge defaults: **64**).
- **`docs/PRODUCT_ROADMAP_MENS_WEDDING_RETAIL.md`** — Strategic gaps vs men’s / wedding retail context.
