# Counterpoint SQL Server → Riverside OS: Sync Guide

End-to-end reference for setting up and operating the one-way Counterpoint transition into **ROS PostgreSQL**. The go-live architecture is **Counterpoint Bridge extracts raw data → Main Hub ROS imports and proofs data → staff resolves exceptions → staff signs off the import**.

**Companion docs:**
- [`COUNTERPOINT_BRIDGE_OPERATOR_MANUAL.md`](COUNTERPOINT_BRIDGE_OPERATOR_MANUAL.md) — operator manual: Main Hub target, prerequisites, bridge/API updates, troubleshooting
- [`WEDDING_COUNTERPOINT_CUTOVER_LINKING.md`](WEDDING_COUNTERPOINT_CUTOVER_LINKING.md) — how imported wedding parties are reviewed and linked to Counterpoint-synced customers, transactions, and item lifecycle states
- [`PLAN_COUNTERPOINT_ROS_SYNC.md`](PLAN_COUNTERPOINT_ROS_SYNC.md) — implementation roadmap and schema mapping tables
- [`counterpoint-bridge/INSTALL_ON_COUNTERPOINT_SERVER.txt`](../counterpoint-bridge/INSTALL_ON_COUNTERPOINT_SERVER.txt) — quick-start instructions for the Windows operator
- [`counterpoint-bridge/.env.example`](../counterpoint-bridge/.env.example) — Bridge connection template
- [`COUNTERPOINT_DIRECT_IMPORT_RUNBOOK.md`](COUNTERPOINT_DIRECT_IMPORT_RUNBOOK.md) — recorded go-live direct import path and historical backfill guardrails

**Import Command Center:**
The Counterpoint screen in **Settings → Integrations → Counterpoint** is the ROS final approval surface. The operator workflow is Bridge connection, source-count proof, direct ROS import, import exceptions, customer duplicate review, final proof, and support diagnostics.

1. **Bridge heartbeat** - extraction host heartbeat/status only
2. **Main Hub ROS intake** - Bridge heartbeat and ROS intake health
3. **Source proof** - Bridge source counts compared to ROS-landed rows
4. **Import exceptions** - rows that need correction before sign-off
5. **Customer duplicates** - duplicate customer review after customers land
6. **Final proof / diagnostics** - current-run proof first; accumulated ROS state is diagnostics only

The Command Center shows a business-area ingest path for Customers, Inventory, Ticket History / Sales Movement, Open Orders, Gift Cards, and Loyalty Points. Each one follows the same control pattern: Bridge extraction → ROS import/proof → staff review/fix → PostgreSQL.

Counterpoint SQL is the source authority for cutover customer profiles, open orders, gift cards, loyalty balances, catalog identity, and inventory quantities. ROS may add deterministic `CP-*` recovery SKUs only when Counterpoint provides a valid item/cell key without a usable `B-*` barcode/SKU. That recovery identity is additive; imports must preserve Counterpoint keys, barcode aliases, balances, quantities, and provenance rather than replacing source data with ROS-generated values.

Advancement is proof-gated. Bridge-reported row counts alone do not unlock cutover. If the Bridge reports suspiciously low ticket or open-doc counts, a wrong ROS base URL, empty required SQL mappings, or a history floor other than January 1, 2024, ROS records a failed preflight and the Bridge blocks the import.

During a direct Bridge run, ROS records source-count proof, raw rows, provenance links to landed ROS rows, exceptions, and landed-row proof for the current import run. Ticket and open-doc line/payment proof is counted from the landed source payload child rows for that import run, so repeat proof stays tied to the Bridge input instead of whatever child rows were rewritten in PostgreSQL. Rows that fail validation remain visible as import exceptions until staff fixes them and reruns the affected import area or ROS can prove the source row landed.

Only completed import runs count as current landed proof. Catalog extraction is completed and deduped before catalog batches are posted to ROS, so a catalog SQL extraction failure does not create a half-catalog import. If any Bridge extraction fails after posting some batches, ROS keeps the failed run auditable but ignores its partial landed rows in the Command Center. Fix the Bridge extraction error, rerun the affected import area or the full import, then refresh proof.

The Command Center also shows **Current next step**. That card is the normal operator guide: start Bridge, run extraction, fix preflight, wait for landed proof, resolve the first exception, review the first required failed area, or move to final sign-off. Support Diagnostics is intentionally secondary and should be used only when the proof path does not explain what is wrong.

Before go-live, another few days of Counterpoint work can be brought into the same ROS import by running **Update Since Last Run** without a reset. ROS import handlers use Counterpoint source keys and provenance to update existing imported rows and add new rows, then proof must be reviewed again. Use **Full Import / Recheck All** when the whole import should be reproved, and use **Reset Counterpoint import** only when the prior import should be discarded.

**Optional SQL objects:** Gift and loyalty tables (Standard examples: **`SY_GFT_CERT`**, **`PS_LOY_PTS_HIST`**) are Counterpoint-style names from product/schema docs. Local installations can use different names such as **`SY_GFC`** (Gift Cards) or **`AR_LOY_PT_ADJ_HIST`** (Loyalty). Always run **`node index.mjs discover`** to confirm your local schema before enabling these modules.

**Migrations:** active baseline migration `081_counterpoint_import_first_proof.sql` adds `counterpoint_import_runs`, `counterpoint_import_source_counts`, `counterpoint_import_raw_records`, `counterpoint_import_provenance`, and `counterpoint_import_exceptions` for ROS import proof. Earlier Counterpoint migrations add item keys, sync runs/issues, mapping tables, staff/customer/catalog provenance, vendor supplier items, and payment-method aliases.

---

## 1. Architecture overview

