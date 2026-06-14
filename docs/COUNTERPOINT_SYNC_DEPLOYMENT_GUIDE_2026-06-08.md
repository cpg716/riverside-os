# Riverside OS v0.90.0 Counterpoint Sync Deployment Guide

Verified current for Riverside OS **v0.90.0**, release build **f3c261d**, on **2026-06-08**.

This guide is the current deployment runbook for moving data from the Windows PC that runs **Counterpoint on SQL Server** into the **Riverside OS Main Hub PC**. It covers both machines, the bridge setup, the import order, validation, and cutover retirement.

## Current Verified Baseline

Use this guide with:

- Riverside OS release: **v0.90.0 — latest build f3c261d**
- GitHub release target: `f3c261d6a72b1d93f5adbe8a7ad8fc3a0d675a24`
- Counterpoint bridge version in `counterpoint-bridge/index.mjs`: **0.7.3**
- Bridge default posture: one full import pass, then exit
- Main Hub API port: **3000**
- Bridge local dashboard/API port on the Counterpoint PC: **3002**

Do not use older printed bridge instructions if they contradict this guide. The current migration path is a controlled one-time import; after accepted cutover, **Riverside OS becomes the system of record** and the Counterpoint bridge should be stopped and retired.

## Data Flow

```text
Counterpoint Windows PC
  NCR Counterpoint SQL Server company database
  Riverside Counterpoint bridge / Countersync GUI
        |
        | HTTP JSON batches with x-ros-sync-token
        v
Main Hub PC
  Riverside OS API on port 3000
  PostgreSQL
  Settings -> Integrations -> Counterpoint status, queue, maps, proof
```

The sync is **one way only**: Counterpoint -> Riverside OS. Riverside OS never writes back into Counterpoint SQL.

## What Gets Moved Into ROS

The bridge can move the following domains. The active scope is generated from the live NCR Counterpoint POS v8.4 SQL schema; normal `.env` setup stays connection-only.

| Domain | Counterpoint source | ROS result |
| --- | --- | --- |
| Staff | `SY_USR`, optional `PS_SLS_REP`, `PO_BUYER` | Staff records and `counterpoint_staff_map`; imported users have no PIN until assigned in ROS |
| Vendors | `PO_VEND` | Vendor records and vendor code mapping |
| Customers | `AR_CUST` | Customer profiles, addresses, customer code, current loyalty points, preferred salesperson |
| Store credit | `SY_STC` or local equivalent | Opening store credit balances |
| Customer notes | `AR_CUST_NOTE` | Customer timeline notes |
| Categories | `IM_ITEM` category codes, optional category table | ROS categories and Counterpoint category maps |
| Catalog | `IM_ITEM`, `IM_INV_CELL`, `IM_PRC`, `IM_BARCOD`, `IM_INV` | Products and product variants |
| Inventory | `IM_INV`, `IM_INV_CELL` | Stock on hand and cost/price context on existing variants |
| Vendor items | `PO_VEND_ITEM` | Supplier item cross references |
| Gift cards | `SY_GFC` or `SY_GFT_CERT` | Current gift card balance snapshots |
| Closed tickets | `PS_TKT_HIST`, lines, payments, optional notes/cells | Historical Transaction Records; idempotent on Counterpoint ticket reference |
| Open docs / layaways / special orders | `PS_DOC_HDR`, `PS_DOC_LIN`, `PS_DOC_PMT` | Active logistical Fulfillment Orders / layaway-style work in ROS |
| Receiving history | `PO_RECVR_HIST` or local equivalent | Historical receiving/cost context where enabled |

## Identity and Formatting Rules for ROS

These rules are important. They prevent duplicate products, bad stock, and broken customer history.

- `ITEM_NO` / `I-#####` is the Counterpoint product family identity.
- Matrix/cell identity must use the Counterpoint cell/item key when available.
- `B-#####` SKU/barcode is a validated alternate identity, not a blind authority when duplicate groups exist.
- Lightspeed exports are normalization references only. Do not use Lightspeed quantities, costs, accounting values, or product identity as Counterpoint truth.
- Customers are keyed by Counterpoint `CUST_NO` into ROS `customers.customer_code`.
- Current loyalty points come from the customer snapshot as `pts_bal`; do not import loyalty history for go-live unless a separate policy is explicitly approved.
- Gift cards should be current-balance snapshots for cutover. Do not replay historical gift card activity into current balances.
- Closed Counterpoint tickets become historical Transaction Records. They are not active Fulfillment Orders.
- Open Counterpoint docs become active logistical work. In ROS language, they must be treated as Fulfillment Orders / layaways / special-order work, not ambiguous "orders."

