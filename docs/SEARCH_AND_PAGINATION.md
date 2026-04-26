# Customer & inventory search / Meilisearch pagination

Canonical reference for **large-directory behavior**: how ROS queries customers and variant-level inventory, and where the UI pages results.

---

## Meilisearch (lexical search & sync health)

When **`RIVERSIDE_MEILISEARCH_URL`** is set (and **`RIVERSIDE_MEILISEARCH_API_KEY`** when the instance requires auth), the server resolves **text** queries via **Meilisearch** and then **hydrates** rows in PostgreSQL.

### Meilisearch Administrative Mandate
As of v0.1.1, the Riverside OS administrative interface utilizes a **Meilisearch architecture**. All manual UUID or SKU entry fields (e.g., Task assignments, Gift Card issuance, Loyalty adjustments, Physical Inventory) have been replaced with Meilisearch-powered components (`CustomerSearchInput`, `VariantSearchInput`). This eliminates human error associated with raw ID handling.

- **Fallback:** If Meilisearch is unavailable, handlers fall back to PostgreSQL **ILIKE** paths.
- **Indices:** 
  - `ros_products`, `ros_variants`, `ros_store_products`
  - `ros_customers`, `ros_wedding_parties`
  - `ros_orders` (Back Office Orders workspace records: transaction-backed order work)
  - `ros_transactions` (all TXN financial checkout records)
  - `ros_staff`, `ros_vendors`
  - `ros_tasks`, `ros_appointments`
  - `ros_alterations`
  - `ros_help` (Staff Help Center)
- **Sync Health Dashboard:** Located at **Settings → Integrations → Meilisearch**.
  - **Tracked Categories:** Shows real-time sync status for all primary indices.
  - **Health Metrics:** Displays Row Counts, Last Sync timestamps, and Success/Failure state.
  - **Stale Protection:** System triggers a **Warning** if an index has not successfully synced within 24 hours.
- **Refresh vs. rebuild:** **Refresh** reloads the Settings health view only. **Rebuild search index** re-pushes PostgreSQL records into Meilisearch for all current indices and refreshes row counts.
- **Automatic updates:** Meilisearch does **not** subscribe to PostgreSQL or update itself. ROS updates search when specific server write paths spawn an incremental Meilisearch upsert after saving the PostgreSQL record. Successful incremental upserts refresh the index's last-success timestamp; they do not recalculate full row counts. PostgreSQL remains authoritative and search falls back to SQL when Meilisearch is unavailable.
- **When stale is normal vs. actionable:** A stale warning means ROS has not recorded a successful rebuild or incremental upsert for that index in more than 24 hours. It is expected for quiet indices with no writes. It is actionable when staff recently changed records in that area, search results look wrong, or a restore/import/deploy happened without a rebuild.
- **Local dev:** `docker compose` includes a **`meilisearch`** service (port **7700**). From the host-run API use **`http://127.0.0.1:7700`**; from a containerized API use **`http://meilisearch:7700`**.

**Customer browse:** When **`q`** is set together with **`wedding_party_q`**, Meilisearch is **not** used for the name leg (existing SQL wedding-party filter remains).

**Orders and transactions search:** Back Office Orders and financial Transactions are separate Meilisearch indices. `ros_orders` tracks the order-style transaction records shown in the Orders workspace (special/custom/wedding/layaway/open-document work). `ros_transactions` tracks all financial checkout records. Checkout writes upsert the affected transaction document and, when that transaction has order-style lines, the matching Orders document. The Settings dashboard shows both so staff can tell whether order search and all-transaction search are current.

**Alterations search:** `ros_alterations` indexes open and historical alteration work by customer name, phone digits, email, address/ZIP, garment description, work requested, notes, source SKU, and linked transaction display ID. Alterations Hub and universal search hydrate matched alteration rows from PostgreSQL after Meilisearch lookup, with PostgreSQL `ILIKE` fallback when the search service is unavailable.

---

## Inventory — control board (`list_control_board`)

**Endpoints** (same handler, same JSON shape):

- `GET /api/inventory/control-board`
- `GET /api/products/control-board`

**Semantics:** Filters (`search`, `category_id`, `vendor_id`, `product_id`, `brand`, OOS/low, clothing-only, unlabeled, `min_line_value`, etc.) are applied **in SQL** (`WHERE` / `JOIN`), then **`LIMIT` / `OFFSET`**.

