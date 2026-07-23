# Customer & inventory search / Meilisearch pagination

Canonical reference for **large-directory behavior**: how ROS queries customers and variant-level inventory, and where the UI pages results.

---

## Meilisearch (lexical search & sync health)

When Meilisearch is configured in **Settings → Integrations → Meilisearch**, the server resolves **text** queries via **Meilisearch** and then **hydrates** rows in PostgreSQL.

ROS uses the free self-hosted **Meilisearch Community Edition** only. The runtime is the pinned `getmeili/meilisearch` image in Docker Compose or the matching official Windows binary packaged with Main Hub; there is no Meilisearch Cloud project, billing API, hosted crawler, or Enterprise sharding dependency in the search path.

### Meilisearch Administrative Mandate
As of v0.1.1, the Riverside OS administrative interface utilizes a **Meilisearch architecture**. All manual UUID or SKU entry fields (e.g., Task assignments, Gift Card issuance, Loyalty adjustments, Physical Inventory) have been replaced with Meilisearch-powered components (`CustomerSearchInput`, `VariantSearchInput`). This eliminates human error associated with raw ID handling.

- **Fallback and authoritative results:** PostgreSQL remains authoritative. Every Meilisearch response, empty or nonempty, is accepted only when the same live index has a successful full rebuild within 36 hours, has no unresolved incremental-sync failure, is not indexing, and its live document count matches the PostgreSQL row-count snapshot from that rebuild. Otherwise the handler uses its escaped-literal PostgreSQL **ILIKE** fallback. Nonempty candidate arrays must also contain valid unique IDs, hydrate completely through the final PostgreSQL predicates, and produce the expected unique result-page count; any mismatch falls back instead of returning a silently reduced page from a stale or mis-bound index. Paged handlers also fall back when a fixed Meilisearch candidate cap is reached, because that capped ID set cannot prove later pages or totals are complete.
- **Indices:** 
  - `ros_products`, `ros_variants`, `ros_store_products`
  - `ros_customers`, `ros_wedding_parties`
  - `ros_orders` (Back Office Orders workspace records: Special, Custom, and Wedding fulfillment work)
  - `ros_transactions` (all TXN financial checkout records)
  - `ros_staff`, `ros_vendors`
  - `ros_tasks`, `ros_appointments`
  - `ros_alterations`
  - `ros_help` (Staff Help Center)
- **Sync Health Dashboard:** Located at **Settings → Integrations → Meilisearch**.
  - **Tracked Categories:** Shows real-time sync status for all primary indices.
  - **Health Metrics:** Displays the running and Riverside-pinned runtime versions, SQL row-count snapshot from the last rebuild, live document count from the same resolved Meilisearch client used by runtime search, count parity, rebuild recency, task status, and a conservative **Search ready** state.
  - **Stale Protection:** An index is not reported ready when its last successful full rebuild is older than 36 hours, counts differ, a task is still processing or failed, or live status is unavailable. Incremental writes may make the stored rebuild count differ until the next automatic rebuild; search safely uses SQL for results during that interval.