```
  ┌────────────────────────┐                         ┌──────────────────────────┐
  │  Counterpoint SQL      │  ◄── poll queries ──    │  counterpoint-bridge     │
  │  (Counterpoint PC)     │                         │  extractor only          │
  └────────────────────────┘                         └────────┬─────────────────┘
                                                              │ POST /api/sync/counterpoint/*
                                                              │ source proof + raw JSON batches
                                                             ▼
                                                    ┌──────────────────────────┐
                                                    │ ROS Back Office/API      │
                                                    │ preflight/import/proof   │
                                                    ├──────────────────────────┤
                                                    │ PostgreSQL via existing  │
                                                    │ Rust/sqlx import logic   │
                                                    └──────────────────────────┘
```

The bridge is a small Node.js process that:
1. Polls Counterpoint SQL Server using configurable queries
2. Maps rows to ROS-compatible JSON payloads
3. POSTs extraction batches directly to the Main Hub ROS intake
4. Sends periodic **heartbeats** so the operator can distinguish Bridge health from ROS import health

All data flows **one way**: Counterpoint → ROS. The Bridge never writes directly to ROS PostgreSQL; it writes only through the existing ROS API import handlers, and ROS never writes back to Counterpoint.

---

## 2. Server-side setup (ROS)

### 2a. Apply migrations

From the repo root (Postgres must be running via `docker compose up -d`):

```bash
./scripts/apply-migrations-docker.sh
```

The active migration layout currently runs through **081**. Migration **081** creates the ROS import run, source-count, raw-record, provenance, and exception proof tables. Verify:

```bash
./scripts/migration-status-docker.sh | grep "081_counterpoint_import_first_proof"
```

### 2b. Configure the Bridge target

The Bridge target is the Main Hub ROS URL on port 3000. On the Counterpoint PC, enter only:

```env
ROS_BASE_URL=http://main-hub-or-main-hub-lan-ip:3000
```

The Bridge GUI also accepts the full Counterpoint SQL connection string. If the SQL connection string is copied from a `.env` file, paste only the value inside `SQL_CONNECTION_STRING="..."`, not the variable name or surrounding quotes.

If Backoffice Settings refuses to save credentials with `RIVERSIDE_CREDENTIALS_KEY must be set`, run **`Repair-RiversideCredentialsKey.cmd`** from the Windows deployment package on the Main Hub. The repair writes the credential encryption key into the installed server `.env` and Windows machine environment, then restarts the Riverside server task.

### 2c. Start the Bridge

On the Counterpoint PC, open **Riverside Counterpoint Bridge**, confirm:

- Counterpoint SQL saved
- Main Hub ROS intake ready
- Auto Config / Schema Alignment verified

Then run **Full Import / Recheck All**. The Bridge posts each supported domain directly to ROS. ROS owns source-count proof, exceptions, landed proof, duplicate review, and final sign-off.

### 2d. Verify health endpoints

Use **Check Main Hub ROS** in the Bridge GUI, or open this from the Counterpoint PC:

```text
http://<main-hub-lan-ip>:3000/api/sync/counterpoint/health
```

The Bridge should report that Main Hub ROS intake is ready before extraction starts.

To verify the local Bridge control server itself, open this from the Counterpoint PC:

```text
http://127.0.0.1:3002/api/status
```

The compatibility health URL below is also supported for simple health probes:

```text
http://127.0.0.1:3002/api/bridge/health
```