## Main Hub PC Setup

Complete this on the Riverside OS Main Hub PC before touching the Counterpoint bridge.

### 1. Install or Update Riverside OS

Install/update the Main Hub from the current Riverside OS v0.90.0 release package. The Main Hub is the one machine that runs:

- Riverside OS API
- PostgreSQL
- Riverside Back Office desktop app
- Deployment Manager / server operations tooling

Confirm the Main Hub API is reachable locally:

```powershell
Invoke-WebRequest http://127.0.0.1:3000/api/health
```

If using another workstation, confirm the Main Hub LAN URL works from that workstation:

```powershell
Invoke-WebRequest http://<MAIN_HUB_LAN_IP>:3000/api/health
```

### 2. Apply Database Migrations

Use the Deployment Manager when available. If operating from the repo/developer shell, apply migrations against the same database used by the running API:

```bash
RIVERSIDE_DB_NAME=riverside_os bash scripts/migration-status-docker.sh
RIVERSIDE_DB_NAME=riverside_os bash scripts/validate_schema_contract.sh
```

Do not start the final import if migrations are missing or the schema contract fails.

The Counterpoint path expects the active migration chain that includes:

- `counterpoint_bridge_heartbeat`
- `counterpoint_sync_runs`
- `counterpoint_sync_request`
- `counterpoint_sync_issue`
- `counterpoint_staging_batch`
- `counterpoint_category_map`
- `counterpoint_payment_method_map`
- `counterpoint_gift_reason_map`
- staff/vendor/customer/catalog/ticket/open-doc provenance columns

### 3. Set the Counterpoint Sync Token

Generate a long random token. Save it in:

```text
Back Office -> Settings -> Integrations -> Counterpoint
```

The same exact value must be placed in the bridge `.env` on the Counterpoint PC:

```env
COUNTERPOINT_SYNC_TOKEN=<same-long-random-token>
```

If Settings cannot save the token because of `RIVERSIDE_CREDENTIALS_KEY`, run this from the Windows deployment package on the Main Hub:

```text
Repair-RiversideCredentialsKey.cmd
```

Then restart Riverside Server and save the token again.

If the bridge later shows `health 401`, run this on the Main Hub and paste the exact token from the bridge `.env`:

```text
Set-CounterpointBridgeToken.cmd
```

### 4. Open Firewall / Network

The Counterpoint PC must reach the Main Hub API on port **3000**.

Use the Main Hub LAN IP in the bridge:

```env
ROS_BASE_URL=http://<MAIN_HUB_LAN_IP>:3000
```

Do not use `localhost` in `ROS_BASE_URL` unless the bridge and Riverside API are on the same machine.

### 5. Decide Direct vs Staging

For the first full Counterpoint load, use:

```text
Settings -> Integrations -> Counterpoint -> Inbound staging OFF
```

Direct mode applies batches immediately. Staging mode queues every batch until a staff member applies it in the Inbound queue. Staging is useful for spot checks, but it is easy to mistake for "nothing imported" during a bulk load.

Use staging only when you intentionally want manual review before live table writes.

### 6. Prepare ROS Mapping Screens

Before importing tickets and open docs, review:

```text
Settings -> Integrations -> Counterpoint
```

Confirm:

- Payment method maps cover every active Counterpoint tender code.
- Category maps are ready or category master sync is enabled.
- Gift reason maps are ready if gift cards are enabled.
- Staff links are reviewed after staff sync.

Unknown tenders import as `counterpoint_unmapped` and create unresolved sync issues. Do not accept a final cutover with unmapped tenders unless each code has a documented accounting treatment.

## Counterpoint Windows PC Setup

Complete this on the Windows PC that has access to Counterpoint SQL Server.

### 1. Confirm SQL Access

You need a SQL Server login with read access to the Counterpoint **company database**, not `master`.

The connection string must look like:

```env
SQL_CONNECTION_STRING=Server=<SQL_HOST>\<INSTANCE>;Database=<COUNTERPOINT_COMPANY_DB>;User Id=<read_user>;Password=<password>;Encrypt=true;TrustServerCertificate=true
```

If using a raw IP with encrypted SQL, set a non-IP TLS server name when needed:

```env
SQL_TLS_SERVERNAME=<sql-hostname>
```

### 2. Install the Bridge

Preferred operator path:

1. Use the packaged **Riverside Countersync / Counterpoint Bridge GUI** from the deployment package.
2. Install/run it on the Counterpoint PC.
3. Enter SQL connection, Main Hub URL, and sync token in the GUI.
4. Use Dry Run before real import.

