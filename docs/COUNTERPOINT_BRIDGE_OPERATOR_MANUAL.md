# Counterpoint bridge and ingest — operator manual

**Status:** Canonical operator manual for the Counterpoint bridge. For the full Counterpoint doc map, start at [`COUNTERPOINT.md`](COUNTERPOINT.md).

Full runbook for **NCR Counterpoint (SQL Server) → Riverside OS (PostgreSQL)** using the Windows **Node bridge**, optional **staging queue**, and **Settings → Integrations → Counterpoint** hub. Data flow is **one way**: Counterpoint → ROS.

For migration planning, treat this as a **one-time import tool**. After a successful cutover, ROS becomes the system of record and the bridge should be retired.

**Also read**

- [`COUNTERPOINT_SYNC_GUIDE.md`](COUNTERPOINT_SYNC_GUIDE.md) — SQL shapes, entity details, provenance, health API
- [`COUNTERPOINT_ONE_TIME_IMPORT.md`](COUNTERPOINT_ONE_TIME_IMPORT.md) — migration cutover, `CP_IMPORT_SINCE`, store credit, open docs
- [`counterpoint-bridge/INSTALL_ON_COUNTERPOINT_SERVER.txt`](../counterpoint-bridge/INSTALL_ON_COUNTERPOINT_SERVER.txt) — Windows quick start
- [`counterpoint-bridge/.env.example`](../counterpoint-bridge/.env.example) — every `SYNC_*` flag and `CP_*_QUERY` template

---

## 1. What you are running

| Piece | Role |
|-------|------|
| **ROS API** (Rust, usually port **3000**) | Accepts batches from the bridge; writes customers, catalog, orders, etc. |
| **PostgreSQL** | Store database; must have migrations applied (including **95** for staging/GUI toggle). |
| **Windows bridge** (`counterpoint-bridge/index.mjs`) | Reads Counterpoint via `SQL_CONNECTION_STRING`; POSTs JSON batches to ROS with `COUNTERPOINT_SYNC_TOKEN`. |
| **Back Office → Settings → Integrations → Counterpoint** | Bridge status, **Inbound staging** toggle, queue **Apply/Discard**, category/payment/gift **maps**, **staff link** browse (`settings.admin`). |

Bridge version is logged in the Windows console (`[ingest]`, heartbeats) and can be sent on ingest as `x-bridge-version` (0.7.x).

---

## 2. Prerequisites checklist (do this before a full load)

1. **Postgres migrations** on the **same** database `DATABASE_URL` uses (from repo root, Compose db on host port **5433**):

   ```bash
   ./scripts/apply-migrations-docker.sh
   ./scripts/migration-status-docker.sh
   ```

   Minimum Counterpoint-related chain includes **84** (heartbeat, issues, maps), **85** (provenance), **86+** staff/vendor items as your build ships them, and **95** (`counterpoint_staging_batch`, `store_settings.counterpoint_config`).

2. **Server env** (`server/.env`):

   ```env
   COUNTERPOINT_SYNC_TOKEN=<long random secret>
   ```

   Restart the API after setting or changing it. Never log the token.

3. **Network**: from the Counterpoint PC, `ROS_BASE_URL` must reach the machine **running the HTTP API** (e.g. `http://192.168.x.x:3000`), not the Postgres port.

4. **Large batches**: default request body limit is **256 MiB** unless overridden by `RIVERSIDE_MAX_BODY_BYTES` (see `server/src/main.rs`). If imports fail with payload errors, raise the limit and restart the server.

---

## 3. Windows bridge setup

