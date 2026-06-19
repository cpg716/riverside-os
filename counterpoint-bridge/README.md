# Counterpoint → Riverside one-time import bridge

Node.js utility for **Windows** (or any OS with Node 18+) on or next to **Counterpoint SQL Server**. For Riverside's NCR Counterpoint POS v8.4 environment, it probes the live company database schema and builds runtime extraction SQL before POSTing batches to the Main Hub **Riverside OS** Counterpoint intake.

Use this bridge for a **controlled one-time migration** into ROS. It is **not** meant to remain as a permanent live POS integration after cutover.

### Performance notes (v0.7.3+)
Since v0.7.3, the bridge uses a high-concurrency parallel engine:
- **Concurrent batches:** each entity syncs using multiple parallel HTTP requests (default 5) to reduce wall-clock import time.
- **Matrix duplicate squelcher:** filters duplicate matrix parent rows during the catalog pass.
- **Self-cleaning pool:** tuned for large historical imports.


## What you set in `.env` first

| Variable | Purpose |
|----------|---------|
| `SQL_CONNECTION_STRING` | Company database (not `master`); same DB you use in SSMS |
| `COUNTERPOINT_BRIDGE_TARGET_MODE` | Go-live default: `ros_import_first` |
| `ROS_BASE_URL` | Main Hub ROS target, e.g. `http://10.64.70.154:3000` |
| `COUNTERPOINT_SYNC_WORKBENCH_URL` | Optional legacy standalone SYNC Workbench API, e.g. `http://10.64.70.154:3015` |
| `COUNTERPOINT_SYNC_WORKBENCH_TOKEN` | Optional legacy Workbench token |
| `COUNTERPOINT_SYNC_TOKEN` | Optional compatibility token only if a deployment deliberately requires it |
Normal setup keeps `.env` to connection and target values only. The bridge derives the entity SQL at runtime from `INFORMATION_SCHEMA`.

In the go-live workflow, `COUNTERPOINT_BRIDGE_TARGET_MODE=ros_import_first` keeps the Bridge focused on extraction and posts directly to Main Hub ROS. ROS owns staging, CSV reference uploads, AI review packs, preflight/proof, import exceptions, and final approval. The standalone SYNC Workbench remains a legacy compatibility tool, not the required path.

Run order is **fixed in code** each pass: **staff -> optional sales-rep stubs -> category masters -> vendors -> catalog -> vendor_items -> inventory -> customers -> notes -> tickets/sales history -> optional receiving history -> open docs -> optional store credit -> loyalty balances -> gift cards**. Current loyalty balances are imported through customers as `pts_bal`; loyalty history stays disabled for go-live. Older `CP_*_QUERY` overrides are ignored unless `CP_SQL_ENV_OVERRIDES=1` is explicitly set for expert recovery work.

## One-time migration posture

- Prefer the default single-pass mode. This means a single pass per launch, not “you may only ever run the migration once.”
- Treat the bridge runtime schema probe as the authoritative definition of import scope.
- Gift cards and loyalty are cutover snapshots. The runtime mapper uses current issued card balances where gift-card tables are present and imports current loyalty points through the customer balance column detected in `AR_CUST`.
- After customer and gift-card syncs, the bridge posts source count/sum proof to ROS. In **Settings → Counterpoint → Status → Landing Verification**, gift-card current balances and loyalty current points should show **Pass** before cutover sign-off.
- The migration floor is expected to stay at the approved cutover date unless you are deliberately running a narrower test cut.
- Review the ROS **Settings → Counterpoint → Status** panel before running. It now shows the active import floor, enabled entities, landing mode, and rerun warnings based on the bridge process that is actually running.
- Receiving/movement history is **disabled by default** and is not required for the Riverside cutover. SKU sales history comes from closed ticket headers, lines, and payments. Enable `SYNC_RECEIVING_HISTORY=1` only for a deliberate analytics/procurement-history investigation.
- After a successful migration, stop the bridge and retire it from the Counterpoint host.

## After sign-off: retire the bridge

Once the migration is accepted:

1. Stop the running bridge process on the Counterpoint PC.
2. Remove any startup shortcut, Windows Task Scheduler entry, or operator habit that launches `START_BRIDGE.cmd`.
3. Remove the unpacked bridge folder and old zip package so old bridge copies are not relaunched.
4. Keep the ROS status/proof artifacts as migration evidence, but do not continue treating this bridge as a supported live integration.

## Health

On start in `ros_import_first` mode, the bridge calls `GET /api/sync/counterpoint/health` on ROS. Legacy `sync_workbench` mode still calls `GET /health` on the standalone SYNC Workbench.

## Develop on Mac/Linux

```bash
cd counterpoint-bridge
cp .env.example .env
# edit .env
npm install
npm run discover
node index.mjs auto-config
node index.mjs sql-smoke
npm start
```

The **Bridge Command Center** UI is available at `http://localhost:3002` during development. ROS reads the same local status feed for migration preflight and post-import proof.

## Windows folder (operators)

Preferred go-live path: use the **Counterpoint Bridge GUI** installer from `deployment/counterpoint-bridge-gui/`. Packaged GUI releases include the bridge script, production dependencies, and a Node runtime, so operators do not need to install Node.js or run `npm install`.

Manual zip fallback:

1. From repo root: `./scripts/package-counterpoint-bridge.sh` → **`counterpoint-bridge-for-windows.zip`** (no `node_modules` inside; includes **`env.example`** as a Windows-friendly duplicate of **`.env.example`** plus **`PACKAGE_README.txt`**).
2. Unzip on the Counterpoint PC, install [Node.js LTS](https://nodejs.org/), double-click **`START_BRIDGE.cmd`**.
3. Follow **`INSTALL_ON_COUNTERPOINT_SERVER.txt`**.

Full integration notes: `docs/COUNTERPOINT_SYNC_GUIDE.md` in the Riverside OS repo. For the one-time execution checklist and retirement steps, also read `docs/COUNTERPOINT_ONE_TIME_IMPORT.md`. If your **`counterpoint-schema-report.txt`** matches the common pattern (missing `PS_SLS_REP` / gift / loyalty tables, `LOY_PTS_BAL`, `TOT` not `TOT_EXTD_PRC`, `UNIT_COST` on vendor items), see **`SCHEMA_PROBE_ALIGNMENT.txt`** next to this README.

## Server side

ROS needs migration **29** plus **84+** Counterpoint tables. The go-live Bridge path does not require a saved standalone SYNC Workbench URL or token.

## Security

Keep Bridge and ROS on the trusted store LAN. Tokens are optional compatibility controls only; if you enable one for a wider network, use a long random value and never commit `.env` or log the token.
