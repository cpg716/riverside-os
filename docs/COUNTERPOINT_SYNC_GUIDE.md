# Counterpoint v8.2 → Riverside OS: Sync Guide

End-to-end reference for setting up and operating the one-way data ingest from **NCR Counterpoint v8.2 SQL Server** into **ROS PostgreSQL**. Covers server configuration, Windows bridge installation, entity mapping, monitoring via Settings UI, and provenance tagging.

**Companion docs:**
- [`COUNTERPOINT_BRIDGE_OPERATOR_MANUAL.md`](COUNTERPOINT_BRIDGE_OPERATOR_MANUAL.md) — **operator manual**: direct vs staging, hub, prerequisites, bridge/API updates, troubleshooting
- [`PLAN_COUNTERPOINT_ROS_SYNC.md`](PLAN_COUNTERPOINT_ROS_SYNC.md) — implementation roadmap and schema mapping tables
- [`counterpoint-bridge/INSTALL_ON_COUNTERPOINT_SERVER.txt`](../counterpoint-bridge/INSTALL_ON_COUNTERPOINT_SERVER.txt) — quick-start instructions for the Windows operator
- [`counterpoint-bridge/.env.example`](../counterpoint-bridge/.env.example) — full `.env` reference with example SQL

**Optional SQL objects:** Gift and loyalty tables (Standard: **`SY_GFT_CERT`**, **`PS_LOY_PTS_HIST`**) are **NCR Counterpoint** names from product/schema docs — Riverside did not invent them. However, many v8.2 installations (including yours) use custom naming: **`SY_GFC`** (Gift Cards) and **`AR_LOY_PT_ADJ_HIST`** (Loyalty). Always run **`node index.mjs discover`** to confirm your local schema before enabling these modules.

**Migrations:** 29 (base `counterpoint_item_key` + `counterpoint_sync_runs`), 84 (heartbeat, ticket idempotency, sync requests/issues, mapping tables), 85 (provenance: `customer_created_source = 'counterpoint'`, `products.data_source`), 86 (staff sync: `counterpoint_staff_map`, `staff.data_source` / `counterpoint_user_id` / `counterpoint_sls_rep`, `customers.preferred_salesperson_id`, `orders.processed_by_staff_id`), 89 (`vendor_supplier_item` for `PO_VEND_ITEM`, idempotent `loyalty_point_ledger` index for `PS_LOY_PTS_HIST` imports), 95 (`counterpoint_staging_batch` + `store_settings.counterpoint_config` for optional **staging** ingest controlled in Back Office).

---

## 1. Architecture overview

```
  ┌────────────────────────┐       HTTP/JSON        ┌──────────────────────────┐
  │  Counterpoint SQL      │  ◄── poll queries ──   │  counterpoint-bridge     │
  │  (Windows host)        │                        │  (Node.js on same host)  │
  └────────────────────────┘                        └────────┬─────────────────┘
                                                             │ POST /api/sync/counterpoint/*
                                                             │ (x-ros-sync-token)
                                                             ▼
                                                    ┌──────────────────────────┐
                                                    │  ROS Axum API            │
                                                    │  (Rust, port 3000)       │
                                                    ├──────────────────────────┤
                                                    │  PostgreSQL              │
                                                    │  (customers, products,   │
                                                    │   orders, gift_cards)    │
                                                    └──────────────────────────┘
```

The bridge is a small Node.js process that:
1. Polls Counterpoint SQL Server using configurable queries
2. Maps rows to ROS-compatible JSON payloads
3. POSTs batches to the ROS API with a shared secret token
4. Sends periodic **heartbeats** so the ROS admin UI can show bridge status

All data flows **one way**: Counterpoint → ROS. ROS never writes back to Counterpoint.

---

## 2. Server-side setup (ROS)

### 2a. Apply migrations

From the repo root (Postgres must be running via `docker compose up -d`):

```bash
./scripts/apply-migrations-docker.sh
```

Migrations **84** and **85** create the required tables and columns. Verify:

```bash
./scripts/migration-status-docker.sh | grep -E "84_|85_"
```

### 2b. Set environment variable

Add to `server/.env`:

```env
COUNTERPOINT_SYNC_TOKEN=your-long-random-secret-here
```

This token authenticates every bridge request. Generate a strong random value (e.g. `openssl rand -hex 32`). **Never log this token.** Restart the Rust server after adding it.

### 2c. Verify the health endpoint

```bash
curl -H "x-ros-sync-token: your-long-random-secret-here" \
     http://127.0.0.1:3000/api/sync/counterpoint/health
```

Should return `200` with JSON including `"ok": true`, `"service": "counterpoint_sync"`, and `"counterpoint_staging_enabled": true|false`.

### 2d. Bridge Command Center
The bridge includes a local dashboard for manual triggers and log monitoring. It listens on port **3002** (to avoid collision with Metabase on 3001).
- **URL**: `http://localhost:3002`
- **Manual Mode (Default)**: By default, the bridge starts in manual mode. It will poll the ROS health endpoint and respond to targeted triggers or full sync requests, but it will **not** auto-sync on a timer.
- **Continuous Sync**: Toggle "Continuous Sync" in the dashboard to enable automatic 15-minute polling. 
- **Auth**: The dashboard uses an internal proxy to communicate with the ROS API using the `COUNTERPOINT_SYNC_TOKEN`. This allows manual synchronization without requiring a valid staff PIN on the bridge host. 

---

## 3. Bridge installation (Windows)

### 3a. Prerequisites

- **Node.js 18+** (LTS) — download from https://nodejs.org
- Network connectivity from the Counterpoint Windows host to the ROS server (LAN IP or Tailscale)
- A SQL Server login with **read access** to the Counterpoint company database

### 3b. Install

