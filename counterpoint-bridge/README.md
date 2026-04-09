# Counterpoint → Riverside import bridge

Node.js utility for **Windows** (or any OS with Node 18+) on or next to **Counterpoint SQL Server**. It runs SQL you configure in `.env` and POSTs batches to Riverside OS at `/api/sync/counterpoint/*`.
+
+### ⚡ Hyper-Speed API (v0.7.3+)
+Since v0.7.3, the bridge uses a high-concurrency parallel engine:
+- **Concurrent Batches:** Each entity syncs using multiple parallel HTTP requests (default 5) to saturate the API and minimize SQL wait times.
+- **Matrix Duplicate Squelcher:** Automatically filters and deduplicates v8.2 Matrix Parent rows during the catalog pass, preventing redundant data transmission.
+- **Self-Cleaning Pool:** Optimized memory management for large historical imports (100k+ tickets/customers).


## What you set in `.env` first

| Variable | Purpose |
|----------|---------|
| `SQL_CONNECTION_STRING` | Company database (not `master`); same DB you use in SSMS |
| `ROS_BASE_URL` | Riverside API, e.g. `http://10.64.70.154:3000` |
| `COUNTERPOINT_SYNC_TOKEN` | Must match `COUNTERPOINT_SYNC_TOKEN` on the ROS server |
| `RUN_ONCE` | `1` = one full pass through all enabled entities, then exit (default in `.env.example`). `0` = repeat every `POLL_INTERVAL_MS` + heartbeat |
| `SYNC_*` | `1` / `0` per entity (staff, vendors, customers, notes, catalog, inventory, gift cards, tickets) |
| `CP_*_QUERY` | SQL text; only change if your Counterpoint columns/tables differ |

Run order is **fixed in code** each pass: **staff → (optional sales-rep stubs when `CP_SALES_REPS_QUERY` is empty) → vendors → customers → (optional store credit) → notes → catalog → inventory → vendor_items → gift_cards → tickets → (optional open docs) → loyalty**. Startup **fails** on bad flag combos unless **`SYNC_RELAXED_DEPENDENCIES=1`** (expert incremental refresh only).

## Health

On start, the bridge calls `GET /api/sync/counterpoint/health` on ROS.

## Develop on Mac/Linux

```bash
cd counterpoint-bridge
cp .env.example .env
# edit .env
npm install
npm start
```

## Windows folder (operators)

1. From repo root: `./scripts/package-counterpoint-bridge.sh` → **`counterpoint-bridge-for-windows.zip`** (no `node_modules` inside; includes **`env.example`** as a Windows-friendly duplicate of **`.env.example`** plus **`PACKAGE_README.txt`**).
2. Unzip on the Counterpoint PC, install [Node.js LTS](https://nodejs.org/), double-click **`START_BRIDGE.cmd`**.
3. Follow **`INSTALL_ON_COUNTERPOINT_SERVER.txt`**.

Full integration notes: `docs/COUNTERPOINT_SYNC_GUIDE.md` in the Riverside OS repo. If your **`counterpoint-schema-report.txt`** matches the common pattern (missing `PS_SLS_REP` / gift / loyalty tables, `LOY_PTS_BAL`, `TOT` not `TOT_EXTD_PRC`, `UNIT_COST` on vendor items), see **`SCHEMA_PROBE_ALIGNMENT.txt`** next to this README.

## Server side

ROS needs migration **29** plus **84+** Counterpoint tables, and `COUNTERPOINT_SYNC_TOKEN` in the server environment.

## Security

Use a long random token; never commit `.env` or log the token. Prefer HTTPS to ROS when not on a trusted LAN.