### 2e. Bridge Command Center
The bridge includes a local dashboard for manual triggers and log monitoring. It listens on port **3002** (to avoid collision with Metabase on 3001).
- **URL**: `http://localhost:3002`
- **Manual Mode (Default)**: By default, the bridge starts in manual mode. It checks Main Hub ROS health and waits for a staff-triggered extraction.
- **Continuous Sync**: Do not use continuous sync for the go-live cutover. Run the intentional extraction, review proof, fix exceptions, then sign off.
- **Auth**: The dashboard uses the local Bridge process to communicate with the ROS API. Staff approval and final import decisions remain in ROS.

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
SQL_CONNECTION_STRING=Server=localhost\RMSSVR;Database=Riverside;User Id=ros_cp_login;Password=secret;Encrypt=true;TrustServerCertificate=true
```

Key fields:
- `ROS_BASE_URL` — Main Hub ROS API target on port 3000.
- `SQL_CONNECTION_STRING` — standard `mssql` connection string; `Database=` must be the Counterpoint **company** database (same one you connect to in SSMS)

### 3c. Confirm Runtime Mappings

Normal setup does not add entity SQL or entity flags to `.env`. The bridge probes the NCR Counterpoint POS v8.4 company database and generates runtime mappings for the tables and columns that are actually visible.

| Entity | Runtime source family |
|--------|-----------------------|
| Staff, sales reps, buyers | `SY_USR`, `PS_SLS_REP`, `PO_BUYER` when visible |
| Vendor profiles and item links | `PO_VEND`, `PO_VEND_ITEM` |
| Customers, loyalty balances, notes, store credit | `AR_CUST`, `AR_CUST_NOTE`, visible store-credit source |
| Catalog, matrix variants, barcodes, prices, costs | `IM_ITEM`, `IM_INV`, `IM_INV_CELL`, `IM_PRC`, `IM_BARCOD` when visible |
| Inventory quantities | `IM_INV` plus matrix cell quantity sources when visible |
| Gift-card current balances | `SY_GFT_CERT` or supported local gift-card master |
| Historical tickets, lines, payments, notes | `PS_TKT_HIST`, `PS_TKT_HIST_LIN`, `PS_TKT_HIST_PMT`, note tables when visible |
| Open Counterpoint docs | `PS_DOC_*` family when visible |

Use the GUI Auto Config action or `node index.mjs auto-config` after `SQL_CONNECTION_STRING` is set. Old `CP_*_QUERY` entries are ignored unless `CP_SQL_ENV_OVERRIDES=1` is explicitly set for expert recovery work.

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

**Archiving non-current staff:** Staff with `STAT = 'I'` in Counterpoint are imported with `is_active = false`. They appear in the Staff list but cannot be assigned to registers, tasks, or schedules. Their historical sales data remains linked via `transactions.processed_by_staff_id` and `transaction_lines.salesperson_id`.

**Downstream attribution (after staff sync):**

| Context | CP Field | ROS Column |
|---------|----------|------------|
| **Ticket headers** (`PS_TKT_HIST`) | `USR_ID` | `transactions.processed_by_staff_id` — who rang up the sale |
| **Ticket headers** (`PS_TKT_HIST`) | `SLS_REP` | `transactions.primary_salesperson_id` + `transaction_lines.salesperson_id` — commission recipient |
| **Customer profiles** (`AR_CUST`) | `SLS_REP` | `customers.preferred_salesperson_id` — home/preferred rep |
| **Customer notes** (`AR_CUST_NOTE`) | `USR_ID` | Embedded in note body as `[CP:NOTE_ID] USR_ID` |

> **Sync order matters:** Staff **must** be synced before customers and tickets. If staff are not yet in the map, `USR_ID` / `SLS_REP` references on customers and Transaction Records will be `NULL` (they can be backfilled by re-running the customer/ticket sync after staff are present).

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
| `PTS_BAL` / `LOY_PTS_BAL` | `loyalty_points` | Current integer points balance snapshot |
| `CUST_TYP` | `custom_field_1` | Customer type tag (e.g., "RETAIL", "WHOLESALE") |
| `BAL` | `custom_field_2` | A/R balance (stored as string for reference) |
| `SLS_REP` | `preferred_salesperson_id` | Resolved via `counterpoint_staff_map` (sync staff first) |

**Provenance & Lifetime Value:** New customers created by this sync get `customer_created_source = 'counterpoint'`. Riverside OS does **not** use a static `lifetime_sales` column from Counterpoint. It derives spend from imported ticket history that actually lands in ROS.

**Current bridge default:** the supported bridge setup keeps `.env` to `ROS_BASE_URL`, `COUNTERPOINT_SYNC_TOKEN`, and `SQL_CONNECTION_STRING`. For Riverside's NCR Counterpoint POS v8.4 environment, the bridge probes `INFORMATION_SCHEMA` and builds runtime extraction SQL for the live company database.
**Open Documents:** Runtime mappings for open documents pull the active backlog (Layaways, Quotes, Special Orders) when the `PS_DOC*` tables are visible.
Customer sync maps the full **`AR_CUST`** base, not just ticket-active customers, so ROS preserves customer identity, loyalty balances, store credit ownership, and open-doc ownership from the same migration pass. If an expert override narrows the customer query for rehearsal work, treat that as a scope change and verify the impact on loyalty, store credit, and open-doc customer linking before sign-off.

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

### 4b-3. Loyalty current balance and optional history

**Current cutover scope:** loyalty imports as a current point-balance snapshot on `customers.loyalty_points`. The runtime mapper selects the live Counterpoint current points column (`LOY_PTS_BAL`, `PTS_BAL`, or `LOY_PTS`) as `pts_bal` when present.

**Historical loyalty activity is not imported for cutover.** Keep this disabled unless a separate historical replay is explicitly requested later.

**Cutover proof:** After customer sync posts `AR_CUST` rows, the bridge sends the Counterpoint source customer count and current point sum to ROS. **Landing Verification** compares those source values to Counterpoint-created ROS customer count and `customers.loyalty_points` sum and shows pass/fail.

**Optional history target:** `loyalty_point_ledger` (`reason = 'cp_loy_pts_hist'`, dedupe `metadata.cp_ref`).

**Order if explicitly enabled later:** Runs **after** customer sync so `customers.loyalty_points` reflects Counterpoint’s current balance (`LOY_PTS_BAL` / `PTS_BAL` on `AR_CUST`). Historical loyalty replay is not part of the normal v8.4 go-live bridge path.

**Opening balance:** For a customer with **no** prior ledger rows, the first imported delta uses  
`previous_balance = loyalty_points − Σ(earned − redeemed)` over **that batch’s** rows for the same `cust_no`, so the chain ends at the same total as `AR_CUST`. If Counterpoint data is inconsistent (sum of deltas exceeds current balance), the server clamps the opening to **0** and logs a warning.

**Who gets ledger rows:** Only customers already imported from **`AR_CUST`**. There is **no** loyalty-based widening of the customer list.

### 4c. Inventory (stock update only)

**Source:** `dbo.IM_ITEM` (or `dbo.IM_INV`)
**Target:** `product_variants` (existing rows only — does not create)
**Key:** `counterpoint_item_key` or `sku` match

Updates `stock_on_hand` and optionally `cost_override`. This is a lightweight sync for stores that maintain Counterpoint as the stock-of-record and only need ROS to reflect current quantities.

Default runtime inventory mapping pulls `IM_INV` rows and `IM_INV_CELL` rows for the configured location (`MAIN` unless overridden in expert mode), including zero-on-hand rows when Counterpoint has an inventory row for that item or cell. Matrix stock often lives in `IM_INV_CELL`.

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

**Default catalog:** the runtime mapper sends Counterpoint parent products that are active now or have evidence since `CP_IMPORT_SINCE` (default January 1, 2024): recent sales, active open docs, receiving activity, or nonzero inventory. It also sends `IM_INV_CELL` matrix cells with their Counterpoint cell keys and quantity fields when that table is visible.

**Matrix family rule:** Counterpoint `I-XXXXX` values are item numbers and act as the ROS product/family key. Every visible `IM_INV_CELL` row for the same `I-XXXXX` must land as a variant under that product. Real Counterpoint `B-XXXXX` barcode/SKU values are source data and must be preserved as scan aliases; imports may add missing `B-XXXXX` aliases or generated `CP-*` recovery SKUs, but must not remove existing Counterpoint barcode data.

**Category mapping:** The bridge sends a `category` string from `CATEG_COD`. ROS looks up `counterpoint_category_map` first (admin-configurable), then falls back to a case-insensitive name match in `categories`. Unmapped categories result in `category_id = NULL` on the product.

**Generated SKU recovery:** If Counterpoint sends a valid item number such as `I-12345` but the SKU/barcode is blank, non-usable, or duplicated, ROS generates a deterministic compact SKU in the form `CP-<digits>`. The Counterpoint item key remains in `counterpoint_item_key`, the row is not discarded solely because the SKU is missing, and ROS records a `generated_sku` import review row with the source payload for staff review. Review those rows before sign-off, then print tags from Inventory using the generated SKU if the generated value is accepted.

### 4e. Gift cards

**Source:** `dbo.SY_GFT_CERT` / `dbo.SY_GFC` current issued-card rows.
**Target:** `gift_cards`
**Key:** `GFT_CERT_NO` → `gift_cards.code`

Gift-card cutover imports only cards with a current open balance. For the Riverside bridge payload, alias the card number as `cert_no` (the bridge and ROS also accept `gft_cert_no` / `gift_cert_no` as compatibility aliases).

| Counterpoint | ROS |
|--------------|-----|
| `SY_GFT_CERT.GFT_CERT_NO` | `gift_cards.code` |
| `SY_GFT_CERT.BAL_AMT` | `gift_cards.current_balance` |
| `SY_GFT_CERT.ORIG_AMT` | `gift_cards.original_value` |
| `SY_GFT_CERT.ISSUE_DAT` | `gift_cards.created_at` + drives `expires_at` computation |
| `SY_GFT_CERT.REASON_COD` | `gift_cards.card_kind` (via `counterpoint_gift_reason_map`) |

**Reason code mapping:** `REASON_COD` values are resolved through `counterpoint_gift_reason_map`. If no mapping exists, the card defaults to `purchased`. Admins can review and update these mappings in **Settings → Counterpoint → Gift reasons** before the accepted cutover run.

**Expiration rules:** When no explicit `expires_at` is provided, expiration is computed from `ISSUE_DAT` + card kind:

| Card kind | Expiry from issue date |
|-----------|----------------------|
| `purchased` (liability) | **9 years** |
| `loyalty_reward`, `donated_giveaway`, `promo_gift_card` | **1 year** |

If `ISSUE_DAT` is also absent, `NOW()` is used as the issue baseline.

**Gift card history:** Historical gift card activity is not imported for cutover. If ticket gift rows are separately enabled later for tender visibility through an expert override, ROS still treats gift cards as current balance snapshots and does not decrement `gift_cards.current_balance`.

**Cutover proof:** After the gift-card runtime mapping posts card masters, the bridge sends the Counterpoint source card count and current-balance sum to ROS. **Landing Verification** compares those source values to `gift_cards` count and `gift_cards.current_balance` sum and shows pass/fail.

### 4f. Ticket history (orders)

**Source:** `dbo.PS_TKT_HIST` + `PS_TKT_HIST_LIN` + `PS_TKT_HIST_PMT`
**Target:** `transactions` + `transaction_lines` + `payment_transactions` + `payment_allocations`
**Key:** generated Counterpoint ticket identity → `transactions.counterpoint_ticket_ref` (unique). The Bridge uses the visible v8.4 identity columns such as store, station, drawer, business date, ticket number, document number, and document id so repeated ticket numbers do not collide.

| Counterpoint | ROS |
|--------------|-----|
| Generated identity from `PS_TKT_HIST` ticket columns | `transactions.counterpoint_ticket_ref` |
| `PS_TKT_HIST.BUS_DAT` | `transactions.booked_at` |
| `PS_TKT_HIST.TOT` | `transactions.total_price` |
| `PS_TKT_HIST_PMT.AMT` + redeeming `PS_TKT_HIST_GFT.AMT` | `transactions.amount_paid` / `transactions.balance_due` when present |
| `PS_TKT_HIST.CUST_NO` | `transactions.customer_id` (resolved via `customer_code`) |
| `PS_TKT_HIST.USR_ID` | `transactions.processed_by_staff_id` (resolved via `counterpoint_staff_map`) |
| `PS_TKT_HIST.SLS_REP` | `transactions.primary_salesperson_id` + `transaction_lines.salesperson_id` (resolved via `counterpoint_staff_map`) |
| `PS_TKT_HIST_LIN.ITEM_NO` + `LIN_SEQ_NO` | `transaction_lines.variant_id` (with `PS_TKT_HIST_CELL` the bridge builds the same matrix `counterpoint_item_key` as `IM_INV_CELL`) |
| Visible `PS_TKT_HIST` tax total columns | `transactions.total_price` gross-up when Counterpoint separates tax from merchandise totals |
| Visible `PS_TKT_HIST_LIN` tax columns | `transaction_lines.state_tax` / `transaction_lines.local_tax` |
| Visible `PS_TKT_HIST_LIN` regular price / discount columns | Discounted `transaction_lines.unit_price` with original Counterpoint price preserved in `size_specs` |
| `PS_TKT_HIST_PMT.PMT_TYP` | `payment_transactions.payment_method` (via `counterpoint_payment_method_map`) |
| `PS_TKT_HIST_GFT` | Optional `payment_transactions` (`gift_card`) tender visibility only; does not decrement `gift_cards.current_balance` |
| `PS_LOY_PTS_HIST` | Optional historical replay only; not required for current loyalty balances |
| `PO_VEND_ITEM` | `vendor_supplier_item` (links `vendors.vendor_code` + CP `ITEM_NO` to `product_variants` when resolvable) |

**Idempotency:** If a Transaction Record with the same `counterpoint_ticket_ref` already exists, the entire ticket is **skipped** (no duplicates).

**Totals / paid semantics:** The runtime mapper sources the gross historical ticket total from the best visible `PS_TKT_HIST` total column. ROS prefers the summed tender history from `PS_TKT_HIST_PMT` for `amount_paid` and `balance_due` whenever those rows are present. If tender rows are absent, ROS falls back to the header `amount_paid` value.

**Header/detail proof:** Closed ticket headers, lines, and payments must be in the same rough order of magnitude. If `PS_TKT_HIST` returns only a tiny number of ticket headers while `PS_TKT_HIST_LIN` or `PS_TKT_HIST_PMT` returns tens of thousands of rows, ROS blocks preflight because the ticket header query/filter is not aligned with the line/payment queries. Rerun Auto Config and verify the ticket date, identity, join, and optional document-type settings before accepting the import.

**Historical sales posture:** Closed ticket rows are imported for customer history, item history, and reporting comparison. They are not active fulfillment obligations. ROS links historical lines to exact variants when the payload has enough SKU/cell detail; unresolved historical lines use the historical Counterpoint fallback item instead of blocking the import. Open documents remain strict because they are current obligations.

### Post-cutover legacy order reconciliation

After Counterpoint imports have ended, **Settings → Counterpoint → Legacy Order Repair** reviews the Counterpoint open-document and ticket records already stored in ROS. It does not contact the Bridge or request another import.

The automatic repair set is intentionally strict: the customer, order total, complete line signature, original same-time ticket, and unique payment set must agree, and the retained payments must equal the order total to the cent. The repair moves legitimate later payment allocations to the original open-document transaction, marks duplicate imported payment/ticket artifacts as superseded, recalculates the original paid amount and balance, and records an append-only audit snapshot in `counterpoint_transaction_reconciliation`.

Any record with multiple possible orders, mismatched lines, non-success payments, indistinguishable later payments, or a remaining total difference is report-only and requires Manager review. Do not merge ambiguous records by customer name, item description, or amount alone.

**Tax and discount import:** Auto Config now selects known Counterpoint header and line tax columns when those columns are visible in the live schema, and maps known regular-price / discount columns so ROS stores the effective discounted unit price instead of the regular price. If Counterpoint exposes only a header tax total, ROS allocates that tax across imported lines. If Counterpoint exposes no tax columns for a historical ticket, the imported line tax remains `0` and existing historical rows must be reimported or backfilled from Counterpoint before they become source-authoritative for tax history.

**Provenance:** Imported Counterpoint Transaction Records have `is_counterpoint_import = true`. This flag ensures:
- Loyalty point accrual is **skipped** (no double-counting with Counterpoint's loyalty system)
- The Transaction Record is identifiable as a historical import in reports and UI

**Payment method mapping:** Pre-seeded by the Counterpoint hardening migrations:

| Counterpoint `PAY_COD` | ROS `payment_method` |
|-------------------------|----------------------|
| `CASH` | `cash` |
| `CHECK` | `check` |
| `CREDIT CARD` | `credit_card` |
| `CREDITCARD` | `credit_card` |
| `DEBIT` | `credit_card` |
| `GIFT CERT` | `gift_card` |
| `ON ACCOUNT` | `on_account` |
| `RMS 90 DAY` | `on_account_rms90` |
| `STORE CRED` | `store_credit` |
| `LOYALTY` | `gift_card` |
| `DONATION` | `gift_card` |
| `PROM GC` | `gift_card` |

ROS ships common Counterpoint tender mappings, and admins can review or change them in **Settings → Counterpoint → Payments**. Unknown tender codes no longer silently fall back to cash; they import as `counterpoint_unmapped`, preserve the original Counterpoint tender code in payment metadata, and create an unresolved sync issue that must be reviewed before sign-off.

Historical tickets are not dropped solely because Counterpoint omitted line detail or provided only an ambiguous parent item key. When a closed historical record has payment/header value but no exact ROS variant can be selected, ROS imports it against the `HIST-CP-FALLBACK` item, preserves the original Counterpoint key in `transaction_lines.vendor_reference`, shows the original Counterpoint description/SKU in order review, and raises a review warning for operator cleanup.

Open documents are stricter because they are active customer obligations. If an open-doc line cannot resolve to a ROS variant after catalog/SKU recovery, ROS keeps the source payload and opens an import exception instead of creating a placeholder line. Fix or relink the missing item through the catalog/inventory import path, rerun Open Orders, and then use Recheck after ROS can prove the same Counterpoint source key landed.

### 4f-2. Customer ID Matching & Prefix Logic (v0.8.0+)
To handle mixed Counterpoint ID formats (plain integers vs. `C-` prefixed strings), the ROS sync service employs a bidirectional resolution strategy during ticket and open-doc imports:

1. **Exact Match**: Checks `customer_code` in the local DB.
2. **Prefix fallback**: High-performance query checks for both `code` and `'C-' + code`.
3. **Stripped fallback**: Checks the raw integer if the ticket provides a `C-` prefixed string but the DB lacks it.
4. **Visibility fallback**: If a ticket or open doc carries a `CUST_NO` that cannot resolve to `customers.customer_code`, ROS still imports the transaction when the item lines resolve, but records an **Open sync issue** for that ticket/doc reference so the missing customer link is visible before cutover sign-off.

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
| `POST /api/sync/counterpoint/gift-cards` | Gift card current balance snapshots | M2M |
| `POST /api/sync/counterpoint/snapshot-reconciliation` | Source count/sum/checksum proof for cutover reconciliation | M2M |
| `POST /api/sync/counterpoint/fidelity-diagnostics` | Bounded live-query mismatch diagnostics for failed inventory/catalog checksum groups | M2M |
| `POST /api/sync/counterpoint/tickets` | Orders + payments (+ optional gift applications in payload) | M2M |
| `POST /api/sync/counterpoint/vendor-items` | `PO_VEND_ITEM` → `vendor_supplier_item` | M2M |
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
| `PS_TKT_HIST` | **Yes** | Ticket headers → Transaction Records (incl. `USR_ID` → `processed_by_staff_id`, `SLS_REP` → `primary_salesperson_id`) |
| `PS_TKT_HIST_LIN` | **Yes** | Line items → transaction_lines |
| `PS_TKT_HIST_CELL` | Deferred | Matrix-level line detail; line query covers ITEM_NO resolution |
| `PS_TKT_HIST_PMT` | **Yes** | Payment tenders → payment_transactions |
| `PS_TKT_HIST_GFT` | Deferred | Gift card usage linkage per ticket |
| `SY_GFT_CERT` | **Yes** | Active gift cards |
| `SY_GFT_CERT_HIST` | **Yes** | Full lifecycle events |
| `SY_EVENT` | Deferred | Z-Out history (ROS has own register sessions) |
| `IM_HST_TRX` | Deferred | Inventory audit trail (historical reference) |
| `IM_ADJ_HIST` | Deferred | Stock adjustment reasons (historical reference) |
| `IM_PRC_HIST` | Deferred | Price change audit (historical reference) |
| `PS_DOC` / `PS_DOC_LIN` / `PS_DOC_PMT` | Shipped when visible through runtime mapping | Migration **91**, `POST /api/sync/counterpoint/open-docs` — **`docs/COUNTERPOINT_ONE_TIME_IMPORT.md`** |
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
| **ONLINE** | Bridge heartbeat fresh, phase = `idle` |
| **SYNCING** | Bridge heartbeat fresh, phase = `syncing` (shows current entity) |
| **OFFLINE** | No heartbeat in the last 2 minutes or the Bridge process is not reachable |

The Main Hub **Counterpoint → Import Command Center** shows a dedicated **Bridge connection status** block for this status. If the Bridge console says the local API is listening but Main Hub shows **No accepted heartbeat**, confirm the Bridge is targeting the Main Hub ROS URL on port 3000 and that the Main Hub API is running.

**Polling Stability:** To prevent console spam when the shop is closed (bridge unreachable), the Back Office Settings UI will stop automatic polling after **3 consecutive failures**. Use **Refresh statuses** to resume monitoring once you are back in the store.

---

## 13. Performance & Parallelization (v0.7.3+)

The bridge now utilizes a high-concurrency "Hyper-Speed" engine to maximize throughput, especially during large matrix-catalog or historical-ticket imports.

### Concurrency Tuning
The bridge maintains a dedicated concurrency pool for each entity. You can tune performance in `.env`:

- **`BATCH_SIZE`** (Default: 200): The number of rows processed in a single SQL operation and sent in one HTTP POST. Larger batches reduce HTTP overhead but increase memory usage per request.
- **Max Concurrency** (Internal: 5): The bridge allows up to 5 parallel batches to be "in flight" at once. This ensures that your SQL Server and ROS API are kept busy without being overwhelmed.

### Batch Failure Accounting
Batch POST failures are not swallowed. The bridge tracks successfully posted rows separately from the SQL source-row count, and any failed chunk now causes the whole entity to fail instead of reporting the source count as a successful import.

When an entity fails, its local bridge cursor does not advance for that failed work. A retry may therefore re-post chunks that had already succeeded before the failure; this is intentional and relies on the ROS ingest endpoints remaining idempotent/upsert-safe. Manual sync requests follow the same rule: if entity posting fails, the bridge completes the request with a failure instead of marking it successful.

The ticket gift-application lookup path is also hardened so gift rows initialize their per-ticket bucket before appending rows.

### Matrix Mapping Duplicate Squelcher
For stores with heavy matrix use, the bridge includes a built-in filter to discard redundant variation rows:
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
- **Landing Verification** — read-only ROS-landed table counts by Counterpoint domain
- **Entity sync history** table — last successful sync, last error, and cursor position per entity
- **Open sync issues** — per-row errors or warnings from the ingest (e.g. unmapped categories, missing variants); each can be dismissed

### Landing Verification

Find this in **Settings → Integrations → Counterpoint bridge → Status → Landing Verification**. It is a read-only summary of rows that have landed in existing ROS tables after Counterpoint import passes.

Use it after each pre-go-live import pass to confirm that the expected domains are present in ROS before moving to spot checks or cutover sign-off. The counts prove that ROS tables now contain Counterpoint-linked rows for the listed domains, including customers, staff/map rows, vendors, categories, products, variants, vendor supplier items, gift cards, store credit openings, loyalty current balances, closed tickets, and open docs.

The counts do **not** prove full business reconciliation. They do not compare financial totals to Counterpoint, prove tender/tax correctness, prove every historical row was imported, or replace staff review of edge cases. Treat them as landed-row proof only.

Customers, catalog products, catalog variants/SKUs, inventory quantity rows, open docs, open-doc lines, vendor masters, category masters, gift-card balances, and loyalty current points have added proof rows. The bridge sends the Counterpoint source count (and source sum where balances/points apply); ROS compares those values to landed ROS values and shows **Pass**, **Fail**, or **No source proof**. Catalog and inventory fidelity proof also uses deterministic live-query checksums for price/cost, category/vendor, variant labels, and inventory quantity/cost field groups.

Operational cutover visibility rows also call out unresolved ticket customer links, open-doc customer links, skipped open docs from unresolved item lines, skipped open docs from missing required data, and unmatched inventory quantity rows. These rows are backed by **Open sync issues**, so staff can review the exact Counterpoint ticket/doc/SKU key before sign-off.

Import exception cards are the repair workflow for rows that did not land. Use **Copy source** to capture the raw Counterpoint payload, fix the customer/item/tender/duplicate/mapping issue named by the card, then use the card's rerun action to request the affected Bridge area. Use **Recheck after rerun** only after the rerun has completed; it closes the exception only when ROS can prove the source key landed.

Weak or approximate domains are explicitly marked in the section:
- **Gift cards** are approximate only until source count/sum proof has been received and the snapshot reconciliation row passes.
- **Closed ticket payments** are approximate because the count reflects payment transactions allocated to Counterpoint ticket transactions, not full tender reconciliation.

Use Landing Verification with the other proof surfaces:
- **Bridge counts** show what the bridge attempted and successfully posted for the latest run.
- **Landing Verification** shows what is currently present in ROS tables after direct ingest.
- **Open sync issues** must be empty or explicitly triaged before sign-off.
- **Inventory & Catalog Verification** uses live bridge/source metrics and ROS landed values for catalog, variant, SKU, barcode, quantity, unresolved-row proof, and aggregate checksum proof for cost, price, category, vendor, and variant labels. A checksum failure means the field group differs and must be investigated before cutover; it does not identify the exact row without a later diagnostic comparison.
- **Category/vendor mapping proof** compares live vendor/category master counts to ROS `vendors.vendor_code` and `counterpoint_category_map` rows, and compares catalog items that carried `vendor_no` or `category` to products with resolved `primary_vendor_id` or `category_id`.
- **Fidelity diagnostics** are posted by the bridge from the current live query payload after catalog/inventory sync. ROS compares those source rows to landed products/variants on demand and stores only the latest bounded mismatch report, not the full source payload. Settings shows the first 50 mismatched fields by group.

This is not a full financial reconciliation report.

### Fresh Baseline Reset

For repeat pre-go-live Counterpoint import rehearsals, use **Settings → Counterpoint → Status → Fresh baseline reset**. This is the preferred rehearsal reset path because it clears imported Counterpoint business data and ROS-side Counterpoint migration state while preserving bootstrap/runtime setup.

The Fresh baseline reset preserves reviewed Counterpoint mapping configuration so repeated imports keep the operator-approved mappings:
- `counterpoint_category_map`
- `counterpoint_payment_method_map`
- `counterpoint_gift_reason_map`

Do not use `scripts/ros-wipe-business-data-keep-bootstrap-admin.sql` as the normal Counterpoint rehearsal reset. That script is a broad operational/business-data wipe; it may clear more operational setup and does not preserve the same Counterpoint rehearsal state.

The server reset also clears the active ROS import-run pointer, import proof rows, exceptions, ingest quarantine, stored fidelity diagnostics, retired CSV/reference cleanup artifacts, and Counterpoint workbench step state. It does not touch bridge-local cursor files. Delete or reset `.counterpoint-bridge-state.json` on the Counterpoint PC before the next run if you need a true full replay instead of continuing from saved bridge cursors.

### API endpoints (staff-gated, `settings.admin`)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/settings/counterpoint-sync/status` | Full status: bridge state, entity runs, open issues |
| `GET` | `/api/settings/counterpoint-sync/landing-verification` | Read-only ROS-landed Counterpoint domain counts |
| `POST` | `/api/settings/counterpoint-sync/request-run` | Enqueue a sync request (bridge polls for it) |
| `PATCH` | `/api/settings/counterpoint-sync/issues/{id}/resolve` | Mark an issue as resolved |
### Direct Bridge API endpoints

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
| `POST` | `/api/sync/counterpoint/tickets` | Ticket history → Transaction Records |
| `POST` | `/api/sync/counterpoint/vendor-items` | `PO_VEND_ITEM` → `vendor_supplier_item` |
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
- Preventing loyalty double-counting on historical Transaction Records
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
| `ros_card_kind` | ROS `gift_card_kind` value (`purchased`, `loyalty_reward`, `donated_giveaway`, `promo_gift_card`) |

