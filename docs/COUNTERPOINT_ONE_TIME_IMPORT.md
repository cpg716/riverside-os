# Counterpoint → Riverside OS: one-time import runbook

Directed migration from Counterpoint (SQL Server + Windows bridge) into ROS PostgreSQL. Pair with [`docs/COUNTERPOINT_SYNC_GUIDE.md`](COUNTERPOINT_SYNC_GUIDE.md) for token, bridge install, and field mapping.

This path is intended for a **single controlled import and validation cycle**. After cutover, **Riverside OS becomes the system of record** and the Counterpoint bridge should be retired.

## Bridge import order and guards

The Windows bridge runs entities in a **single fixed pipeline** (`counterpoint-bridge/index.mjs`). Startup **validates** flag combinations (for example, `SYNC_TICKETS` requires `SYNC_CUSTOMERS` and `SYNC_CATALOG`, and `SYNC_INVENTORY` requires `SYNC_CATALOG`). For incremental expert runs against an already-seeded ROS database, set **`SYNC_RELAXED_DEPENDENCIES=1`** in `.env` to skip those exits.

When **`PS_SLS_REP`** is not visible and `CP_SALES_REPS_QUERY` is empty, the bridge calls **`POST /api/sync/counterpoint/sales-rep-stubs`** with distinct `SLS_REP` values from **`AR_CUST`** and **`PS_TKT_HIST`** so `preferred_salesperson_id` and ticket **`SLS_REP`** resolve. 

### **V0.1.8 Ingest Resilience (April 2026)**
- **Historical Fallback**: When **`PS_TKT_HIST`** contains unknown SKUs (legacy/deleted), ROS now automatically assigns them to a **`HIST-CP-FALLBACK`** system item instead of rejecting the ticket. This ensures **Total Lifetime Spend** is always accurate.
- **Smart Identity Resolution**: Ticket customers are matched using a dual-lookup (exact `114420` vs. prefixed `C-114420`). This prevents fragmented history for legacy numeric accounts.
- **SKU Hierarchy**: The bridge now strictly maps **`ITEM_NO` (I-XXXX)** as the ROS Product Handle/Parent and **`BARCODE` (B-XXXX)** as the variant SKU. This matches the target state for Go-Live.

## Preconditions

1. **Apply migrations** through `91_counterpoint_open_docs.sql` (includes `orders.counterpoint_doc_ref` and a partial unique index).
2. Set **`COUNTERPOINT_SYNC_TOKEN`** on the server and the same value in the bridge `.env` as `COUNTERPOINT_SYNC_TOKEN`.
3. Prefer **`RUN_ONCE=1`** on the bridge for a single pass per launch. Re-launching for validation/cutover rehearsal is fine; leaving the bridge in repeated polling mode is usually not.

## Preflight: exact facts operators should verify before running

Review **Settings → Counterpoint → Status** while the bridge is running on the same machine. The panel now exposes a read-only runtime snapshot from the live bridge process:

- **`CP_IMPORT_SINCE`** currently in effect
- whether the bridge is in **single-pass-per-launch** or **repeat-capable** mode
- whether ROS will land batches **directly** or into the **staging queue**
- the exact enabled **`SYNC_*`** entities in the fixed import order
- explicit rerun warnings when known non-idempotent entities are enabled

Treat those values as the real import scope for the migration record.

## Batch failure and retry behavior

The bridge now treats batch POST failures as entity failures. Failed chunks are no longer logged and swallowed, and the success count reflects rows actually posted to ROS, not just rows returned by the Counterpoint SQL query.

If any chunk fails, the entity fails and the bridge does not advance the local cursor for that failed work. Retrying may re-post chunks that succeeded before the failure; this is safer than skipping failed data, but it depends on the ROS ingest endpoints remaining idempotent/upsert-safe. For manual sync requests, entity posting failure is recorded as request failure instead of successful completion.

The historical ticket gift-application lookup has also been hardened so each ticket reference initializes its gift-row bucket before rows are appended.

