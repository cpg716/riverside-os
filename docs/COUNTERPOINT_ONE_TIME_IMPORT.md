# Counterpoint → Riverside OS: one-time import runbook

Directed migration from Counterpoint (SQL Server + Windows bridge) into ROS PostgreSQL. Pair with [`docs/COUNTERPOINT_SYNC_GUIDE.md`](COUNTERPOINT_SYNC_GUIDE.md) for token, bridge install, and field mapping.

## Bridge import order and guards

The Windows bridge runs entities in a **single fixed pipeline** (`counterpoint-bridge/index.mjs`). Startup **validates** flag combinations (for example, `SYNC_TICKETS` requires `SYNC_CUSTOMERS` and `SYNC_CATALOG`, and `SYNC_INVENTORY` requires `SYNC_CATALOG`). For incremental expert runs against an already-seeded ROS database, set **`SYNC_RELAXED_DEPENDENCIES=1`** in `.env` to skip those exits.

When **`PS_SLS_REP`** is not visible and `CP_SALES_REPS_QUERY` is empty, the bridge calls **`POST /api/sync/counterpoint/sales-rep-stubs`** with distinct `SLS_REP` values from **`AR_CUST`** and **`PS_TKT_HIST`** so `preferred_salesperson_id` and ticket **`SLS_REP`** resolve. When **`PS_TKT_HIST_CELL`** is missing, ROS still tries to match **parent `ITEM_NO` + line unit price** to a single matrix variant under that parent.

## Preconditions

1. **Apply migrations** through `91_counterpoint_open_docs.sql` (includes `orders.counterpoint_doc_ref` and a partial unique index).
2. Set **`COUNTERPOINT_SYNC_TOKEN`** on the server and the same value in the bridge `.env` as `COUNTERPOINT_SYNC_TOKEN`.
3. Prefer **`RUN_ONCE=1`** on the bridge for a full bulk pass; set **`RUN_ONCE=0`** only if you want repeated polling.

## Historical date cutover

- Set **`CP_IMPORT_SINCE=2021-01-01`** in the bridge `.env` (default if unset).
- In `CP_*_QUERY` strings, use the literal **`__CP_IMPORT_SINCE__`** where a date filter belongs (tickets, notes, loyalty, gift history). The bridge expands it at startup to the value of `CP_IMPORT_SINCE`.

## Entity order (required)

Hard dependencies in ROS:

1. **Staff** (`SYNC_STAFF`) — `SY_USR` (and `PS_SLS_REP` / `PO_BUYER` when queries are set). When **`CP_SALES_REPS_QUERY` is empty**, the bridge runs **`sales-rep-stubs`** next so distinct `SLS_REP` from customers/tickets maps to ROS staff.
2. **Vendors** (`SYNC_VENDORS`) — **before** catalog (`VEND_NO` → `products.primary_vendor_id`).
3. **Customers** (`SYNC_CUSTOMERS`) — `CUST_NO` → `customer_code`. Default import is **closed tickets** or **in-range notes** plus anyone matching **`CP_CUSTOMER_STORE_CREDIT_EXISTS`** when store-credit sync is on (template uses **`MERCH_CR_BAL`** — verify in SSMS). **Loyalty-only** shoppers are **not** added. **`PS_LOY_PTS_HIST`** posts to **`loyalty_point_ledger`** only for customers who qualified here. Full **`AR_CUST`** line is commented in `.env`; add **`OR EXISTS(PS_DOC …)`** for open-document-only edge cases if needed.
4. **Store credit opening** — **on by default** in `.env.example` (`SYNC_STORE_CREDIT_OPENING=1`, **`CP_STORE_CREDIT_QUERY`** after customers). Posts to `POST /api/sync/counterpoint/store-credit-opening`. Ledger reason **`counterpoint_opening_balance`**; re-runs skip rows already imported (**idempotent**). Set **`SYNC_STORE_CREDIT_OPENING=0`** if you are not using Counterpoint merchandise credit on **`AR_CUST`**.
5. **Customer notes** (optional) — usual position after customers.
6. **Catalog** then **inventory** then **vendor_items** — matrix keys on variants must exist before ticket/open-doc lines resolve. Default **`CP_INVENTORY_QUERY`** only sends **MAIN** rows whose **`ITEM_NO`** sold on a ticket on or after **`CP_IMPORT_SINCE`** (same window as ticket history) **or** have **non-zero `QTY_ON_HND`**, so dead catalog SKUs are not pushed to ROS. Replace with the full `IM_INV` `SELECT` in `.env` if you need every row.
7. **Gift cards** — default off (`SYNC_GIFT_CARDS=0`) for bulk simplicity.
8. **Closed ticket history** (`SYNC_TICKETS`) — idempotent on `counterpoint_ticket_ref`.
9. **Open PS_DOC documents** (optional) — `SYNC_OPEN_DOCS=1` and `CP_OPEN_DOCS_*` queries **after** tickets. Posts to `POST /api/sync/counterpoint/open-docs`. Idempotent on `counterpoint_doc_ref`.
10. **Loyalty** — **off by default** in the bridge. If your CP DB has no loyalty history table, or you prefer to set points only in ROS (**`customers.loyalty_points`** / **`loyalty_point_ledger`** via the app or a separate import), keep **`SYNC_LOYALTY_HIST=0`**.