Unmapped reason codes default to `purchased`.

---

## 9. Date-range filtering (recommended)

You do **not** have to import the full Counterpoint history. The current bridge defaults to the approved historical floor used for cutover rehearsals, while current master-data snapshots are not date-scoped.

### What to filter vs. keep full

| Entity | Filter? | Reason |
|--------|---------|--------|
| **Tickets** (`PS_TKT_HIST` + LIN + PMT) | **Yes** — `BUS_DAT >= __CP_IMPORT_SINCE__` | Largest volume |
| **Customer notes** (`AR_CUST_NOTE`) | **Typical** — `NOTE_DAT >= __CP_IMPORT_SINCE__` | Aligns with customer import window |
| **Gift card history** (`SY_GFT_CERT_HIST`) | **Do not import for cutover** | Balances come from the current `SY_GFT_CERT` / `SY_GFC` snapshot |
| **Staff** (`SY_USR`, `PS_SLS_REP`) | **Full sync** | Small table; tickets reference staff |
| **Customers** (`AR_CUST`) | **Full sync** | Customer master data is current cutover data |
| **Vendors** (`PO_VEND`) | **Full sync** by default | Fast path imports all `PO_VEND` rows |
| **Catalog** (`IM_ITEM` + cells) | **Full nonblank item sync** by default | Zero-stock items still import |
| **Inventory** (`IM_INV` / `IM_INV_CELL` MAIN) | **Full MAIN quantity-row sync** by default | Zero-on-hand rows import when Counterpoint has a row |
| **Gift cards** (`SY_GFT_CERT` / `SY_GFC`) | **Current open-balance snapshot** | Only cards with current open balances are needed |