Manual fallback:

1. Copy `counterpoint-bridge-for-windows.zip` to the Counterpoint PC.
2. Unzip to:

   ```text
   C:\Riverside\counterpoint-bridge\
   ```

3. Install Node.js 18+ LTS if using the manual bridge folder.
4. Double-click `START_BRIDGE.cmd` once so dependencies install and `.env` is created.
5. Edit `.env`.

### 3. Configure Required `.env` Values

Minimum required values:

```env
ROS_BASE_URL=http://<MAIN_HUB_LAN_IP>:3000
COUNTERPOINT_SYNC_TOKEN=<same-token-saved-in-ROS>
SQL_CONNECTION_STRING=Server=<SQL_HOST>\<INSTANCE>;Database=<COUNTERPOINT_COMPANY_DB>;User Id=<read_user>;Password=<password>;Encrypt=true;TrustServerCertificate=true
```

Normal setup keeps `.env` to these three lines. The bridge defaults to one run and builds v8.4 SQL mappings from the live Counterpoint schema.

For large databases, keep or increase:

```env
SQL_REQUEST_TIMEOUT_MS=600000
SQL_CONNECT_TIMEOUT_MS=60000
ROS_FETCH_TIMEOUT_MS=300000
```

### 4. Run Schema Discovery

After `SQL_CONNECTION_STRING` is set, run:

```cmd
DISCOVER_SCHEMA.cmd
```

or:

```cmd
node index.mjs discover
```

This is read-only. It writes `counterpoint-schema-report.txt` and tells you which table/column names differ from the template.

If discovery shows schema differences, use:

```cmd
node index.mjs auto-config
```

Then run a read-only compile smoke of every available runtime mapping:

```cmd
node index.mjs sql-smoke
```

Normal setup does not write generated SQL into `.env`.

### 5. Use Dry Run Before Real Import

Run:

```cmd
node index.mjs --dry-run
```

Dry Run queries Counterpoint and prints payload summaries without modifying ROS. Fix SQL column/table errors before any live run.

## Recommended `.env` Scope for Full Go-Live Import

Normal bridge setup keeps `.env` to connection settings only:

```env
ROS_BASE_URL=http://<MAIN_HUB_LAN_IP>:3000
COUNTERPOINT_SYNC_TOKEN=<matching ROS token>
SQL_CONNECTION_STRING=<Counterpoint company database connection>
```

The bridge is built for Riverside's NCR Counterpoint POS v8.4 environment and generates the extraction SQL at runtime from `INFORMATION_SCHEMA`. The default runtime posture imports the full supported go-live set when the corresponding Counterpoint tables are visible: staff/sales reps, vendors/vendor items, customers/notes/current loyalty balance, category/catalog/matrix/inventory, gift cards/store credit, closed ticket history/payments/notes, and open documents. Receiving/movement history is optional and disabled by default; Riverside needs SKU sales history from closed tickets, not purchase receiving history, for the cutover.

Important:

- Keep the normal `.env` connection-only. Do not paste `CP_*_QUERY` SQL into `.env` unless an expert override is explicitly approved.
- Current loyalty balances come from `AR_CUST`; historical loyalty replay remains disabled for go-live.
- Historical gift-card activity remains disabled for cutover. Current card balances are the cutover source.
- Keep `SYNC_RECEIVING_HISTORY=0` unless support deliberately enables it for procurement-history research.
- If an optional module table is absent, the runtime mapper skips that entity and the cutover record should document the excluded domain.

## Fixed Import Order

The bridge always runs entities in this order:

1. Staff
2. Sales rep stubs when the live sales-rep table is absent or incomplete
3. Vendors
4. Customers
5. Store credit opening
6. Customer notes
7. Category masters
8. Catalog
9. Inventory
10. Vendor items
11. Gift cards
12. Closed tickets
13. Receiving history, only when `SYNC_RECEIVING_HISTORY=1`
14. Open docs
15. Store credit opening
16. Loyalty balances
17. Gift cards

Do not try to control import behavior by reordering `.env` lines. The bridge uses a fixed, dependency-safe import order.

## Preflight Checklist

Complete this before each rehearsal or final run.

### Main Hub

- Current database backup exists and is restorable.
- Riverside OS v0.90.0 is installed/running.
- Main Hub API is reachable at `http://<MAIN_HUB_LAN_IP>:3000`.
- Migrations and schema contract are current.
- `COUNTERPOINT_SYNC_TOKEN` is saved in Settings.
- Inbound staging is OFF for the full import. Use staging only when support intentionally needs a review/debug queue.
- Payment/category/gift maps are reviewed.
- Fresh baseline reset is performed if this is a repeat rehearsal that needs a clean ROS import baseline.