## Historical date cutover

- Set **`CP_IMPORT_SINCE=2018-01-01`** in the bridge `.env` (default if unset).
- In `CP_*_QUERY` strings, use the literal **`__CP_IMPORT_SINCE__`** where a date filter belongs (tickets, notes, loyalty, gift history). The bridge expands it at startup to the value of `CP_IMPORT_SINCE`.

## Entity order (required)

Hard dependencies in ROS:

1. **Staff** (`SYNC_STAFF`) — `SY_USR` (and `PS_SLS_REP` / `PO_BUYER` when queries are set). When **`CP_SALES_REPS_QUERY` is empty**, the bridge runs **`sales-rep-stubs`** next so distinct `SLS_REP` from customers/tickets maps to ROS staff.
2. **Vendors** (`SYNC_VENDORS`) — **before** catalog (`VEND_NO` → `products.primary_vendor_id`).
3. **Customers** (`SYNC_CUSTOMERS`) — `CUST_NO` → `customer_code`. The shipped bridge now imports the full **`AR_CUST`** customer base so loyalty balances, store-credit ownership, ticket history, and open-doc ownership all resolve against the same ROS customer set. If you intentionally narrow `CP_CUSTOMERS_QUERY` for rehearsal work, re-verify loyalty, store credit, and open-doc customer linking before sign-off.
4. **Store credit opening** — **on by default** in `.env.example` (`SYNC_STORE_CREDIT_OPENING=1`, **`CP_STORE_CREDIT_QUERY`** after customers). Posts to `POST /api/sync/counterpoint/store-credit-opening`. Ledger reason **`counterpoint_opening_balance`**; re-runs skip rows already imported (**idempotent**). Set **`SYNC_STORE_CREDIT_OPENING=0`** if you are not using Counterpoint merchandise credit on **`AR_CUST`**.
5. **Customer notes** (optional) — usual position after customers.
6. **Catalog** then **inventory** then **vendor_items** — matrix keys on variants must exist before ticket/open-doc lines resolve. Default **`CP_INVENTORY_QUERY`** only sends **MAIN** rows whose **`ITEM_NO`** sold on a ticket on or after **`CP_IMPORT_SINCE`** (same window as ticket history) **or** have **non-zero `QTY_ON_HND`**, so dead catalog SKUs are not pushed to ROS. Replace with the full `IM_INV` `SELECT` in `.env` if you need every row.
7. **Gift cards** — default off (`SYNC_GIFT_CARDS=0`) for bulk simplicity.
8. **Closed ticket history** (`SYNC_TICKETS`) — idempotent on `counterpoint_ticket_ref`.
9. **Open PS_DOC documents** (optional) — `SYNC_OPEN_DOCS=1` and `CP_OPEN_DOCS_*` queries **after** tickets. Posts to `POST /api/sync/counterpoint/open-docs`. Idempotent on `counterpoint_doc_ref`.
   Historical ticket/open-doc totals are useful for operational history, but tax remains non-authoritative unless you explicitly extend the bridge with proven Counterpoint tax columns.
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
- Shipped bridge templates leave these `PS_DOC_*` queries **unbounded by `CP_IMPORT_SINCE`** so active layaways / quotes / special orders are not silently truncated by the historical floor.
- Headers must expose a stable **`doc_ref`** (alias). Map `booked_at`, `total_price`, `amount_paid`, `cust_no`, optional `usr_id` / `sls_rep`, optional **`cp_status`** (void/cancel markers → `cancelled` in ROS).
- ROS now prefers the summed `PS_DOC_PMT` tender rows for `amount_paid` / `balance_due` when those rows are present. The header `amount_paid` value is a fallback only.
- Lines reuse the same shape as ticket lines (`sku`, `counterpoint_item_key`, `quantity`, `unit_price`, etc.). ROS sets **`fulfillment_type = layaway`** when `DOC_TYP = 'L'`; all other imported open-doc lines land as **`special_order`**.
- Re-imports: existing `counterpoint_doc_ref` rows are skipped.
- Tax remains a known limitation: shipped ticket/open-doc templates do not source tax columns, so imported historical line-tax fields remain zero. Use this history for operational/customer lookup, not authoritative tax reconstruction.