### How to change the cutoff

Do not edit generated SQL in `.env`. If a rehearsal needs a narrower or wider date range, treat that as a controlled bridge setting/change and rerun Auto Config before the accepted import.

> **Tip:** If you later decide you need older data, just widen the date filter and re-run. Tickets are idempotent on `counterpoint_ticket_ref` — already-imported tickets are skipped, and only the newly-qualifying ones are added.

---

## 10. Runtime schema mapping

Normal operation does not require entity SQL in `.env`. The bridge uses the three connection settings, probes the NCR Counterpoint POS v8.4 company database through `INFORMATION_SCHEMA`, and builds runtime SQL mappings. Manual `CP_*_QUERY` entries are an expert fallback only when `CP_SQL_ENV_OVERRIDES=1` is explicitly set.

**Tips:**
- Use `SELECT TOP 5 * FROM dbo.<table>` in SSMS to confirm available columns
- Always `RTRIM(LTRIM(...))` string columns — Counterpoint uses fixed-width `CHAR` fields
- Use column aliases that match the expected payload keys only when running the expert SQL override path.
- Keep the normal bridge `.env` connection-only; stale query text in `.env` is ignored unless `CP_SQL_ENV_OVERRIDES=1`.
- Use the GUI Auto Config action or `node index.mjs auto-config` to confirm runtime mappings before the accepted import.

