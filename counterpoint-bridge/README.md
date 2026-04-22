# Counterpoint → Riverside one-time import bridge

Node.js utility for **Windows** (or any OS with Node 18+) on or next to **Counterpoint SQL Server**. It runs SQL you configure in `.env` and POSTs batches to Riverside OS at `/api/sync/counterpoint/*`.

Use this bridge for a **controlled one-time migration** into ROS. It is **not** meant to remain as a permanent live POS integration after cutover.

### Performance notes (v0.7.3+)
Since v0.7.3, the bridge uses a high-concurrency parallel engine:
- **Concurrent batches:** each entity syncs using multiple parallel HTTP requests (default 5) to reduce wall-clock import time.
- **Matrix duplicate squelcher:** filters duplicate v8.2 matrix parent rows during the catalog pass.
- **Self-cleaning pool:** tuned for large historical imports.


## What you set in `.env` first

| Variable | Purpose |
|----------|---------|
| `SQL_CONNECTION_STRING` | Company database (not `master`); same DB you use in SSMS |
| `ROS_BASE_URL` | Riverside API, e.g. `http://10.64.70.154:3000` |
| `COUNTERPOINT_SYNC_TOKEN` | Must match `COUNTERPOINT_SYNC_TOKEN` on the ROS server |
| `RUN_ONCE` | `1` = one full pass through all enabled entities for that launch, then stop. Use this for validation and final cutover runs. `0` = repeat every `POLL_INTERVAL_MS` + heartbeat and should usually be avoided for migration work. |
| `SYNC_*` | `1` / `0` per entity (staff, vendors, customers, notes, catalog, inventory, gift cards, tickets) |
| `CP_*_QUERY` | SQL text; only change if your Counterpoint columns/tables differ |

Run order is **fixed in code** each pass: **staff → (optional sales-rep stubs when `CP_SALES_REPS_QUERY` is empty) → vendors → customers → (optional store credit) → notes → catalog → inventory → vendor_items → gift_cards → tickets → (optional open docs) → loyalty**. Startup **fails** on bad flag combos unless **`SYNC_RELAXED_DEPENDENCIES=1`** (expert incremental refresh only).

## One-time migration posture

- Prefer **`RUN_ONCE=1`**. This means a single pass per launch, not “you may only ever run the migration once.”
- Treat the bridge `.env` as the authoritative definition of import scope.
- The migration floor is expected to stay at **`CP_IMPORT_SINCE=2018-01-01`** unless you are deliberately running a narrower test cut. The bridge status feed now warns when the live process is using a different date.
- Review the ROS **Settings → Counterpoint → Status** panel before running. It now shows the active import floor, enabled entities, landing mode, and rerun warnings based on the bridge process that is actually running.
- If **`gift_cards`** or **`receiving_history`** are enabled, assume those entities are **not safe to rerun blindly**.
- After a successful migration, stop the bridge and retire it from the Counterpoint host.

## After sign-off: retire the bridge

Once the migration is accepted:

1. Stop the running bridge process on the Counterpoint PC.
2. Remove any startup shortcut, Windows Task Scheduler entry, or operator habit that launches `START_BRIDGE.cmd`.
3. Remove the unpacked bridge folder and old zip package, or rotate `COUNTERPOINT_SYNC_TOKEN` so that old bridge copies cannot post again.
4. Keep the ROS status/proof artifacts as migration evidence, but do not continue treating this bridge as a supported live integration.

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

The **Bridge Command Center** UI is available at `http://localhost:3002` during development. ROS reads the same local status feed for migration preflight and post-import proof.

## Windows folder (operators)

1. From repo root: `./scripts/package-counterpoint-bridge.sh` → **`counterpoint-bridge-for-windows.zip`** (no `node_modules` inside; includes **`env.example`** as a Windows-friendly duplicate of **`.env.example`** plus **`PACKAGE_README.txt`**).
2. Unzip on the Counterpoint PC, install [Node.js LTS](https://nodejs.org/), double-click **`START_BRIDGE.cmd`**.
3. Follow **`INSTALL_ON_COUNTERPOINT_SERVER.txt`**.

Full integration notes: `docs/COUNTERPOINT_SYNC_GUIDE.md` in the Riverside OS repo. For the one-time execution checklist and retirement steps, also read `docs/COUNTERPOINT_ONE_TIME_IMPORT.md`. If your **`counterpoint-schema-report.txt`** matches the common pattern (missing `PS_SLS_REP` / gift / loyalty tables, `LOY_PTS_BAL`, `TOT` not `TOT_EXTD_PRC`, `UNIT_COST` on vendor items), see **`SCHEMA_PROBE_ALIGNMENT.txt`** next to this README.

## Server side

ROS needs migration **29** plus **84+** Counterpoint tables, and `COUNTERPOINT_SYNC_TOKEN` in the server environment.

## Security

Use a long random token; never commit `.env` or log the token. Prefer HTTPS to ROS when not on a trusted LAN.