- **Refresh vs. rebuild:** **Refresh** reloads the Settings health view only. **Rebuild search index** re-pushes PostgreSQL records into Meilisearch for all current indices and refreshes row counts.
- **Safe rebuild behavior:** Full rebuilds write each supported index into a temporary Meilisearch UID, apply settings to that temporary index, stream every PostgreSQL row, enqueue documents, wait for Meilisearch settings/document tasks to complete, then swap the temporary UID into the live UID. A PostgreSQL stream error or a failed Meilisearch task fails the rebuild before the swap; ROS does not record a reduced row count as successful. The prior live index remains in service and the Settings health table records the failed rebuild path. The Help Center index follows the same staged rebuild pattern, and a Help failure makes the aggregate `ros_reindex_run` fail rather than reporting a partial rebuild as successful.
- **Automatic updates:** Meilisearch does **not** subscribe to PostgreSQL or update itself. ROS updates search when specific server write paths spawn an incremental Meilisearch upsert or delete after saving PostgreSQL state. An incremental write is recorded successful only after Meilisearch reports that task completed successfully; enqueue acceptance alone is not success, and delete task failures are recorded rather than discarded. A failed incremental write keeps that index in a failed state until a complete rebuild succeeds; a later successful incremental task cannot hide the unresolved drift. If PostgreSQL cannot be read during an incremental upsert, ROS records the failure and preserves the existing Meilisearch document instead of interpreting the read error as a deletion. Incremental writes refresh the index's last-success timestamp but do not recalculate full row counts. As a safety net, when Meilisearch is configured, the API runs one full staged rebuild per store-local day after **3 AM** by default. An incomplete scheduled rebuild gets at most three attempts per scheduled worker run with 30-second then 120-second backoff; the aggregate success marker remains false when all attempts fail. Set **`RIVERSIDE_MEILISEARCH_DAILY_REINDEX_ENABLED=false`** to disable it or **`RIVERSIDE_MEILISEARCH_DAILY_REINDEX_HOUR_LOCAL=0..23`** to change the local hour. PostgreSQL remains authoritative and search falls back to SQL when Meilisearch is unavailable.
- **When a warning is actionable:** A warning identifies its concrete cause: stale full rebuild, count mismatch, failed/processing task, unavailable live count, or connection failure. Refresh only rechecks those facts. Rebuild when counts or recency are not verified; fix the connection first when live status is unavailable.
- **Operations health truth:** A configured or reachable Meilisearch process is not by itself
  healthy. Operations reports it as degraded until a fresh successful full rebuild is recorded;
  a persisted `GOOD` reachability result also expires when its 60-second heartbeat stops updating.
  Search continues through the authoritative PostgreSQL fallback while proof is missing.
- **Local dev:** `docker compose` includes a **`meilisearch`** service bound to host loopback on port **7700**. From the host-run API use **`http://127.0.0.1:7700`**; from a containerized API use **`http://meilisearch:7700`**. `npm run dev` runs `scripts/dev-stack-preflight.sh`, which starts the local Meilisearch sidecar when this URL is configured, waits for `/health`, and verifies `RIVERSIDE_MEILISEARCH_API_KEY` before the API starts. Compose disables Meilisearch analytics and stores scheduled daily snapshots and on-demand dumps inside the persistent `riverside_meili_data` volume.
- **Credential source:** Riverside local installs seed `RIVERSIDE_MEILISEARCH_URL` and `RIVERSIDE_MEILISEARCH_API_KEY`; staff should not need to type these during normal setup. New Windows Main Hub installs generate a unique 48-character Meilisearch master key instead of using the local-development default. The key exists because the self-hosted Meilisearch HTTP service enforces a master/API key even on localhost. The key saved in **Settings → Integrations → Meilisearch** is stored as an encrypted integration credential and can override the `server/.env` fallback at API startup. That saved API key, `RIVERSIDE_MEILISEARCH_API_KEY`, and the live service master/API key must match. If the health panel reports `invalid_api_key`, clear or re-enter the current key in Settings and restart the API if the failure persists.
- **Self-hosted update discipline:** Keep the Community Edition runtime pinned to an explicit Meilisearch version. Current ROS pin: **`getmeili/meilisearch:v1.49.0`** (Windows Main Hub package runtime: **`1.49.0`**). Strict-production startup refuses a reachable but mismatched runtime, and the Settings health panel reports the running and required versions. Before changing `getmeili/meilisearch:<version>`, review Meilisearch's update notes for the current-to-target version, stop ROS writes if needed, create a dump for cross-version migration, and preserve a snapshot for same-version recovery. Do not downgrade a reused `/meili_data` directory. If the derived search data is discarded or incompatible, rebuild ROS search indexes from PostgreSQL through **Settings → Integrations → Meilisearch → Rebuild search index** because PostgreSQL remains authoritative.

**Customer browse:** When **`q`** is set together with **`wedding_party_q`**, Meilisearch is **not** used for the name leg (existing SQL wedding-party filter remains).