### Counterpoint PC

- SQL Server is reachable.
- SQL login points to the Counterpoint company database.
- `DISCOVER_SCHEMA.cmd` has been run.
- GUI Auto Config or `node index.mjs auto-config` confirms runtime mappings for the real Counterpoint schema.
- `ROS_BASE_URL` points to the Main Hub API, not PostgreSQL.
- `COUNTERPOINT_SYNC_TOKEN` matches ROS exactly.
- Dry Run has completed without SQL/table/column errors.

## Running the Import

### Option A: Countersync GUI

1. Start Riverside OS on the Main Hub.
2. Open the Countersync GUI on the Counterpoint PC.
3. Confirm connection settings.
4. Turn on Dry Run and run the intended scope.
5. Turn off Dry Run.
6. Start the full extraction.
7. Keep the GUI console visible.
8. Watch ROS `Settings -> Integrations -> Counterpoint -> Status`.

### Option B: Manual Bridge

From the bridge folder on the Counterpoint PC:

```cmd
START_BRIDGE.cmd
```

or:

```cmd
node index.mjs
```

The bridge runs one full pass through runtime-mapped entities and stops. Run the command again only after you have reviewed the previous result.

## Monitoring During Import

On the Counterpoint PC:

- Bridge console should normally show `[ingest] Mode: direct`. `[ingest] Mode: staging` is a deliberate support/debug posture and requires applying queued batches before proof can pass.
- Dashboard is available at `http://localhost:3002`.
- Watch current entity, batch counts, slow statement warnings, and failures.

On the Main Hub:

```text
Settings -> Integrations -> Counterpoint -> Status
```

Watch:

- Bridge online/offline state
- Bridge version and hostname
- Current entity / phase
- Direct import mode
- Enabled entities and import floor
- Sync run history
- Landing Verification
- Transaction Reconciliation Preview
- Open Docs / Fulfillment Order verification
- Inventory & Catalog Verification
- Quarantine summary
- Open sync issues

If support intentionally enabled staging, also watch:

```text
Settings -> Integrations -> Counterpoint -> Inbound queue
```

Apply only intended batches. Do not leave final cutover with unreviewed pending batches.

## Post-Run Validation

Do not accept the import until these checks are complete.

### Required Status Checks

- Landing Verification shows expected domains landed.
- Staging queue is empty, or every pending/discarded batch is documented.
- Open sync issues are empty, resolved, or explicitly accepted with owner and next action.
- No unexpected entity failures appear in bridge logs.
- No request failures appear in ROS Counterpoint status.

### Required Data Checks

- Staff imported and key current staff are linked/reviewed.
- Customers are searchable by name, phone, email, and Counterpoint customer code.
- Preferred salesperson mapping is correct where Counterpoint had `SLS_REP`.
- Catalog products and variants exist for expected Counterpoint items.
- Matrix items have sensible variant labels and unique variant identities.
- Inventory quantities match source expectations for sampled SKUs.
- Vendor records and vendor item cross references are present where enabled.
- Gift card current balances match Counterpoint source counts/sums.
- Store credit opening balances match source counts/sums where enabled.
- Loyalty current points match `AR_CUST` source count/sum.
- Historical ticket counts, line counts, payment totals, and tender grouping are reviewed.
- Imported historical tickets are Transaction Records, not active Fulfillment Orders.
- Open docs are present as active Fulfillment Order / layaway / special-order work.
- Open docs have customer links, lines, payment/deposit rows, and staff attribution where source data supports it.
- No accepted final run has unresolved `payment_transactions.payment_method = 'counterpoint_unmapped'` rows unless each is documented.

### Operator Spot Checks in ROS

Check at least:

- One high-value customer with long history.
- One wedding customer / party customer if applicable.
- One customer with loyalty points.
- One customer with store credit.
- One active gift card.
- One regular in-stock SKU.
- One matrix/grid SKU.
- One vendor-linked item.
- One historical sale ticket.
- One layaway/open document.
- One special-order/open document.

## Acceptance Criteria

The final import is acceptable only when:

- Required source domains for the selected scope all landed.
- No blocking sync issues remain.
- Payment mappings are complete or every exception is documented.
- Customer, catalog, variant/SKU, and inventory proof is passing or documented.
- Gift card and loyalty source-vs-ROS count/sum proof is passing where enabled.
- Open-doc source-vs-ROS count proof is passing where enabled.
- Bridge logs, ROS status, and verification screenshots are captured for the migration record.
- The owner accepts any documented weak or approximate domains before go-live.