**Gift cards** — same idea: keep **`SYNC_GIFT_CARDS=0`** and maintain **`gift_cards`** in ROS yourself when Counterpoint is not the source of truth.

Enable either sync only when **`discover`** shows the corresponding CP tables and you want the bridge to load them.

## API endpoints (machine-to-machine)

All require header **`x-ros-sync-token`** (or `Authorization: Bearer …`) matching **`COUNTERPOINT_SYNC_TOKEN`**.

| Path | Purpose |
|------|---------|
| `POST /api/sync/counterpoint/staff` | Staff + `counterpoint_staff_map` |
| `POST /api/sync/counterpoint/sales-rep-stubs` | Orphan `SLS_REP` codes (when `PS_SLS_REP` not synced) |
| `POST /api/sync/counterpoint/vendors` | Vendors |
| `POST /api/sync/counterpoint/customers` | Customers |
| `POST /api/sync/counterpoint/store-credit-opening` | Opening store credit balances (`cust_no`, `balance`) |
| `POST /api/sync/counterpoint/customer-notes` | Timeline notes body: **`user_id`** (see bridge mapping), not `usr_id` |
| `POST /api/sync/counterpoint/catalog` | Products + variants |
| `POST /api/sync/counterpoint/inventory` | Stock |
| `POST /api/sync/counterpoint/vendor-items` | Vendor SKU cross-ref |
| `POST /api/sync/counterpoint/tickets` | Closed sales history |
| `POST /api/sync/counterpoint/open-docs` | Open `PS_DOC` → orders with **`special_order`** lines |

## Store credit vs A/R text

Customer ingest may still map Counterpoint A/R reference text to `customers.custom_field_2`. **Merchandise store credit** for POS should use **`store_credit_accounts`** + **`store_credit_opening`** import above. Confirm the correct CP column in SSMS before enabling `CP_STORE_CREDIT_QUERY`.

## Open documents (`PS_DOC`)

- Bridge env: **`CP_OPEN_DOCS_QUERY`** (headers), **`CP_OPEN_DOC_LINES_QUERY`**, **`CP_OPEN_DOC_PMT_QUERY`**.
- Headers must expose a stable **`doc_ref`** (alias). Map `booked_at`, `total_price`, `amount_paid`, `cust_no`, optional `usr_id` / `sls_rep`, optional **`cp_status`** (void/cancel markers → `cancelled` in ROS).
- Lines reuse the same shape as ticket lines (`sku`, `counterpoint_item_key`, `quantity`, `unit_price`, etc.). ROS sets **`fulfillment_type = special_order`** for all imported lines.
- Re-imports: existing `counterpoint_doc_ref` rows are skipped.

## Operational notes

- **Stop or pause the ROS API** during a full database wipe or extremely large imports if you need to avoid concurrent writes.
- After changing SQL on the Counterpoint side, re-run **`discover`** and adjust `.env` columns (SQL Server validates every named column).
- Bridge version is reported in heartbeat (`counterpoint-bridge/index.mjs`).

## Phase 2 (optional, separate change set)

**PO receiving history**: map Counterpoint **`PO_HDR` / `PO_LIN` / PO receive tables** into ROS **`purchase_orders`**, **`purchase_order_lines`**, and **`receiving_events`**. This is **not** implemented in the bridge or API yet; design and ship in a follow-on PR after CRM, inventory, tickets, and open docs are validated.