## Operational notes

- **Stop or pause the ROS API** during a full database wipe or extremely large imports if you need to avoid concurrent writes.
- After changing SQL on the Counterpoint side, re-run **`discover`** and adjust `.env` columns (SQL Server validates every named column).
- Bridge version is reported in heartbeat (`counterpoint-bridge/index.mjs`).

## Post-import verification: exact proof to review

After the bridge finishes, review **Settings → Counterpoint → Status** and confirm:

1. **Last bridge run** shows the expected completion time, duration, and record count.
2. **Sign-off reconciliation** shows the latest bridge-reported rows beside the latest ROS landed/apply count for each entity in scope.
3. **Landing Verification** shows the expected ROS-landed counts for every domain included in the pass.
4. **CSV inventory verification** has been run when catalog / variant / quantity / supplier fidelity needs direct proof against the Counterpoint export.
5. **Sign-off blockers** is empty, or every listed blocker has been intentionally resolved.
6. **Server sync history** shows landed entity rows and no unexpected last-error values.
7. **Open sync issues** is empty, or every remaining issue has been deliberately triaged.
8. If staging was enabled, the **Inbound queue** is empty after all intended batches are applied.

This is the current proof surface for the one-time migration. There is still no full reconciliation/reporting subsystem, so sign-off should include human review of these import artifacts plus any business-side spot checks.

### Landing Verification workflow

Find **Landing Verification** in **Settings → Counterpoint → Status**. It is a compact, read-only count of Counterpoint data that has landed in ROS tables. Use it after every repeatable pre-go-live import pass.

What it proves:
- ROS contains Counterpoint-linked rows for the imported domains.
- Direct-ingest and staging-applied batches have produced visible rows in the expected ROS tables.
- Counts are available for customers, staff/map rows, vendors, categories, products, variants, vendor supplier items, gift cards, store credit openings, loyalty history, closed ticket transactions/lines/payments, open-doc transactions/lines, and receiving history.

What it does **not** prove:
- It is not full financial reconciliation.
- It does not compare Counterpoint financial totals, tender totals, tax, discounts, or receivables to ROS.
- It does not prove every source row was imported when provenance is missing or when the source SQL scope changed.
- It does not replace CSV inventory verification, sync issue review, or operator spot checks.

Weak or approximate domains:
- **Gift cards** are approximate because current `gift_cards` rows do not carry a dedicated Counterpoint provenance marker.
- **Closed ticket payments** are approximate because the count reflects payment transactions allocated to Counterpoint ticket transactions, not full tender reconciliation.

After each import pass:
1. Capture the bridge row counts for the entities that ran.
2. Confirm staging is applied or the **Inbound queue** is empty if staging was enabled.
3. Review **Landing Verification** and confirm every expected domain has a plausible landed count.
4. Review **Open sync issues** and resolve or deliberately defer each remaining issue.
5. Run **CSV inventory verification** for catalog, variant, quantity, cost, price, and vendor-link confidence.
6. Record any approximate-domain caveats in the import sign-off notes.

### Limits of the CSV inventory verification table

- It compares the checked-in Counterpoint CSV export to Counterpoint-linked ROS products and variants.
- Matching is **SKU-first**, with fallback to the Counterpoint item key carried in the CSV `tags` field.
- Counterpoint parent item keys such as `I-XXXXX` are treated as product-group scope markers, not as direct row-level variant IDs for multi-row CSV groups.
- It is read-only and does not correct data.
- It proves inventory import fidelity for catalog, variants, prices, costs, quantities, and vendor linkage, but it does not validate ticket/open-doc financial history.

### Limits of the sign-off reconciliation table