## Stop / Rollback Criteria

Stop and fix before continuing if any of these happen:

- Bridge cannot authenticate to ROS (`health 401` or `health 503`).
- SQL connection fails after retry loop.
- Any required entity fails to post.
- Expected customers/products/variants/tickets/open docs are missing.
- Inventory/catalog verification shows unexpected missing SKU, barcode, cost, category, or vendor links.
- Open docs show unexpected missing customers, zero-line docs, or zero-payment docs.
- Counts drop unexpectedly compared with an accepted rehearsal using the same scope.
- Bridge cursor state does not match the intended replay mode.

For repeat rehearsals, use:

```text
Settings -> Integrations -> Counterpoint -> Status -> Fresh baseline reset
```

Then clear the bridge-local `.counterpoint-bridge-state.json` only if the next run is intended to replay from the beginning.

## Troubleshooting

### `health 503`

Riverside is reachable but has no Counterpoint sync token configured. Save the token in Settings, run credential repair if needed, and restart Riverside Server.

### `health 401`

Riverside has a token, but the bridge sent a different value. Run `Set-CounterpointBridgeToken.cmd` on the Main Hub or copy the exact token into both places, then restart the bridge.

### Connection refused to ROS

`ROS_BASE_URL` is wrong, firewall blocks port 3000, or Riverside Server is not running. Use the Main Hub LAN IP and confirm `http://<MAIN_HUB_LAN_IP>:3000/api/health` from the Counterpoint PC.

### SQL timeout / retry loop

Confirm SQL Server is reachable, the company database name is correct, and large query timeouts are high enough. Heavy catalog/ticket imports can take several minutes per entity.

### `Invalid object name`

The SQL login cannot see the table, the database is wrong, or the table uses a different schema/name. Run `DISCOVER_SCHEMA.cmd` or the GUI Auto Config action and verify the bridge reports runtime mappings for the expected Counterpoint objects.

### `Invalid column name`

The local Counterpoint schema differs from the template. Use SSMS:

```sql
SELECT TOP 1 * FROM <table>;
```

Then run the GUI Auto Config action or `node index.mjs auto-config` so the bridge rebuilds runtime mappings from the live schema. Only use `CP_SQL_ENV_OVERRIDES=1` and manual `CP_*_QUERY` entries as an expert fallback.

### Inventory updates skip rows

Catalog must run first. Inventory only updates variants that exist by SKU or `counterpoint_item_key`. Also confirm the runtime inventory location matches the real store location.

### Bridge dashboard port already in use

Port 3002 is already occupied. Stop the other bridge process or close the existing console.

## After Final Sign-Off: Retire the Bridge

After the final accepted import:

1. Stop the bridge on the Counterpoint PC.
2. Remove startup shortcuts and Task Scheduler entries that launch the bridge.
3. Archive or delete old bridge folders/zips from the Counterpoint PC.
4. Rotate `COUNTERPOINT_SYNC_TOKEN` or disable it so stale bridge copies cannot post.
5. Keep ROS Counterpoint status/proof screenshots and logs as migration evidence.
6. Treat Riverside OS as the system of record.

## Verification Record for This Guide

This document was checked against current repo state on **2026-06-08**:

- `git status --short --branch`: clean `main...origin/main`
- `git rev-parse HEAD`: `f3c261d6a72b1d93f5adbe8a7ad8fc3a0d675a24`
- GitHub release `v0.90.0`: targets `f3c261d6a72b1d93f5adbe8a7ad8fc3a0d675a24`, not draft, not prerelease
- `counterpoint-bridge/index.mjs`: bridge version `0.7.3`
- `counterpoint-bridge/.env.example`: verified current three-value connection template and runtime schema-mapping posture
- `server/src/api/counterpoint_sync.rs`: verified current machine API and Settings API route names
- `deployment/windows/Start-RiversideDeployment.ps1`: verified deployment token generation path
- `deployment/windows/Set-CounterpointBridgeToken.cmd` and `set-counterpoint-bridge-token.ps1`: verified token repair/update path
- Current source docs cross-checked: `COUNTERPOINT_SYNC_GUIDE.md`, `COUNTERPOINT_BRIDGE_OPERATOR_MANUAL.md`, `COUNTERPOINT_ONE_TIME_IMPORT.md`, `BRIDGE_SYNC_TROUBLESHOOTING.md`, bridge README, and bridge Windows install text