- **Browse / no text `search`:** rows are ordered **`ORDER BY p.name ASC, pv.sku ASC`** (stable grid behavior).
- **Text `search` non-empty:** rows are ordered by **parent-product popularity** first, then name/SKU:
  - **`units_sold_trailing` DESC** — gross units sold in the trailing window (**45 days** of `orders.booked_at`), summed **`GROUP BY order_items.product_id`** (all variants of the product share one score). **Cancelled** orders (`status = cancelled`) are excluded. Constant: `CONTROL_BOARD_SEARCH_SALES_WINDOW_DAYS` in `server/src/api/products.rs`.
  - Tie-break: **`p.name ASC, pv.sku ASC`**.
- **Meilisearch:** when enabled and **`search`** is set, the server resolves matching **variant ids** in Meilisearch (with safe filter facets), then restricts SQL to **`pv.id = ANY(...)`** and applies the **same sort** as the SQL-only path (popularity when searching, so typo-tolerant matches still surface best-moving **styles** higher). The response JSON does not expose `units_sold_trailing` (`#[serde(skip_serializing)]`).

The **`oos_low_only`** / low-stock **filter** here is independent of **notification** opt-in: admin morning low-stock alerts use **`products.track_low_stock`** and **`product_variants.track_low_stock`** (product hub) plus **`reorder_point`** — see **`docs/PLAN_NOTIFICATION_CENTER.md`**.  
Older builds applied a fixed row cap **before** substring filtering, which hid most SKUs in very large catalogs from Back Office search and POS (**Register** cart) Meilisearch; that pattern is removed.

**Indexes (migrations 81–82, 160):** `idx_order_items_variant_id`, `idx_order_items_product_id`, `idx_product_variants_product_id`, `idx_purchase_order_lines_variant_id`, `idx_transaction_lines_product_transaction`, and `idx_transactions_booked_status_id` support efficient search hydration, popularity ranking, variant counts, and last-vendor lookups.

**Query parameters** (see `InventoryBoardQuery` in `server/src/api/products.rs`):

| Param | Notes |
|-------|--------|
| `search` | **ILIKE** substring match when Meilisearch is off or on error; **Meilisearch** typo-tolerant match on the same fields when configured (see § Meilisearch above) |
| `product_id` | Restrict to variants of a single **product** (used by POS **cart line** variant swap: load all SKUs for the line’s template) |
| `limit` | Default **25_000** when `search` empty; **5_000** when `search` set; hard cap **50_000** |
| `offset` | Pagination into the ordered variant list |
| … | Same filter flags as the Inventory UI (`oos_low_only`, `clothing_only`, `category_id`, `vendor_id`, `brand`, …) |

**Clients (non-exhaustive):**

| Surface | Usage |
|---------|--------|
| **Inventory → list** | `InventoryControlBoard.tsx` — explicit `limit`/`offset=0` on refresh; **Load more SKUs** appends next page (stats stay from first response) |
| **Register `Cart`** | `GET /inventory/scan/{code}` (exact) + `GET /products/control-board?search=&limit=200` for fuzzy; results **grouped by product** in the dropdown so multiple **distinct** parents appear; **`product_id`** filter when changing variant on an existing line |
| **Header (⌘K)** | Scan + `control-board?search=` (product section capped in UI) |
| **Procurement Hub** | `control-board` with `search` / paging — not `GET /api/products` (that route lists templates only, `LIMIT 200`, no SKU search) |
| **Global search → product drawer** | `GET /inventory/scan/{sku}` |

**Other inventory APIs** (unchanged by this doc): `GET /inventory/scan-resolve`, physical inventory sessions, `POST /batch-scan`, **`services/inventory.rs` `resolve_sku`** for POS (separate limits for ambiguous *name* matches).

---

## Customers — browse vs search

### `GET /api/customers/browse`

Segmented list with wedding/balance/VIP filters. **Filters are in SQL**; then **`LIMIT` / `OFFSET`**.  
The UI uses a **High-Density Grid** approach, prioritizing financial data (Lifetime Sales, Open Balance) and wedding status.
When **`q`** is set and **`wedding_party_q`** is **not**, optional **Meilisearch** resolves customer ids first (same SQL hydration + filters); with **`wedding_party_q`**, the **`q`** leg stays **ILIKE** in SQL.

| Param | Notes |
|-------|--------|
| `q`, `vip_only`, `balance_due_only`, `loyalty_pool_only`, `wedding_soon_only`, `wedding_party_q`, `wedding_within_days` | See `CustomerBrowseQuery` in `server/src/api/customers.rs` |
| `limit` | Default **300**, max **1000** |
| `offset` | Default **0**, max **500_000** |

**Clients:** `CustomersWorkspace.tsx` (**Load more customers**), `GlobalSearchDrawers.tsx` (wedding party customer list with paging).

### `GET /api/customers/search`