---

## 11. Operational checklist

### First-time setup

1. Apply migrations 84–86 (`./scripts/apply-migrations-docker.sh`)
2. Restart the ROS Rust server
3. Install or open the Bridge GUI on the Counterpoint Windows host.
4. Enter the Counterpoint SQL connection string and Main Hub ROS URL.
5. Run GUI Auto Config or `node index.mjs auto-config` to confirm runtime mappings for staff, customers, catalog, inventory, gift cards, tickets, open docs, loyalty balances, and related data.
6. Run Full Import / Recheck All.
7. Monitor progress in the Bridge GUI and the ROS Import Command Center.
8. Resolve import exceptions, review customer duplicates, and confirm proof before final sign-off.

### Ongoing monitoring

- Check bridge status in Settings regularly (or check `counterpoint_bridge_heartbeat.last_seen_at`)
- Review and dismiss sync issues as they appear
- Use **Request sync run** when you need an immediate refresh
- If the bridge shows OFFLINE, check that the Windows process is running and the network path is open

### Troubleshooting

| Symptom | Check |
|---------|-------|
| Bridge shows **OFFLINE** in Settings | Is the Node.js process running on the CP host? Is the network path open (firewall on port 3000)? |
| Main Hub ROS health fails from Bridge startup | The configured Main Hub ROS URL is not reachable from the Bridge host, or the Main Hub API is not running. |
| `Connection refused` from bridge | ROS server not running, or firewall blocking port 3000 from the CP host |
| `invalid object name` on SQL | Check `Database=` in `SQL_CONNECTION_STRING` — must be the Counterpoint company DB, not `master` |
| Customers sync but email is missing | Email was on another customer in ROS (unique constraint); check `email_conflicts` in the response |
| Products created without category | Add a row to `counterpoint_category_map` for the CP category string, or create a matching category name in ROS |
| Catalog fails with `Catalog SQL made no progress` after many rows were already read | The Bridge is still connected, but SQL Server paused the catalog stream long enough to trip the stream watchdog. Current Bridge builds aggregate parent price, inventory-cost, and barcode joins to keep the parent catalog query at one row per Counterpoint item. If it still happens after update, rerun Auto Config and review Counterpoint SQL performance before raising `CATALOG_SQL_STREAM_STALL_TIMEOUT_MS`. Failed-run partial proof is ignored until the affected area is rerun cleanly. |
| Closed ticket history has very low headers but very high lines/payments | Treat this as a query alignment problem, not a successful import. Rerun Auto Config, confirm `PS_TKT_HIST` uses the same date/key/doc-type scope as `PS_TKT_HIST_LIN` and `PS_TKT_HIST_PMT`, then rerun the Bridge. |
| Duplicate ticket warning | Order with that `counterpoint_ticket_ref` already exists — idempotent skip, not an error |
| Payment method shows as `cash` for everything | Add missing `PAY_COD` values to `counterpoint_payment_method_map` |
| Payment method shows as `counterpoint_unmapped` | Add the missing Counterpoint tender code in **Settings → Counterpoint → Payments**, then reset/replay the affected import scope before final sign-off |
| Gift cards all default to `purchased` | Add `REASON_COD` values to `counterpoint_gift_reason_map` |

---

## 12. Security notes

- **RBAC:** The Settings monitoring endpoints require `settings.admin` staff permission. Counterpoint ingest endpoints are Bridge-only API endpoints and should not be called manually by staff.

---

## 14. Operation Modes

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Manual (Default)** | Dashboard trigger / Sync Request | One-off targeted entity or full pass. |
| **Continuous** | Dashboard Toggle | Syncs on the configured interval. |
| **Run Once** | `import` | Executes a single pass for that bridge launch, then exits. Use repeated launches for validation if needed; do not leave it as a live ongoing bridge after cutover. |

To switch a running bridge to Continuous sync, visit `http://localhost:3002` and flip the toggle in the "Operation Mode" card.

If you use the ROS **Fresh baseline reset** workflow before go-live, remember that it clears ROS-side import data and Counterpoint state only while preserving reviewed Counterpoint mapping configuration. Delete or reset the bridge-local `.counterpoint-bridge-state.json` file as well if you want the next run to replay from the beginning instead of resuming from saved cursors. The SQL wipe script is broader and is not the preferred Counterpoint rehearsal reset.