1. Install **Node.js 18+** (LTS).
2. Unzip **`counterpoint-bridge-for-windows.zip`** (or clone the repo folder `counterpoint-bridge/`.
3. Copy **`.env.example`** → **`.env`** (or use **`env.example`** if Explorer hides dotfiles).
4. Set at least:

   | Variable | Meaning |
   |----------|---------|
   | `SQL_CONNECTION_STRING` | Counterpoint **company** database (not `master`). |
   | `ROS_BASE_URL` | Base URL of ROS API (no trailing slash). |
   | `COUNTERPOINT_SYNC_TOKEN` | **Exact match** to server `COUNTERPOINT_SYNC_TOKEN`. |

5. Run **`START_BRIDGE.cmd`** or `node index.mjs`.

6. **`node index.mjs discover`** (or **`DISCOVER_SCHEMA.cmd`**) — read-only schema probe; no ROS token strictly required for discover-only; use to align `CP_*_QUERY` with your CP/Counterpoint build.

6. **`node index.mjs discover`** (or **`DISCOVER_SCHEMA.cmd`**) — read-only schema probe; no ROS token strictly required for discover-only; use to align `CP_*_QUERY` with your CP/Counterpoint build.

---

## 4. Operation Modes (v0.7.3+)

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Manual / IDLE** (Default) | Dashboard / Sync Request | Bridge sits idle. Only executes syncs when a staff member clicks "Run" in ROS or the Dashboard. |
| **Continuous** | Dashboard Toggle | Syncs all enabled entities every 15 minutes (configurable via `POLL_INTERVAL_MS`). |
| **Run Once** | `RUN_ONCE=1` / `import` | Executes a single pass for that bridge launch, then stops. This is the recommended mode for validation and final cutover runs. |

### The "Sync-on-Demand" Posture
By default, the bridge starts in **IDLE** mode. This prevents background noise and overlapping syncs during targeted data cleanup. To start a sync while in IDLE:
3.  The bridge will pick up the request within 10-30 seconds (based on heartbeat) and execute it.

### "Away from Store" Polling Behavior (NEW)
To prevent network and console spam when you are away from the store (and the bridge PC is off/unreachable), the Riverside OS Settings UI now implements a fail-fast policy:
- **3-Fail Limit**: The UI will attempt to check bridge liveness 3 times. If all 3 fail, it will **stop searching**.
- **Reconnect Button**: A dedicated "Reconnect to Bridge" button will appear in the Status tab. Simply click this when you are back at the store to resume live monitoring.

| Mode | Bridge behavior | When to use |
|------|-----------------|-------------|
| **Direct** (staging **off** in ROS) | Each batch is POSTed to live ingest routes (`/api/sync/counterpoint/customers`, `/catalog`, …) and applied immediately. | **Full Counterpoint load**, catch-up, production routine. |
| **Staging** (staging **on** in ROS) | Each batch is POSTed to `/api/sync/counterpoint/staging` and stored in `counterpoint_staging_batch`. Nothing hits live tables until a staff member clicks **Apply** on each batch in **Inbound queue**. | Spot checks, legal review, or debugging payloads before apply. |

**Recommendation:** For a **first-time or large import**, keep **Inbound staging OFF** in Settings unless you explicitly want a review queue. If staging is ON, ROS will look idle for customers/catalog until every batch is manually applied — easy to mistake for “import broken.”

The bridge reads the flag from **`GET /api/sync/counterpoint/health`** (machine token). On **0.7.1+**, if ROS rejects staging (e.g. toggle turned off after health was cached), the bridge logs a warning and **retries that batch on the direct route** once.

Startup log line:

```text
[ingest] Mode: direct — … OR staging — …
```

---

## 5. Back Office hub (Settings → Integrations → Counterpoint)

Requires **`settings.admin`**.

| Tab | Purpose |
|-----|---------|
| **Status** | Bridge online/offline, phase, host, version, last seen; **Inbound staging** on/off; one-time migration preflight scope; rerun-risk warnings; CSV inventory verification; post-import verification proof; entity run history; open issues. |
| **Inbound queue** | Pending/applied/failed batches; JSON payload preview; **Apply** / **Discard** (with confirmations). |
| **Categories / Payments / Gift reasons** | Edit Counterpoint → ROS mapping rows (no raw SQL). |
| **Staff links** | Browse `counterpoint_staff_map` resolution; primary corrections still flow from **staff** bridge entity in most setups. |

Toggle **staging** only when you understand the queue workflow.

### Migration preflight facts now visible in the Status tab

When the bridge is reachable at `http://localhost:3002`, the Status tab now shows a read-only runtime snapshot from the live bridge process:

- active **`CP_IMPORT_SINCE`**
- whether the bridge is **single-pass-per-launch** or repeat-capable
- whether import lands **directly** or through **staging**
- exact enabled **`SYNC_*`** entities
- explicit rerun warnings for known non-idempotent entities

Use that snapshot as the authoritative preflight scope for the migration run.

### Post-import proof now visible in the Status tab

After the bridge run finishes, use the same screen to review:

- last bridge run time, duration, and record count
- sign-off reconciliation rows comparing latest bridge counts to latest ROS landed counts by entity
- sign-off blockers and obvious count/proof gaps
- ROS server entity history
- unresolved sync issues
- staging pending count when staging is enabled

This is the current built-in verification surface for the one-time Counterpoint migration.

**Important limit:** ROS landed counts come from `counterpoint_sync_runs.records_processed`. They are useful as sign-off proof, but they are not a full accounting reconciliation and may include skipped/existing rows.

### CSV inventory verification now visible in the Status tab

The Status tab also includes a read-only **CSV inventory verification** card for direct source-to-target checking against the checked-in Counterpoint inventory export.

- matches by **SKU** first, then by Counterpoint item key from CSV `tags`
- compares SKU existence, product name, category, variant label, retail price, cost, quantity, and supplier fields
- surfaces missing ROS rows, extra ROS rows, variant-group splits, supplier-field anomalies, vendor mismatches, and missing vendor item links

Use this when operators need direct inventory proof from Counterpoint CSV ground truth instead of only bridge-versus-ROS run counts.

### Fresh baseline reset now visible in the Status tab

Before go-live, operators can also use the **Fresh baseline reset** card in the Status tab when they need to clear imported Counterpoint business data and ROS-side Counterpoint migration state before another controlled migration pass.

- This is **pre-go-live only**.
- It preserves bootstrap/runtime setup such as staff access, `store_settings`, and Counterpoint mapping tables.
- It is not a generic wipe and intentionally leaves shared setup and unrelated operational modules out of scope unless they directly block the reset.
- After the reset, clear the bridge-local `.counterpoint-bridge-state.json` file too if you want the bridge to replay from the beginning on the next run.

### Post-cutover retirement steps

Immediately after migration sign-off:

1. Stop the running bridge on the Counterpoint PC.
2. Remove any startup shortcut or scheduled launch path.
3. Remove old bridge folders/zips or rotate `COUNTERPOINT_SYNC_TOKEN` so stale copies cannot post again.
4. Leave ROS status/history surfaces in place for audit proof until a later cleanup/removal pass.

---

## 6. Entity order (fixed in the bridge)

The bridge runs a **fixed** pipeline order (not reorderable via `.env` flags):

`staff` → `sales_rep_stubs` (optional) → `vendors` → `customers` → `store_credit_opening` (optional) → `customer_notes` (optional) → `category_masters` (optional) → `catalog` → `inventory` → `vendor_items` (optional) → `gift_cards` (optional) → `tickets` (optional) → `open_docs` (optional) → `loyalty_hist` (optional).

**Rules of thumb**

- **Catalog before inventory** — stock updates need variants present.
- **Customers before tickets** — orders attach to customer codes.
- **Staff early** — improves salesperson / cashier attribution maps.

Conflicting `SYNC_*` combinations exit with `[sync-plan]` errors unless `SYNC_RELAXED_DEPENDENCIES=1` (expert incremental use only).

**Rerun caution:** `gift_cards` and `receiving_history` now have narrow duplicate-skip guardrails for repeat migration passes, but they still deserve extra review and should not be rerun casually after the final accepted cutover.

---

## 7. Zero-config and wide imports (bridge 0.7+)

**`maximal` is not “dump every Counterpoint column.”** It only fills **empty** `CP_*_QUERY` slots with **built-in** SQL. That SQL must still match your database (names and **`IM_INV.LOC_ID`**). Unknown / invalid column errors usually mean: wrong location code, missing table under your login, or a build that uses different names than the template.

| Env | Meaning |
|-----|---------|
| `CP_IMPORT_SINCE` | Current shipped default is **2018-01-01**. This is the accepted migration floor and should stay visible in bridge preflight unless you are intentionally running a narrower rehearsal. |
| `CP_IMPORT_SCOPE=maximal` | For **empty** env lines only, substitutes built-in wide SQL for customers, inventory, catalog, vendor_items, category_masters. Non-empty `CP_*_QUERY` still wins. **0.7.2+:** maximal **parent** catalog + inventory SQL is **schema-flex** (probes `INFORMATION_SCHEMA` so missing `LONG_DESCR`, missing `IM_PRC`, or `BARCOD` vs `BARCODE` does not hard-fail the query). |
| `CP_INVENTORY_LOC_ID` / `CP_CATALOG_INV_LOC_ID` | Stock location for `IM_INV` joins (default **`MAIN`**). If you get no rows or errors, run `SELECT DISTINCT LOC_ID FROM IM_INV` in SSMS and set these to your real code. |
| `CP_AUTO_SCHEMA=1` (default) | After SQL connect, probes `INFORMATION_SCHEMA`: IM_INV cost column, IM_ITEM vendor column, PO_VEND naming, optional PO_VEND_ITEM link. Logs one `[auto-schema]` line. Set `CP_AUTO_SCHEMA=0` to skip. |

**Do not** enable `CP_IM_ITEM_VENDOR_SOURCE=po_vend_item` unless discover/SSMS shows you need it; a normal `IM_ITEM.VEND_NO` database should leave it **unset** (see `.env.example`).

**Matrix SKUs:** maximal fills **`CP_CATALOG_QUERY`** only when that line is empty. It does **not** auto-generate **`CP_CATALOG_CELLS_QUERY`** — if grid items need cell rows, keep or add the cells query from `.env.example` / discover.

---

## 8. Updating the bridge (Counterpoint PC)

1. Stop the running bridge (Ctrl+C or close the window).
2. Replace the folder contents with a new **`counterpoint-bridge-for-windows.zip`** extract (or `git pull` the repo and use `counterpoint-bridge/`).
3. Preserve your **`.env`** (and optional `.counterpoint-bridge-state.json` cursors if you want incremental continuity).
4. Run **`npm install`** if `package.json` changed (START_BRIDGE.cmd usually handles this).
5. Run **`START_BRIDGE.cmd`** again. Confirm **`[ingest] Mode:`** and bridge version in the log.

From repo root, pack a fresh zip:

```bash
./scripts/package-counterpoint-bridge.sh
```

---

## 9. Updating Riverside OS (API + database)

1. **Deploy** new server binary or `git pull` + `cargo build --release` / your process manager restart.
2. **Apply migrations** on the production DB:

   ```bash
   ./scripts/apply-migrations-docker.sh
   ```

   (Or your hosted equivalent: run new `migrations/NN_*.sql` in order and insert ledger rows per your procedure.)

3. Restart the API so `COUNTERPOINT_SYNC_TOKEN` and code match.
4. **Smoke test** (replace token and host):

   ```bash
   curl -sS -H "x-ros-sync-token: YOUR_TOKEN" http://127.0.0.1:3000/api/sync/counterpoint/health
   ```

   Expect JSON with `"ok": true`, `"counterpoint_staging_enabled": true|false`.

---

## 10. Operations reference (API)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/api/sync/counterpoint/health` | M2M token | Staging flag for bridge. |
| POST | `/api/sync/counterpoint/staging` | M2M token | Only when staging enabled; body `{ "entity": "…", "payload": { … } }`. |
| POST | `/api/sync/counterpoint/<entity>` | M2M token | Direct ingest (same payload shape as before staging). |
| POST | `/api/sync/counterpoint/heartbeat` | M2M token | Bridge liveness + sync request pickup. |
| GET | `/api/settings/counterpoint-sync/status` | Staff + `settings.admin` | Hub status JSON. |
| PATCH | `/api/settings/counterpoint-sync/staging/enabled` | Staff + `settings.admin` | `{ "staging_enabled": bool }`. |

Entity keys for staging match apply logic: `customers`, `catalog`, `tickets`, `staff`, etc. (see server `counterpoint_staging.rs`).

---

## 11. Troubleshooting

| Symptom | Likely cause | Action |
|---------|----------------|--------|
| `invalid or missing sync token` | Token mismatch or missing header | Align `.env` on bridge and server; restart API. |
| `counterpoint staging is disabled` while bridge thought staging on | Toggle changed after health | 0.7.1+ retries direct; or bump health by waiting one poll cycle; turn staging off for bulk. |
| Customers/catalog empty after “successful” bridge run | **Staging on** without Apply | Turn staging off for bulk, or **Apply** all batches in Inbound queue. |
| `Connection refused` to ROS | Firewall / wrong IP / API not listening | Ping host; curl port **3000**; bind is `0.0.0.0:3000` by default. |
| `Invalid column` / `Invalid object` on SQL | CP schema differs from template | Run **discover**; fix `CP_*_QUERY` in `.env` or use **maximal** + auto-schema where applicable. |
| Inventory `skipped` all rows | Catalog not imported or SKU/key mismatch | Ensure catalog sync succeeded first; check `LOC_ID` and variant keys. |
| HTTP 413 / body too large | Batch exceeds `RIVERSIDE_MAX_BODY_BYTES` | Lower `BATCH_SIZE` in bridge `.env` or raise server limit. |
| Tickets partial / skips | Category/SKU maps, date filters, `CP_IMPORT_SINCE` | See **`COUNTERPOINT_SYNC_GUIDE.md`**; fix maps in hub or SQL. |

---

## 12. Security notes

- Treat `COUNTERPOINT_SYNC_TOKEN` like a password: **HTTPS** between bridge and ROS when not on localhost.
- **Staging ingest** is M2M-token only; **Apply** is staff-authenticated — do not expose Apply paths without Back Office auth.
- Bridge logs: avoid pasting full tokens in tickets or screenshots.

---

*Last aligned with bridge **0.7.3** (manual/IDLE mode + targeted entity requests) and migration **120**.*