**Customer name shorthand:** Multi-token customer searches combine a strict all-terms query with name-only prefix queries for every token. This lets Register and other customer pickers resolve initials and partial names such as `C Garcia`, `Ch Gar`, or `Gar C` while still ranking customers who satisfy every entered name fragment. Meilisearch executes the component searches in one multi-search request. If any component reaches its candidate cap or is structurally invalid, Riverside uses the equivalent PostgreSQL per-name-token prefix match instead of trusting an incomplete intersection.

**Orders and transactions search:** Back Office Orders and financial Transactions are separate Meilisearch indices. `ros_orders` tracks only the unfulfilled Special, Custom, and Wedding order work shown in the Orders workspace. Layaways stay in the Layaways workflow. `ros_transactions` tracks all financial checkout records. Checkout writes upsert the affected transaction document and, when that transaction has order-style lines, the matching Orders document. The Settings dashboard shows both so staff can tell whether order search and all-transaction search are current.

Complete `TXN-*` input is a literal financial-record lookup. The server checks the PostgreSQL `transactions.display_id` source of truth first and returns only that exact record. This bypasses only the endpoint's implicit open-orders default so fulfilled receipt, return, and audit lookups still work; an explicitly selected status/date/customer filter remains authoritative. A missing exact ID does not expand into hundreds of fuzzy `TXN` matches. Name, phone, email, party, and partial-reference searches retain the normal Meilisearch-with-SQL-fallback behavior.

**Alterations search:** `ros_alterations` indexes open and historical alteration work by customer name, phone digits, email, address/ZIP, garment description, work requested, notes, source SKU, and linked transaction display ID. Alterations Hub and universal search hydrate matched alteration rows from PostgreSQL after Meilisearch lookup, with PostgreSQL `ILIKE` fallback when the search service is unavailable.

**Relevance fields:** Identifier fields are indexed separately ahead of broad `search_text` where the source data already exists. Variant search prioritizes SKU, barcode, UPC, product name, brand, variation label, and catalog handle. Customer search prioritizes customer code, email, phone digits, full name, first/last name, and company. Orders and transactions prioritize display/reference IDs before customer or party context. The concatenated `search_text` field remains as a broad fallback.

**Filter fields:** Variant documents include existing catalog/inventory fields: product/category/vendor IDs, web-published, clothing/footwear, active status, stock quantity, available stock, and stock status (`in_stock`, `out_of_stock`, `negative`). No PostgreSQL schema changes are required; PostgreSQL remains authoritative during hydration.

**Meilisearch hit caps:** Normal UI search helpers request a rank buffer instead of blanket 10k-50k windows: inventory 5,000 IDs, customers/weddings/tasks/appointments/alterations 1,000 IDs, transactions/orders 2,000 IDs, staff/vendors/store catalog 500 IDs, help 100 hits. Each index explicitly sets Meilisearch `pagination.maxTotalHits` to the matching window; otherwise Meilisearch's default 1,000-result ceiling would reject or truncate the 5,000- and 2,000-ID requests. These caps are ranking windows only. When a paged search reaches its cap, the server discards that non-authoritative candidate window and reruns the escaped-literal PostgreSQL path so `LIMIT`/`OFFSET` and totals remain complete. Admin/export flows that need complete sets should use SQL-backed export paths, not search ranking windows.

**Maintained but not blocking:** `ros_staff`, `ros_vendors`, and `ros_categories` are maintained for global-search/search-picker expansion and Settings visibility. They should not block staff workflows; existing staff/vendor/category pickers must keep SQL-backed behavior unless a caller explicitly hydrates Meilisearch IDs through PostgreSQL.

## Universal search (`GET /api/search/universal`)