1. Copy the `counterpoint-bridge/` folder to the Windows machine (e.g. `C:\Riverside\counterpoint-bridge\`)
2. Open a command prompt in that folder and run:
   ```cmd
   npm install
   ```
3. Copy `.env.example` to `.env` and edit:

```env
ROS_BASE_URL=http://192.168.1.100:3000
COUNTERPOINT_SYNC_TOKEN=your-long-random-secret-here
SQL_CONNECTION_STRING=Server=localhost\RMSSVR;Database=Riverside;User Id=ros_cp_login;Password=secret;Encrypt=true;TrustServerCertificate=true
```

Key fields:
- `ROS_BASE_URL` — the ROS server's LAN IP and port (not `localhost` unless they're the same machine)
- `COUNTERPOINT_SYNC_TOKEN` — must **exactly match** the server `.env` value
- `SQL_CONNECTION_STRING` — standard `mssql` connection string; `Database=` must be the Counterpoint **company** database (same one you connect to in SSMS)

### 3c. Enable entities

Each data entity has a flag. Enable what you need. **Recommended enable order:** **staff** → vendors → customers → customer_notes → catalog → inventory → gift_cards → tickets (staff **must** sync first so customer/ticket attribution resolves).

| Flag | Entity | Default | CP Table(s) |
|------|--------|---------|-------------|
| `SYNC_STAFF=1` | Users, sales reps, buyers → ROS staff | Disabled | `SY_USR`, `PS_SLS_REP`, `PO_BUYER` |
| `SYNC_VENDORS=1` | Vendor/supplier profiles | Disabled | `AP_VEND` |
| `SYNC_CUSTOMERS=1` | Customer profiles + loyalty + type + preferred rep | Enabled | `AR_CUST` |
| `SYNC_CUSTOMER_NOTES=1` | Customer timeline memos | Disabled | `AR_CUST_NOTE` |
| `SYNC_INVENTORY=1` | Stock quantities for existing variants | Disabled | `IM_INV` |
| `SYNC_CATALOG=1` | Products + matrix variants (creates items in ROS) | Disabled | `IM_ITEM`, `IM_INV_CELL`, `IM_PRC`, `IM_BARCOD` |
| `SYNC_GIFT_CARDS=1` | Gift certificates + lifecycle events | Disabled | `SY_GFT_CERT` (Standard) or `SY_GFC` (Custom) |
| `SYNC_TICKETS=1` | Historical sales tickets → orders | Disabled | `PS_TKT_HIST`, `PS_TKT_HIST_LIN`, `PS_TKT_HIST_PMT` |
| `SYNC_RECEIVING_HISTORY=1` | Historical cost/receiving logs (2018+) | Disabled | `PO_RECVR_HIST` |
| `SYNC_TICKET_PAYMENTS=1` | Historical payment method details | Disabled | `PS_TKT_HIST_PMT` |
| `SYNC_TICKET_GIFT_REDEEM=1` | Historical gift card redemptions | Disabled | `PS_TKT_HIST_GFT` |
| `SYNC_STORE_CREDIT_OPENING=1` | Current Store Credit balances | Disabled | `SY_STC` |

### 3d. Start

```cmd
node index.mjs
```

Or use the bundled `START_BRIDGE.cmd` (runs `npm install` on first launch, then `node index.mjs`).

For production, add `START_BRIDGE.cmd` to Windows **Task Scheduler** to run on login.

---

## 4. Entity reference

### 4a. Staff (Users + Sales Reps + Buyers)

**Source:** `dbo.SY_USR` (system users), `dbo.PS_SLS_REP` (sales reps), `dbo.PO_BUYER` (buyers)
**Target:** `staff` table + `counterpoint_staff_map` mapping table
**Key:** `USR_ID` / `SLS_REP` / `BUYER_ID` → `counterpoint_staff_map.cp_code`

| Counterpoint Column | Source Table | ROS Column | Notes |
|---------------------|-------------|------------|-------|
| `USR_ID` | `SY_USR` | `counterpoint_user_id` | Login account code |
| `SLS_REP` | `PS_SLS_REP` | `counterpoint_sls_rep` | Sales rep code |
| `BUYER_ID` | `PO_BUYER` | mapped via `counterpoint_staff_map` | Buyer → `sales_support` role |
| `NAM` | all | `full_name` | Display name |
| `EMAIL_ADRS` | `SY_USR` | `email` | |
| `COMMIS_PCT` | `PS_SLS_REP` | `base_commission_rate` | Decimal commission rate |
| `STAT` | `SY_USR`, `PS_SLS_REP` | `is_active` | `A` = active, `I` = inactive (archived) |
| `USR_GRP_ID` | `SY_USR` | `role` (hint) | Groups containing "MGR"/"MANAGER"/"ADMIN" → `admin`; sales reps → `salesperson`; others → `sales_support` |

**Mapping logic:**

1. **Already mapped?** If `counterpoint_staff_map` has a row for this `(cp_code, cp_source)`, the existing `staff` row is **updated** in place.
2. **Name match?** If a staff member with the same name already exists in ROS (e.g. the owner pre-created themselves), the CP identifiers are **merged** onto that existing row.
3. **New staff:** A new `staff` row is created with `cashier_code = "CP" + code` (e.g. `CPJOHN`), `data_source = 'counterpoint'`, and `is_active` based on CP `STAT`.

Imported staff have **no PIN** (`pin_hash = NULL`) and cannot log in to the Back Office or POS until an admin assigns a cashier code and PIN. This is intentional — historical staff from Counterpoint are imported for **attribution and archival**, not active access.

**Archiving non-current staff:** Staff with `STAT = 'I'` in Counterpoint are imported with `is_active = false`. They appear in the Staff list but cannot be assigned to registers, tasks, or schedules. Their historical sales data remains linked via `orders.processed_by_staff_id` and `order_items.salesperson_id`.

**Downstream attribution (after staff sync):**

| Context | CP Field | ROS Column |
|---------|----------|------------|
| **Ticket headers** (`PS_TKT_HIST`) | `USR_ID` | `orders.processed_by_staff_id` — who rang up the sale |
| **Ticket headers** (`PS_TKT_HIST`) | `SLS_REP` | `orders.primary_salesperson_id` + `order_items.salesperson_id` — commission recipient |
| **Customer profiles** (`AR_CUST`) | `SLS_REP` | `customers.preferred_salesperson_id` — home/preferred rep |
| **Customer notes** (`AR_CUST_NOTE`) | `USR_ID` | Embedded in note body as `[CP:NOTE_ID] USR_ID` |

> **Sync order matters:** Staff **must** be synced before customers and tickets. If staff are not yet in the map, `USR_ID` / `SLS_REP` references on customers and orders will be `NULL` (they can be backfilled by re-running the customer/ticket sync after staff are present).

### 4b. Customers

**Source:** `dbo.AR_CUST` (or `dbo.VI_AR_CUST_WITH_ADDRESS`)
**Target:** `customers` table
**Key:** `cust_no` → `customers.customer_code`

| Counterpoint column | ROS column | Notes |
|---------------------|------------|-------|
| `CUST_NO` | `customer_code` | Primary match key; supports fuzzy prefix matching (e.g. `C-`) |
| `NAM` | — | Primary visual anchor; parsed into first/last |
| **Lifetime Sales** | — | **Calculated via Aggregation**: ROS computes lifetime spend by summing all imported tickets since Jan 1, 2018 |
| `EMAIL_ADRS_1` | `email` | Unique constraint; skipped on conflict (logged as `email_conflicts`) |
| `PHONE_1` | `phone` | Clamped to 20 chars |
| `ADRS_1`, `ADRS_2`, `CITY`, `STATE`, `ZIP_COD` | `address_line1/2`, `city`, `state`, `postal_code` | |
| `PTS_BAL` | `loyalty_points` | Integer points balance |
| `CUST_TYP` | `custom_field_1` | Customer type tag (e.g., "RETAIL", "WHOLESALE") |
| `BAL` | `custom_field_2` | A/R balance (stored as string for reference) |
| `SLS_REP` | `preferred_salesperson_id` | Resolved via `counterpoint_staff_map` (sync staff first) |

**Provenance & Lifetime Value:** New customers created by this sync get `customer_created_source = 'counterpoint'`. **Important:** As of the 2018 Historical Hardening update, Riverside OS does NOT use a static `lifetime_sales` column from Counterpoint. Instead, it aggregates all imported `tickets` (from 2018+) to provide mathematically accurate lifetime reporting and financial parity.

**Default `.env` scope (2018 Hardening):** `CP_IMPORT_SINCE` is now set to **2018-01-01** by default to capture all transactional history required for lifetime audits.
**Open Documents:** Unlike historical tickets, the `CP_OPEN_DOCS_QUERY` typically removes date filters to ensure the full active backlog (Layaways, Quotes, Special Orders) is captured regardless of creation date.
`CP_CUSTOMERS_QUERY` selects **`AR_CUST`** for **closed tickets** or **in-range notes** on or after **`CP_IMPORT_SINCE`**, **or** (when **`SYNC_STORE_CREDIT_OPENING=1`**) **`OR EXISTS(CP_CUSTOMER_STORE_CREDIT_EXISTS)`** — shipped example uses **`MERCH_CR_BAL` > 0**; change both that SQL fragment and **`CP_STORE_CREDIT_QUERY`** if your column name differs. **Loyalty-only** activity does **not** add customers. Open layaways without tickets may still need a manual **`PS_DOC`** `EXISTS` if required.

### 4b-2. Customer Notes

**Source:** `dbo.AR_CUST_NOTE`
**Target:** `customer_timeline_notes`
**Key:** `CUST_NO` → resolved to `customer_id` via `customer_code`; `NOTE_ID` used for dedup tag `[CP:NOTE_ID]`

| Counterpoint column | ROS column |
|---------------------|------------|
| `CUST_NO` | `customer_id` (resolved) |
| `NOTE_TXT` | `body` (prefixed with `[CP:NOTE_ID] USR_ID`) |
| `NOTE_DAT` | `created_at` |
| `USR_ID` | Embedded in body text |

Idempotent: notes with the same `[CP:NOTE_ID]` prefix for a customer are skipped on re-sync.

### 4b-3. Loyalty history (`PS_LOY_PTS_HIST`)

**Target:** `loyalty_point_ledger` (`reason = 'cp_loy_pts_hist'`, dedupe `metadata.cp_ref`).

**Order:** Runs **after** customer sync so `customers.loyalty_points` reflects Counterpoint’s current balance (`LOY_PTS_BAL` / `PTS_BAL` on `AR_CUST`). Only history rows on or after **`CP_IMPORT_SINCE`** are sent (`CP_LOYALTY_HIST_QUERY`).

**Opening balance:** For a customer with **no** prior ledger rows, the first imported delta uses  
`previous_balance = loyalty_points − Σ(earned − redeemed)` over **that batch’s** rows for the same `cust_no`, so the chain ends at the same total as `AR_CUST`. If Counterpoint data is inconsistent (sum of deltas exceeds current balance), the server clamps the opening to **0** and logs a warning.

**Who gets ledger rows:** Only customers already imported by **`CP_CUSTOMERS_QUERY`** (ticket/note in-range, plus optional store-credit `EXISTS`). There is **no** loyalty-based widening of the customer list.

### 4c. Inventory (stock update only)

**Source:** `dbo.IM_ITEM` (or `dbo.IM_INV`)
**Target:** `product_variants` (existing rows only — does not create)
**Key:** `counterpoint_item_key` or `sku` match

Updates `stock_on_hand` and optionally `cost_override`. This is a lightweight sync for stores that maintain Counterpoint as the stock-of-record and only need ROS to reflect current quantities.

Default **`CP_INVENTORY_QUERY`** pulls **MAIN** `IM_INV` rows with **non-zero `QTY_ON_HND`** **or** `ITEM_NO` on a **closed ticket** on or after **`CP_IMPORT_SINCE`**, parallel to the “active SKU” idea used for catalog (matrix stock often lives in **`IM_INV_CELL`**—handled on the catalog side).

### 4c-2. Vendors

**Source:** `dbo.AP_VEND`
**Target:** `vendors`
**Key:** `VEND_NO` → `vendors.vendor_code`

| Counterpoint | ROS |
|--------------|-----|
| `VEND_NO` | `vendor_code` |
| `NAM` | `name` |
| `PHONE_1` | `phone` |
| `EMAIL_ADRS_1` | `email` |

**Sync vendors before catalog** so that `VEND_NO` on products resolves to `products.primary_vendor_id`. The catalog upsert looks up `vendors.vendor_code` to set the FK.

### 4d. Catalog (product + variant creation)

**Source:** `dbo.IM_ITEM` + `dbo.IM_PRC` + `dbo.IM_INV` + `dbo.IM_BARCOD` (parent products) + `dbo.IM_INV_CELL` (grid cells / matrix variants)
**Target:** `products` + `product_variants`
**Key:** `item_no` → product lookup via variants' `counterpoint_item_key`

| Counterpoint | ROS | Notes |
|--------------|-----|-------|
| `IM_ITEM.ITEM_NO` | Product lookup key | Stored as `counterpoint_item_key` on the default variant |
| `IM_ITEM.DESCR` | `products.name` | Short description → product name |
| `IM_ITEM.LONG_DESCR` | `products.description` | Full description / body text |
| `IM_ITEM.CATEG_COD` | `products.category_id` | Resolved via `counterpoint_category_map` or name match |
| `IM_ITEM.VEND_NO` | `products.primary_vendor_id` | Resolved via `vendors.vendor_code` |
| `IM_ITEM.IS_GRD` | Grid flag | Drives single-variant vs multi-variant creation |
| `IM_PRC.PRC_1` | `products.base_retail_price` | Primary price tier |
| `IM_INV.LST_COST` | `products.base_cost` | Last cost from inventory valuation |
| `IM_BARCOD.BARCOD` | `product_variants.barcode` / `sku` | UPC cross-reference |
| `IM_INV_CELL.CELL_DESCR` | `product_variants.counterpoint_item_key` | Grid cell → variant key |
| `IM_INV_CELL.DIM_1_VAL` / `DIM_2_VAL` | `product_variants.variation_label` | Combined as "Size / Color" |
| `IM_INV_CELL.MIN_QTY` | `product_variants.reorder_point` | Minimum stock threshold |

**Provenance:** Products created by this sync get `data_source = 'counterpoint'` (migration 85). Products that already exist (matched via their variants' `counterpoint_item_key`) are updated but their `data_source` is not overwritten.

**Default “active” catalog (bridge 0.6.5+):** **`CP_CATALOG_QUERY`** limits **`IM_ITEM`** to rows that have **(a)** a **non-zero `QTY_ON_HND`** on **MAIN** `IM_INV`, **or (b)** a **non-zero** `QTY_ON_HND` on **any `IM_INV_CELL`** for that parent, **or (c)** **`ITEM_NO` on a closed-ticket line** (`DOC_TYP = 'T'`) with **`BUS_DAT >= CP_IMPORT_SINCE`**. **`CP_CATALOG_CELLS_QUERY`**, **`CP_VENDORS_QUERY`**, and **`CP_VEND_ITEM_QUERY`** follow the same product scope so vendors and vendor cross-refs do not pull dead SKUs. This does **not** read **`IM_HST_TRX`** / receipt history; if you must keep items that only moved on receipts with zero current qty and no in-range sale, extend the SQL in SSMS. If ticket lines store **child** SKUs in **`CELL_DESCR`** only, add an **`OR EXISTS`** join that ties **`PS_TKT_HIST_LIN.ITEM_NO`** to **`IM_INV_CELL.CELL_DESCR`** for the parent **`ITEM_NO`**.

**Category mapping:** The bridge sends a `category` string from `CATEG_COD`. ROS looks up `counterpoint_category_map` first (admin-configurable), then falls back to a case-insensitive name match in `categories`. Unmapped categories result in `category_id = NULL` on the product.

### 4e. Gift cards

**Source:** `dbo.SY_GFT_CERT` (active cards) + `dbo.SY_GFT_CERT_HIST` (lifecycle events)
**Target:** `gift_cards` + `gift_card_events`
**Key:** `GFT_CERT_NO` → `gift_cards.code`

| Counterpoint | ROS |
|--------------|-----|
| `SY_GFT_CERT.GFT_CERT_NO` | `gift_cards.code` |
| `SY_GFT_CERT.BAL_AMT` | `gift_cards.current_balance` |
| `SY_GFT_CERT.ORIG_AMT` | `gift_cards.original_value` |
| `SY_GFT_CERT.ISSUE_DAT` | `gift_cards.created_at` + drives `expires_at` computation |
| `SY_GFT_CERT.REASON_COD` | `gift_cards.card_kind` (via `counterpoint_gift_reason_map`) |
| `SY_GFT_CERT_HIST.ACTION` | `gift_card_events.event_kind` (Issue/Redeem → event type) |
| `SY_GFT_CERT_HIST.AMT` | `gift_card_events.amount` |
| `SY_GFT_CERT_HIST.TKT_NO` | `gift_card_events.notes` (stored as "Ticket TKT_NO") |
| `SY_GFT_CERT_HIST.TRX_DAT` | `gift_card_events.created_at` |

**Reason code mapping:** `REASON_COD` values are resolved through `counterpoint_gift_reason_map`. If no mapping exists, the card defaults to `purchased`. Admins can populate the map via SQL or a future Settings UI.

**Expiration rules:** When no explicit `expires_at` is provided, expiration is computed from `ISSUE_DAT` + card kind:

| Card kind | Expiry from issue date |
|-----------|----------------------|
| `purchased` (liability) | **9 years** |
| `loyalty_reward`, `donated_giveaway` | **1 year** |

If `ISSUE_DAT` is also absent, `NOW()` is used as the issue baseline.

**Gift card history:** Set `CP_GFT_CERT_HIST_QUERY` to import the full lifecycle (issues, redeems, adjustments). Leave it empty to import only current balances without event history.

### 4f. Ticket history (orders)

**Source:** `dbo.PS_TKT_HIST` + `PS_TKT_HIST_LIN` + `PS_TKT_HIST_PMT`
**Target:** `orders` + `order_items` + `payment_transactions` + `payment_allocations`
**Key:** `TKT_NO` → `orders.counterpoint_ticket_ref` (unique)

| Counterpoint | ROS |
|--------------|-----|
| `PS_TKT_HIST.TKT_NO` | `orders.counterpoint_ticket_ref` |
| `PS_TKT_HIST.BUS_DAT` | `orders.booked_at` |
| `PS_TKT_HIST.TOT` | `orders.total_price` |
| `PS_TKT_HIST.CUST_NO` | `orders.customer_id` (resolved via `customer_code`) |
| `PS_TKT_HIST.USR_ID` | `orders.processed_by_staff_id` (resolved via `counterpoint_staff_map`) |
| `PS_TKT_HIST.SLS_REP` | `orders.primary_salesperson_id` + `order_items.salesperson_id` (resolved via `counterpoint_staff_map`) |
| `PS_TKT_HIST_LIN.ITEM_NO` + `LIN_SEQ_NO` | `order_items.variant_id` (with `PS_TKT_HIST_CELL` the bridge builds the same matrix `counterpoint_item_key` as `IM_INV_CELL`) |
| `PS_TKT_HIST_PMT.PMT_TYP` | `payment_transactions.payment_method` (via `counterpoint_payment_method_map`) |
| `PS_TKT_HIST_GFT` | `payment_transactions` (`gift_card`) + `gift_card_events` (redemption); load/issue-like `ACTION` values are skipped server-side |
| `PS_LOY_PTS_HIST` | `loyalty_point_ledger` (`reason = 'cp_loy_pts_hist'`, idempotent `metadata.cp_ref`) |
| `PO_VEND_ITEM` | `vendor_supplier_item` (links `vendors.vendor_code` + CP `ITEM_NO` to `product_variants` when resolvable) |
| — | `orders.counterpoint_customer_code` | Original CP customer code preserved for audit fallback |

**Idempotency:** If an order with the same `counterpoint_ticket_ref` already exists, the entire ticket is **skipped** (no duplicates).

**Provenance:** All imported orders have `is_counterpoint_import = true`. This flag ensures:
- Loyalty point accrual is **skipped** (no double-counting with Counterpoint's loyalty system)
- The order is identifiable as historical import in reports and UI

**Payment method mapping:** Pre-seeded in migration 84:

| Counterpoint `PAY_COD` | ROS `payment_method` |
|-------------------------|----------------------|
| `CASH` | `cash` |
| `CHECK` | `check` |
| `CREDIT CARD` | `credit_card` |
| `DEBIT` | `credit_card` |
| `GIFT CERT` | `gift_card` |
| `ON ACCOUNT` | `on_account` |

Add custom mappings by inserting into `counterpoint_payment_method_map`.

### 4f-2. Customer ID Matching & Prefix Logic (v0.8.0+)
To handle mixed Counterpoint ID formats (legacy integers vs. newer `C-` prefixed strings), the ROS sync service employs a bidirectional resolution strategy during ticket and open-doc imports:

1. **Exact Match**: Checks `customer_code` in the local DB.
2. **Prefix fallback**: High-performance query checks for both `code` and `'C-' + code`.
3. **Stripped fallback**: Checks the raw integer if the ticket provides a `C-` prefixed string but the DB lacks it.
4. **Audit Fallback**: Every imported transaction stores the original code in `counterpoint_customer_code`. If a match fails, the UI displays `CP: [CODE]` instead of "Walk-in" to maintain logistical clarity.

### 4g. API endpoints reference

| Endpoint | Entity | Method |
|----------|--------|--------|
| `POST /api/sync/counterpoint/staff` | Staff (users + reps + buyers) | M2M |
| `POST /api/sync/counterpoint/sales-rep-stubs` | Orphan `SLS_REP` codes from AR_CUST / tickets when `PS_SLS_REP` is not synced | M2M |
| `POST /api/sync/counterpoint/vendors` | Vendors | M2M |
| `POST /api/sync/counterpoint/customers` | Customers | M2M |
| `POST /api/sync/counterpoint/customer-notes` | Customer notes | M2M |
| `POST /api/sync/counterpoint/inventory` | Stock update | M2M |
| `POST /api/sync/counterpoint/catalog` | Products + variants | M2M |
| `POST /api/sync/counterpoint/gift-cards` | Gift cards + events | M2M |
| `POST /api/sync/counterpoint/tickets` | Orders + payments (+ optional gift applications in payload) | M2M |
| `POST /api/sync/counterpoint/vendor-items` | `PO_VEND_ITEM` → `vendor_supplier_item` | M2M |
| `POST /api/sync/counterpoint/loyalty-hist` | `PS_LOY_PTS_HIST` → `loyalty_point_ledger` | M2M |
| `POST /api/sync/counterpoint/heartbeat` | Bridge status | M2M |
| `POST /api/sync/counterpoint/request/ack` | Ack sync request | M2M |
| `POST /api/sync/counterpoint/request/complete` | Complete sync request | M2M |
| `GET /api/settings/counterpoint-sync/status` | Dashboard status | Staff-gated |
| `POST /api/settings/counterpoint-sync/request-run` | Request sync | Staff-gated |
| `PATCH /api/settings/counterpoint-sync/issues/{id}/resolve` | Resolve issue | Staff-gated |

### 4h. Coverage summary — Counterpoint tables

| CP Table | Synced? | Notes |
|----------|---------|-------|
| `SY_USR` | **Yes** | System users → `staff` + `counterpoint_staff_map` (source = `user`) |
| `PS_SLS_REP` | **Yes** | Sales reps → `staff` + `counterpoint_staff_map` (source = `sales_rep`) |
| `PO_BUYER` | **Yes** | Buyers → `staff` + `counterpoint_staff_map` (source = `buyer`) |
| `SY_USR_GRP` | Partial | `USR_GRP_ID` used as role hint (MGR → admin); full group sync deferred |
| `AR_CUST` | **Yes** | Full profile + loyalty + type + A/R balance + preferred rep |
| `AR_CUST_NOTE` | **Yes** | Timeline memos with dedup |
| `PS_LOY_PTS_HIST` | Optional | In-range rows → `loyalty_point_ledger`; `AR_CUST` holds current balance; see §4b-3 |
| `IM_ITEM` | **Yes** | Name, long desc, category, vendor, grid flag |
| `IM_INV_CELL` | **Yes** | Grid variants with DIM labels + reorder_point |
| `IM_PRC` | Partial | `PRC_1` only; multi-tier pricing N/A in ROS |
| `IM_BARCOD` | **Yes** | UPC → barcode/sku on variants |
| `IM_INV` | **Yes** | `QTY_ON_HND`, `LST_COST`, `MIN_QTY` via inventory + catalog sync |
| `PS_TKT_HIST` | **Yes** | Ticket headers → orders (incl. `USR_ID` → `processed_by_staff_id`, `SLS_REP` → `primary_salesperson_id`) |
| `PS_TKT_HIST_LIN` | **Yes** | Line items → order_items |
| `PS_TKT_HIST_CELL` | Deferred | Matrix-level line detail; line query covers ITEM_NO resolution |
| `PS_TKT_HIST_PMT` | **Yes** | Payment tenders → payment_transactions |
| `PS_TKT_HIST_GFT` | Deferred | Gift card usage linkage per ticket |
| `SY_GFT_CERT` | **Yes** | Active gift cards |
| `SY_GFT_CERT_HIST` | **Yes** | Full lifecycle events |
| `SY_EVENT` | Deferred | Z-Out history (ROS has own register sessions) |
| `IM_HST_TRX` | Deferred | Inventory audit trail (historical reference) |
| `IM_ADJ_HIST` | Deferred | Stock adjustment reasons (historical reference) |
| `IM_PRC_HIST` | Deferred | Price change audit (historical reference) |
| `PS_DOC` / `PS_DOC_LIN` / `PS_DOC_PMT` | Shipped (bridge opt-in) | `SYNC_OPEN_DOCS=1`, migration **91**, `POST /api/sync/counterpoint/open-docs` — **`docs/COUNTERPOINT_ONE_TIME_IMPORT.md`** |
| `AP_VEND` | **Yes** | Vendor master profiles |
| `PO_VEND_ITEM` | Deferred | Vendor SKU cross-reference |
| `PO_RECV_*` | Deferred | Historical receiving (ROS has own PO system) |
| `PO_HDR` / `PO_LIN` | Deferred | Open POs (ROS has own purchase orders) |

---

## 5. Bridge heartbeat and status

The bridge sends a heartbeat to ROS every poll cycle:

```
POST /api/sync/counterpoint/heartbeat
{
  "bridge_phase": "idle",        // or "syncing"
  "current_entity": null,        // e.g. "catalog" when syncing
  "bridge_version": "2.0.0",
  "bridge_hostname": "CP-SERVER"
}
```

ROS stores this in the `counterpoint_bridge_heartbeat` singleton table and derives:

| State | Meaning |
|-------|---------|
| **ONLINE** | Token configured, heartbeat fresh, phase = `idle` |
| **SYNCING** | Token configured, heartbeat fresh, phase = `syncing` (shows current entity) |
| **OFFLINE** | Token not configured **or** no heartbeat in the last 2 minutes |

**Polling Stability:** To prevent console spam when the shop is closed (bridge unreachable), the Back Office Settings UI will stop automatic polling after **3 consecutive failures**. Use the **"Reconnect to Bridge"** button to resume monitoring once you are back in the store.

---

## 13. Performance & Parallelization (v0.7.3+)

The bridge now utilizes a high-concurrency "Hyper-Speed" engine to maximize throughput, especially during large matrix-catalog or historical-ticket imports.

### Concurrency Tuning
The bridge maintains a dedicated concurrency pool for each entity. You can tune performance in `.env`:

- **`BATCH_SIZE`** (Default: 200): The number of rows processed in a single SQL operation and sent in one HTTP POST. Larger batches reduce HTTP overhead but increase memory usage per request.
- **Max Concurrency** (Internal: 5): The bridge allows up to 5 parallel batches to be "in flight" at once. This ensures that your SQL Server and ROS API are kept busy without being overwhelmed.
+
### Matrix Mapping Duplicate Squelcher
For stores with heavy matrix use (v8.2 Matrix Mapping Loops), the bridge includes a built-in filter to discard redundant variation rows:
1. **Parent Tracking:** Ensures each Matrix Parent is only processed once per catalog pass.
2. **Dummy Filtering:** variations with blank/NULL SKUs or Item Numbers are discarded before transmission to minimize stream clutter.

### Targeted Entity Sync (v0.7.3+)
The bridge now supports manual requests for specific entities. This is useful for refreshing just `customers` or `inventory` without running a full multi-entity pass.
- **UI Trigger:** Dashboard "Run" buttons for individual entities.
- **Dependency resolution:** If an entity is requested that has dependencies (e.g., `tickets` requiring `customers`), the bridge automatically enqueues the dependencies first.

### Ack/Complete Handshake Protocol
To prevent overlapping sync cycles and improve reliability, the bridge now uses a strict handshake:
1. **Ack (`ack-request`):** The bridge acknowledges receipt of a sync request from the Riverside API.
2. **Concurrency Lock:** The bridge sets an internal `isTickRunning` flag to prevent a scheduled poll from starting while a manual request is active.
3. **Complete (`complete-request`):** Upon successful transmission of all batches, the bridge notifies the Riverside API to update the final sync timestamp and clear the request status.

---


---

## 6. Settings UI — monitoring and control

Navigate to **Settings → Integrations → Counterpoint bridge** (requires `settings.admin` permission).

The panel shows:
- **Bridge status** (Online / Syncing / Offline) with version, hostname, and last-seen timestamp
- **Request sync run** button — enqueues a request that the bridge picks up on its next heartbeat
- **Entity sync history** table — last successful sync, last error, and cursor position per entity
- **Open sync issues** — per-row errors or warnings from the ingest (e.g. unmapped categories, missing variants); each can be dismissed

### API endpoints (staff-gated, `settings.admin`)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/settings/counterpoint-sync/status` | Full status: bridge state, entity runs, open issues |
| `POST` | `/api/settings/counterpoint-sync/request-run` | Enqueue a sync request (bridge polls for it) |
| `PATCH` | `/api/settings/counterpoint-sync/issues/{id}/resolve` | Mark an issue as resolved |

### API endpoints (M2M, sync token)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/sync/counterpoint/health` | Health check |
| `POST` | `/api/sync/counterpoint/heartbeat` | Bridge status + poll for pending requests |
| `POST` | `/api/sync/counterpoint/staff` | Staff batch upsert (users + reps + buyers) |
| `POST` | `/api/sync/counterpoint/sales-rep-stubs` | Minimal staff + map rows for distinct `SLS_REP` codes |
| `POST` | `/api/sync/counterpoint/customers` | Customer batch upsert |
| `POST` | `/api/sync/counterpoint/inventory` | Stock quantity update |
| `POST` | `/api/sync/counterpoint/catalog` | Product + variant upsert |
| `POST` | `/api/sync/counterpoint/gift-cards` | Gift card + event ingest |
| `POST` | `/api/sync/counterpoint/tickets` | Ticket history → orders |
| `POST` | `/api/sync/counterpoint/vendor-items` | `PO_VEND_ITEM` → `vendor_supplier_item` |
| `POST` | `/api/sync/counterpoint/loyalty-hist` | `PS_LOY_PTS_HIST` → `loyalty_point_ledger` |
| `POST` | `/api/sync/counterpoint/ack-request` | Acknowledge a pending sync request |
| `POST` | `/api/sync/counterpoint/complete-request` | Mark a sync request as completed |

---

## 7. Provenance: how imported data is tagged

Every record imported from Counterpoint carries a permanent provenance marker:

| Entity | Provenance column | Value |
|--------|-------------------|-------|
| **Staff** (new) | `data_source` | `'counterpoint'` |
| **Staff** | `counterpoint_user_id` | CP `USR_ID` (if source = user) |
| **Staff** | `counterpoint_sls_rep` | CP `SLS_REP` (if source = sales_rep) |
| **Customers** (new) | `customer_created_source` | `'counterpoint'` |
| **Products** (new) | `data_source` | `'counterpoint'` |
| **Product variants** | `counterpoint_item_key` | CP composite key (e.g. `CELL_DESCR`) |
| **Orders** | `is_counterpoint_import` | `true` |
| **Orders** | `counterpoint_ticket_ref` | Ticket number (unique) |
| **Orders** | `processed_by_staff_id` | Resolved from `USR_ID` via staff map |
| **Orders** | `primary_salesperson_id` | Resolved from `SLS_REP` via staff map |
| **Gift cards** | `code` | Certificate number from CP |

These markers are never overwritten by subsequent syncs and can be used for:
- Filtering imported vs native records in reports
- Preventing loyalty double-counting on historical orders
- Auditing data origin in the CRM and inventory views

---

## 8. Mapping tables (admin-configurable)

Four mapping tables allow the admin to control how Counterpoint values translate to ROS:

### `counterpoint_staff_map`

| Column | Purpose |
|--------|---------|
| `cp_code` | Counterpoint identifier (`USR_ID`, `SLS_REP`, or `BUYER_ID`) |
| `cp_source` | Source type: `user`, `sales_rep`, or `buyer` |
| `ros_staff_id` | UUID of the ROS `staff` row |

Auto-populated by the staff sync. Used to resolve `USR_ID` / `SLS_REP` references on customers and orders. Unique on `(cp_code, cp_source)`.

### `counterpoint_category_map`

| Column | Purpose |
|--------|---------|
| `cp_category` | Counterpoint category string (exact match) |
| `ros_category_id` | UUID of the ROS `categories` row |

When a catalog sync sends a `category` value, ROS checks this table first. If no mapping is found, it does a case-insensitive name lookup in `categories`.

### `counterpoint_payment_method_map`

| Column | Purpose |
|--------|---------|
| `cp_pmt_typ` | Counterpoint `PAY_COD` value |
| `ros_method` | ROS `payment_method` string (e.g. `cash`, `credit_card`, `check`, `gift_card`, `on_account`) |

Pre-seeded with common mappings. Add rows for store-specific tender types.

### `counterpoint_gift_reason_map`

| Column | Purpose |
|--------|---------|
| `cp_reason_cod` | Counterpoint `REASON_COD` value |
| `ros_card_kind` | ROS `gift_card_kind` value (`purchased`, `loyalty_reward`, `donated_giveaway`) |

Unmapped reason codes default to `purchased`.

---

## 9. Date-range filtering (recommended)

You do **not** have to import the full Counterpoint history. The `.env.example` uses **`CP_IMPORT_SINCE`** (default **2021-01-01**) expanded as **`__CP_IMPORT_SINCE__`** in ticket, note, loyalty, gift-history, **customer**, and **inventory** templates. Adjust **`CP_IMPORT_SINCE`** once rather than editing every date literal.

### What to filter vs. keep full

| Entity | Filter? | Reason |
|--------|---------|--------|
| **Tickets** (`PS_TKT_HIST` + LIN + PMT) | **Yes** — `BUS_DAT >= __CP_IMPORT_SINCE__` | Largest volume |
| **Customer notes** (`AR_CUST_NOTE`) | **Typical** — `NOTE_DAT >= __CP_IMPORT_SINCE__` | Aligns with customer import window |
| **Gift card history** (`SY_GFT_CERT_HIST`) | **Optional** — `TRX_DAT >= __CP_IMPORT_SINCE__` | Balances from `SY_GFT_CERT`; history is supplementary |
| **Staff** (`SY_USR`, `PS_SLS_REP`) | **Full sync** | Small table; tickets reference staff |
| **Customers** (`AR_CUST`) | **Default: ticket, in-range note, or positive `MERCH_CR_BAL`** (adjust in `.env`) when store-credit sync is on | Loyalty does **not** widen the list |
| **Vendors** (`PO_VEND`) | **Default: vendors of “active” items only** | Matches trimmed catalog |
| **Catalog** (`IM_ITEM` + cells) | **Default: active items** (in-range sale, MAIN qty ≠ 0, or matrix cell qty ≠ 0) | Not full `IM_ITEM`; not `IM_HST_TRX` |
| **Inventory** (`IM_INV` MAIN) | **Default: non-zero on-hand or SKU on in-range ticket** | Full `IM_INV` optional in `.env` comment |
| **Gift cards** (`SY_GFT_CERT`) | **Full sync** | Need current balances regardless of issue date |

### How to change the cutoff

Edit the date literal in the bridge `.env` queries. For example, to import from July 2023 instead:

```sql
-- Change '2024-01-01' to '2023-07-01' in all three ticket queries:
... WHERE DOC_TYP = 'T' AND BUS_DAT >= '2023-07-01' ORDER BY ...
```

To import **everything**, simply remove the `AND BUS_DAT >= ...` clause.

> **Tip:** If you later decide you need older data, just widen the date filter and re-run. Tickets are idempotent on `counterpoint_ticket_ref` — already-imported tickets are skipped, and only the newly-qualifying ones are added.

---

## 10. SQL query customization

Each entity sync uses a configurable SQL query in the bridge `.env` file. Counterpoint databases vary by version and customer configuration — always verify column names in SSMS first.

**Tips:**
- Use `SELECT TOP 5 * FROM dbo.<table>` in SSMS to confirm available columns
- Always `RTRIM(LTRIM(...))` string columns — Counterpoint uses fixed-width `CHAR` fields
- Use column **aliases** that match the expected payload keys (see `.env.example`)
- The `ORDER BY` clause determines cursor position for incremental syncs
- **Mandatory for `CP_CUSTOMERS_QUERY`**: If `SYNC_STORE_CREDIT_OPENING=1` is enabled, the bridge validator enforces a strict structure:
    - You MUST include a `WHERE` clause (e.g., `WHERE c.CUST_NO IS NOT NULL`).
    - You MUST end the query with `ORDER BY c.CUST_NO` (the bridge appends an `OR EXISTS` filter immediately before the order clause during store credit discovery).
- `WHERE STAT = 'A'` filters to active items in `IM_ITEM`

---

## 11. Operational checklist

### First-time setup

1. Generate a secure sync token (e.g. `openssl rand -hex 32`)
2. Set `COUNTERPOINT_SYNC_TOKEN` in both `server/.env` and bridge `.env`
3. Apply migrations 84–86 (`./scripts/apply-migrations-docker.sh`)
4. Restart the ROS Rust server
5. Verify health endpoint from the bridge host
6. Install Node.js on the Counterpoint Windows host
7. Copy `counterpoint-bridge/` folder, run `npm install`, configure `.env`
8. Start with `SYNC_STAFF=1` to bring in users and sales reps, then `SYNC_CUSTOMERS=1` and verify data appears in ROS
9. Enable additional entities one at a time: vendors → catalog → gift cards → tickets
10. Monitor progress in **Settings → Integrations → Counterpoint bridge**

### Ongoing monitoring

- Check bridge status in Settings regularly (or check `counterpoint_bridge_heartbeat.last_seen_at`)
- Review and dismiss sync issues as they appear
- Use **Request sync run** when you need an immediate refresh
- If the bridge shows OFFLINE, check that the Windows process is running and the network path is open

### Troubleshooting

| Symptom | Check |
|---------|-------|
| Bridge shows **OFFLINE** in Settings | Is the Node.js process running on the CP host? Is the network path open (firewall on port 3000)? |
| `invalid or missing sync token` | Token in bridge `.env` must **exactly** match `COUNTERPOINT_SYNC_TOKEN` in `server/.env` |
| `Connection refused` from bridge | ROS server not running, or firewall blocking port 3000 from the CP host |
| `invalid object name` on SQL | Check `Database=` in `SQL_CONNECTION_STRING` — must be the Counterpoint company DB, not `master` |
| Customers sync but email is missing | Email was on another customer in ROS (unique constraint); check `email_conflicts` in the response |
| Products created without category | Add a row to `counterpoint_category_map` for the CP category string, or create a matching category name in ROS |
| Duplicate ticket warning | Order with that `counterpoint_ticket_ref` already exists — idempotent skip, not an error |
| Payment method shows as `cash` for everything | Add missing `PAY_COD` values to `counterpoint_payment_method_map` |
| Gift cards all default to `purchased` | Add `REASON_COD` values to `counterpoint_gift_reason_map` |

---

## 12. Security notes

- **RBAC:** The Settings monitoring endpoints require `settings.admin` staff permission. M2M ingest endpoints require only the sync token (no staff headers).

---

## 14. Operation Modes

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Manual (Default)** | Dashboard trigger / Sync Request | One-off targeted entity or full pass. |
| **Continuous** | Dashboard Toggle | Syncs every 15 minutes (configurable via `POLL_INTERVAL_MS`). |
| **Run Once** | `RUN_ONCE=1` / `import` | Executes a full sync pass and exits immediately. |

To switch a running bridge to Continuous sync, visit `http://localhost:3002` and flip the toggle in the "Operation Mode" card.