Quick directory search (POS, global top bar search, appointments, Wedding Manager, Register Lookup). **ILIKE** in SQL when Meilisearch is off; with Meilisearch, text resolution via **`ros_customers`** then **`WHERE c.id = ANY(...)`** and the same **`ORDER BY c.created_at DESC`**, **`LIMIT` / `OFFSET`**.

| Param | Notes |
|-------|--------|
| `q` | Required meaningful input; **min 2 characters** (400 if shorter) |
| `limit` | Default **25**, max **100** |
| `offset` | Default **0**, max **500_000** |

**Clients (non-exhaustive):** `CustomerSelector.tsx` (POS; **Load more**), `GlobalTopBar.tsx` / `GlobalSearchDrawers.tsx` (**More customers**), `RegisterLookupHub.tsx` (loyalty lookup; multi-match picker + optional **Load more**), `scheduler/AppointmentModal.tsx`, `wedding-manager/.../AppointmentModal.jsx`, `weddingApi.searchCustomers(q, opts?)`, `wedding-manager/lib/api.js` `searchCustomers(q, opts)`.

### `GET /api/customers/{id}/transaction-history`

Per-customer order list (not a directory search). **`WHERE customer_id = :id`**, excludes cancelled orders, **`ORDER BY booked_at DESC`**, window **`COUNT(*) OVER()`** for **`total_count`**.

| Param | Notes |
|-------|--------|
| `from`, `to` | Optional **`YYYY-MM-DD`**; booked-at day bounds (UTC `T00:00:00Z` / `T23:59:59Z` server-side) |
| `limit` | Default **50**, max **200** |
| `offset` | Default **0** |

**Clients:** `CustomerRelationshipHubDrawer.tsx` — **Orders** tab (**Apply range**, **Load more**). The tab is shown only when **`orders.view`** is in effective permissions; the API uses the same gate server-side (**[`docs/CUSTOMER_HUB_AND_RBAC.md`](CUSTOMER_HUB_AND_RBAC.md)**).

---

## Implementation pointers

| Area | Server | Client |
|------|--------|--------|
| Control board | `server/src/api/products.rs` — `list_control_board`; optional Meili: `logic/meilisearch_search.rs` | `InventoryControlBoard.tsx`, `Cart.tsx`, `ProcurementHub.tsx`, `GlobalTopBar.tsx` / `GlobalSearchDrawers.tsx` |
| Store PLP search | `server/src/logic/store_catalog.rs` — `list_store_products`; `server/src/api/store.rs` | `PublicStorefront.tsx` — product list **`search`** + debounce |
| Customer browse/search | `server/src/api/customers.rs` — `browse_customers`, `search_customers` | `CustomersWorkspace.tsx`, `CustomerSelector.tsx`, `GlobalTopBar.tsx` / `GlobalSearchDrawers.tsx`, appointment modals, `weddingApi.ts`, `api.js` |
| Wedding party directory | `server/src/logic/wedding_queries.rs`, `server/src/api/weddings.rs` | Embedded Wedding Manager + APIs using party list **`search`** |
| Orders list (BO) | `server/src/logic/transaction_list.rs`, `server/src/api/transactions.rs` | `OrdersWorkspace.tsx` |
| RMS charge list | `server/src/api/customers.rs` — RMS charge handler + optional **`q`** | `RmsChargeAdminSection.tsx` |
| Meilisearch ops | `logic/meilisearch_sync.rs` — `reindex_all_meilisearch`; **`GET`/`POST /api/settings/meilisearch/*`** — `settings.rs` | **Settings → Integrations → Meilisearch**; **`scripts/ros-meilisearch-reindex-local.sh`** |
| Customer transaction history | `server/src/logic/customer_transaction_history.rs`, `server/src/api/customers.rs` — `get_customer_transaction_history` (**`orders.view`** or POS session) | `client/src/components/customers/CustomerRelationshipHubDrawer.tsx` (**Orders** tab) |

---

## Related

- **`INVENTORY_GUIDE.md`** — Scanning, physical counts, receiving (not the control-board SQL).
- **`docs/APPOINTMENTS_AND_CALENDAR.md`** — Appointment booking + customer search wiring.
- **`docs/CATALOG_IMPORT.md`** — Bulk product CSV (`POST /api/products/import`), not control-board search; import completion triggers Meilisearch resync when configured.
- **`docs/ONLINE_STORE.md`** — Public PLP **`search`** and storefront UX.
- **`docs/STORE_DEPLOYMENT_GUIDE.md`** — Production env (**`RIVERSIDE_MEILISEARCH_*`**) and optional sidecar.
- **`docs/INTEGRATIONS_SCOPE.md`** — Meilisearch posture in the integrations matrix.
- **`DEVELOPER.md`** — Full API table and migration index.