- The universal endpoint searches independent sources concurrently. Each source, including each permitted operational source, has its own 1.1-second deadline; a slow source is named in `sources_failed` while completed operational and directory hits still return. SQL fallback patterns escape `%`, `_`, and `\`, so staff input is always literal rather than an accidental wildcard scan.
- Universal source work is bounded across concurrent requests so a burst of command-palette queries cannot multiply into unbounded database and index work. Identical staff/permission/query requests are coalesced and may reuse the same result for up to two seconds; this read cache never powers inventory or financial mutations. Sources that miss their complete queue-and-execution deadline remain explicitly named as timed out instead of turning a partial response into “No matches.”
- **Transaction Records** use `ros_transactions`, which contains every financial checkout. The Orders workspace uses `ros_orders` only for Special, Custom, and Wedding fulfillment work. Both SQL fallback and index documents cover display/reference IDs, customer full name, customer code, phone, email, party, and salesperson context.
- Wedding phone matching runs only when the complete query is phone-like and contains at least seven digits. Digits embedded in a name or identifier never trigger a phone substring match.
- The palette aborts and invalidates outstanding work on every input change. A Main Hub timeout is reported as a timeout, never as “No matches.” Deterministic records render as soon as the universal endpoint returns; optional ROSIE shortcut suggestions can arrive afterward without hiding those records.
- Universal alterations include both open and historical records. The “Wedding party customer list” action appears only when the deterministic wedding source found a matching party.

---

## Inventory — control board (`list_control_board`)

**Endpoints** (same handler, same JSON shape):

- `GET /api/inventory/control-board`
- `GET /api/products/control-board`

**Semantics:** Filters (`search`, `category_id`, `vendor_id`, `product_id`, `brand`, OOS/low, clothing-only, unlabeled, `min_line_value`, etc.) are applied **in SQL** (`WHERE` / `JOIN`), then **`LIMIT` / `OFFSET`**.

- **Browse / no text `search`:** rows are ordered **`ORDER BY p.name ASC, pv.sku ASC, pv.id ASC`** (stable grid behavior with a unique final tie-breaker).
- **Text `search` non-empty:** rows are ordered by **parent-product popularity** first, then name/SKU:
  - **`units_sold_trailing` DESC** — gross units sold in the trailing window (**45 days** of `orders.booked_at`), summed **`GROUP BY order_items.product_id`** (all variants of the product share one score). **Cancelled** orders (`status = cancelled`) are excluded. Constant: `CONTROL_BOARD_SEARCH_SALES_WINDOW_DAYS` in `server/src/api/products.rs`.
  - Tie-break: **`p.name ASC, pv.sku ASC, pv.id ASC`**.
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
| **Receive Stock / Promotions scan actions** | Resolve `/inventory/scan/{code}` first and accept only an identifier resolution (`sku`, `barcode`, active barcode alias, or catalog handle). The control-board fallback may accept one unique exact identifier field match only; it never auto-selects the first relevance-ranked row or an ambiguous shared identifier. Fuzzy product-name selection remains an explicit picker action. |
| **Header (⌘K)** | Exact identifiers are resolved across SKU, barcode, active barcode alias, and catalog handle. The **Exact SKU** shortcut appears only when those namespaces identify one active variation; collisions never auto-open an arbitrary item. Broad product search is capped in the UI. |
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

Quick directory search (POS, header, appointments, Wedding Manager, Register Lookup). **ILIKE** in SQL when Meilisearch is off; with Meilisearch, text resolution via **`ros_customers`** then **`WHERE c.id = ANY(...)`**. SQL fallback pages use **`ORDER BY c.created_at DESC, c.id DESC`**, **`LIMIT` / `OFFSET`** so equal timestamps cannot duplicate or skip records between pages.

| Param | Notes |
|-------|--------|
| `q` | Required meaningful input; **min 2 characters** (400 if shorter) |
| `limit` | Default **25**, max **100** |
| `offset` | Default **0**, max **500_000** |

**Clients (non-exhaustive):** `CustomerSelector.tsx` (POS; **Load more**), `GlobalSearchDrawers.tsx` (**More customers**), `RegisterLookupHub.tsx` (loyalty lookup; multi-match picker + optional **Load more**), `scheduler/AppointmentModal.tsx`, `wedding-manager/.../AppointmentModal.jsx`, `weddingApi.searchCustomers(q, opts?)`, `wedding-manager/lib/api.js` `searchCustomers(q, opts)`.

### `GET /api/customers/{id}/transaction-history`

Per-customer Transaction Record list (not a directory search). **`WHERE customer_id = :id`**, excludes cancelled transactions, **`ORDER BY booked_at DESC`**, window **`COUNT(*) OVER()`** for **`total_count`**. Use **`record_scope=orders`** only when the caller needs the customer's unfulfilled Special, Custom, or Wedding order work.

| Param | Notes |
|-------|--------|
| `from`, `to` | Optional **`YYYY-MM-DD`**; booked-at day bounds (UTC `T00:00:00Z` / `T23:59:59Z` server-side) |
| `limit` | Default **50**, max **200** |
| `offset` | Default **0** |

**Clients:** `CustomerRelationshipHubDrawer.tsx` — **Transactions** tab (**Apply range**, **Load more**) and scoped fulfillment-order views. The tab is shown only when **`orders.view`** is in effective permissions; the API uses the same gate server-side (**[`docs/CUSTOMER_HUB_AND_RBAC.md`](CUSTOMER_HUB_AND_RBAC.md)**).

---

## Implementation pointers

| Area | Server | Client |
|------|--------|--------|
| Control board | `server/src/api/products.rs` — `list_control_board`; optional Meili: `logic/meilisearch_search.rs` | `InventoryControlBoard.tsx`, `Cart.tsx`, `ProcurementHub.tsx`, `GlobalSearchDrawers.tsx` |
| Store PLP search | `server/src/logic/store_catalog.rs` — `list_store_products`; `server/src/api/store.rs` | `PublicStorefront.tsx` — product list **`search`** + debounce |
| Customer browse/search | `server/src/api/customers.rs` — `browse_customers`, `search_customers` | `CustomersWorkspace.tsx`, `CustomerSelector.tsx`, `GlobalSearchDrawers.tsx`, appointment modals, `weddingApi.ts`, `api.js` |
| Wedding party directory | `server/src/logic/wedding_queries.rs`, `server/src/api/weddings.rs` | Embedded Wedding Manager + APIs using party list **`search`** |
| Orders and Transaction Records list (BO) | `server/src/logic/transaction_list.rs`, `server/src/api/transactions.rs` | `OrdersWorkspace.tsx` |
| RMS charge list | `server/src/api/customers.rs` — RMS charge handler + optional **`q`** | `RmsChargeAdminSection.tsx` |
| Meilisearch ops | `logic/meilisearch_sync.rs` — `reindex_all_meilisearch`; **`GET`/`POST /api/settings/meilisearch/*`** — `settings.rs` | **Settings → Integrations → Meilisearch**; **`scripts/ros-meilisearch-reindex-local.sh`** |
| Customer transaction history | `server/src/logic/customer_transaction_history.rs`, `customers.rs` — `get_customer_transaction_history` (**`orders.view`** or POS session) | `CustomerRelationshipHubDrawer.tsx` (**Transactions** tab) |

---

## Related

`npm run check:search-indexes` is a source-structure check only. It confirms the migration definition is embedded and that required read-path safeguards remain present in source. It does **not** prove that the migration is applied or that PostgreSQL's planner uses an index; production proof requires checking `pg_indexes` and representative `EXPLAIN` plans against the live Main Hub database.

- **`INVENTORY_GUIDE.md`** — Scanning, physical counts, receiving (not the control-board SQL).
- **`docs/APPOINTMENTS_AND_CALENDAR.md`** — Appointment booking + customer search wiring.
- **`docs/CATALOG_IMPORT.md`** — Bulk product CSV (`POST /api/products/import`), not control-board search; import completion triggers Meilisearch resync when configured.
- **`docs/ONLINE_STORE.md`** — Public PLP **`search`** and storefront UX.
- **`docs/STORE_DEPLOYMENT_GUIDE.md`** — Production env (**`RIVERSIDE_MEILISEARCH_*`**) and optional sidecar.
- **`docs/INTEGRATIONS_SCOPE.md`** — Meilisearch posture in the integrations matrix.
- **`DEVELOPER.md`** — Full API table and migration index.