- **Bridge rows** are the latest rows reported by the live bridge process for that entity.
- **ROS landed** is the latest `counterpoint_sync_runs.records_processed` value for that entity.
- ROS landed counts can include skipped/existing rows and apply-time processing, so they are useful as migration proof but are **not** a full accounting reconciliation.
- If staging was enabled, ROS timestamps may lag behind the original bridge send time because rows land when staff click **Apply**.

## Rerun safety

Do **not** assume every Counterpoint entity is safe to rerun. Current repeatability posture:

- **Safely repeatable today**
  - `staff`
  - `sales_rep_stubs`
  - `vendors`
  - `customers`
  - `store_credit_opening`
  - `customer_notes`
  - `catalog`
  - `inventory`
  - `vendor_items`
  - `tickets`
  - `open_docs`
  - `loyalty_hist`
- **Partially repeatable with caveats**
  - `category_masters`
    The mapping/category outcome is stable, but manual map decisions still matter for final correctness.
  - `gift_cards`
    Card masters already upsert. Event inserts now skip duplicate event shapes for repeat migration passes, but operators should still review card history carefully before the final accepted run.
  - `receiving_history`
    Raw receiving rows now skip duplicate natural-key matches on rerun, but this remains analytics/history support rather than a reconciled procurement engine.
- **Use explicit operator caution / unclear enough to avoid casual reruns**
  - any entity driven by changed SQL scope or a changed `CP_IMPORT_SINCE`
- Staging mode can make an import appear incomplete until pending batches are manually applied.

The smallest safe posture is:

1. Run with **`RUN_ONCE=1`**.
2. Verify the import.
3. Fix mapping/issues first if a rerun is needed.
4. Re-run only the minimum necessary scope, with explicit awareness of non-idempotent entities.

## Trial runs vs final accepted run

- **Trial / validation runs**
  - keep `RUN_ONCE=1`
  - rerun only the entities you are actively validating
  - review sign-off reconciliation and open issues after every pass
  - if `gift_cards` or `receiving_history` are enabled, verify the historical rows directly instead of assuming perfect replay semantics
- **Fresh-baseline reruns**
  - if ROS needs to go back to a clean pre-go-live migration baseline, use **Settings → Counterpoint → Status → Fresh baseline reset**
  - this preserves bootstrap/runtime setup and Counterpoint mapping tables, but clears imported business data plus Counterpoint migration state
  - after the reset, clear the bridge-local `.counterpoint-bridge-state.json` file as well if you need the bridge to replay from the beginning instead of continuing from saved cursors
- **Final accepted cutover run**
  - use the final approved scope and mappings
  - confirm staging is applied/empty if used
  - confirm no unresolved issues block sign-off
  - capture proof, then retire the bridge immediately after acceptance

## After successful cutover: retire the bridge

Immediately after the migration is accepted:

1. Capture the bridge summary and ROS status evidence used for sign-off.
2. Stop the bridge on the Counterpoint host.
3. Remove any startup shortcut, scheduled task, or operator habit that could launch it again.
4. Remove the bridge folder and/or rotate the `COUNTERPOINT_SYNC_TOKEN` so the old path cannot post again accidentally.
5. Treat ROS as the only active system of record going forward.

### What can be disabled now vs later

- **Disable now, immediately after sign-off**
  - the running bridge process
  - any startup shortcut or scheduled launch on the Counterpoint machine
  - old bridge copies or package zips, if operationally safe
  - the current sync token, if you want a hard stop against accidental reuse
- **Leave in place for a later removal pass**
  - ROS server endpoints and database support tables
  - Settings UI/history surfaces that preserve migration proof
  - repo code and packaging scripts, until you choose to remove them in a dedicated cleanup pass

## Phase 2 (optional, separate change set)

**PO receiving history**: map Counterpoint **`PO_HDR` / `PO_LIN` / PO receive tables** into ROS **`purchase_orders`**, **`purchase_order_lines`**, and **`receiving_events`**. This is **not** implemented in the bridge or API yet; design and ship in a follow-on PR after CRM, inventory, tickets, and open docs are validated.
