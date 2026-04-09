# Counterpoint → Riverside OS bridge

Node.js process intended to run on the **Windows PC** (including **Windows 10**) that hosts or can reach **Counterpoint’s SQL Server**. It polls SQL and POSTs batches to Riverside OS:

- `POST /api/sync/counterpoint/customers` (primary; configure `CP_CUSTOMERS_QUERY`)
- `POST /api/sync/counterpoint/inventory` (optional; `SYNC_INVENTORY=1`)
- `GET /api/sync/counterpoint/health` (startup check)

**Customers-only:** leave `SYNC_INVENTORY=0` (default), set `SQL_CONNECTION_STRING` with the correct `Database=`. The template `CP_CUSTOMERS_QUERY` uses **`dbo.VI_AR_CUST_WITH_ADDRESS`** (customer + address). If your build uses different column names, run `SELECT TOP 5 * FROM dbo.VI_AR_CUST_WITH_ADDRESS` in SSMS and adjust aliases. Fallback: **`dbo.AR_CUST`** (see commented example in `.env.example`).

## Prerequisites

1. **ROS server**: apply migration `29_counterpoint_sync.sql` and set `COUNTERPOINT_SYNC_TOKEN` in the server environment (same value as this bridge).
2. **SQL login**: read-only user to Counterpoint views/tables you query.
3. **Network**: bridge must reach ROS (`ROS_BASE_URL`). Common patterns: same LAN, or ROS on Tailscale and `ROS_BASE_URL=http://100.x.y.z:3000`.

## Setup (developers — Mac/Linux)

```bash
cd tools/counterpoint-bridge
cp .env.example .env
# Edit .env — SQL_CONNECTION_STRING, ROS_BASE_URL, COUNTERPOINT_SYNC_TOKEN, queries
npm install
npm start
```

## Portable install (Counterpoint Windows server, same LAN)

1. On your dev machine, from repo root: **`./scripts/package-counterpoint-bridge.sh`**  
   That creates **`counterpoint-bridge-for-windows.zip`** in the repo root (no `node_modules` inside — small transfer).

2. Copy the zip to the Counterpoint / SQL PC, unzip to e.g. `C:\Riverside\counterpoint-bridge\`.

3. Install **Node.js LTS** from [nodejs.org](https://nodejs.org/) if needed.

4. Double-click **`START_BRIDGE.cmd`**. First run installs npm deps and creates `.env` from the template; edit `.env`, then run **`START_BRIDGE.cmd`** again.

5. See **`INSTALL_ON_COUNTERPOINT_SERVER.txt`** for a short checklist (`ROS_BASE_URL` = your Riverside PC’s IP, e.g. `http://192.168.1.50:3000`).

Run under **NSSM**, Windows Task Scheduler, or a service wrapper if you need it to start unattended.

## Security

- Use a **long random** `COUNTERPOINT_SYNC_TOKEN`; rotate if leaked.
- Prefer **HTTPS** to ROS when exposed beyond localhost.
- Do **not** commit `.env` or log the token.

## Query customization

Counterpoint schema varies by version and customization. Adjust `CP_CUSTOMERS_QUERY` / `CP_INVENTORY_QUERY` so column aliases match the JSON fields expected by ROS (see `server/src/logic/counterpoint_sync.rs` `CounterpointCustomerRow` / `CounterpointInventoryRow`).

Customer upsert key is **`cust_no`** → stored as `customers.customer_code`. Default source objects: **`VI_AR_CUST_WITH_ADDRESS`** or **`AR_CUST`** (Counterpoint AR module).

Inventory updates **`product_variants`** by `counterpoint_item_key` first, then by **case-insensitive SKU**. Unmatched SKUs are counted as skipped.

## Orders

`GET /api/sync/counterpoint/orders` returns **501 Not Implemented** until ticket/payment mapping is defined.
