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
2. Save **`COUNTERPOINT_SYNC_TOKEN`** in **Settings → Integrations → Counterpoint** and put the same value in the bridge `.env` as `COUNTERPOINT_SYNC_TOKEN`.
3. Prefer **`RUN_ONCE=1`** on the bridge for a single pass per launch. Re-launching for validation/cutover rehearsal is fine; leaving the bridge in repeated polling mode is usually not.

## Preflight: exact facts operators should verify before running

Review **Settings → Counterpoint → Status** while the bridge is running on the same machine. The panel now exposes a read-only runtime snapshot from the live bridge process:

- **`CP_IMPORT_SINCE`** currently in effect
- whether the bridge is in **single-pass-per-launch** or **repeat-capable** mode
- whether ROS will land batches **directly** or into the **staging queue**
- the exact enabled **`SYNC_*`** entities in the fixed import order
- explicit rerun warnings when known non-idempotent entities are enabled

Treat those values as the real import scope for the migration record.

### Source file roles for inventory and catalog identity

Counterpoint Sync database/import remains the authoritative inventory source for ROS. Do not treat every CSV in the repo as having the same authority level:

- **`export2026-05-07.csv`** is a flattened Counterpoint inventory/SKU export. It is useful for inventory SKU preflight and duplicate barcode/SKU detection, but it is not safe for authoritative catalog identity preflight because it does not contain a stable Counterpoint variant/cell key.
- **`product-export (5).csv`** is a Lightspeed normalization reference only. Use it to assist naming, handles, option labels, and other normalization review. Do not trust Lightspeed quantities, costs, or accounting values for Counterpoint-owned inventory.
- **Raw Counterpoint `IM_ITEM` + `IM_INV_CELL` exports** are required for true catalog identity preflight. Include enough raw fields to preserve product family identity, variant/cell identity, option values, SKU/barcode, category, supplier, and price/cost context.

Identity rules:

- **`ITEM_NO` / `I-#####`** is the Counterpoint product family identity.
- A Counterpoint cell/item key is the variant identity when available.
- **`B-` SKU / barcode** is a validated alternate identity. It must not be treated as blindly authoritative when duplicate groups or matrix conflicts exist.
- A Lightspeed handle is a normalization alias only; it is not Counterpoint product identity.

Known real-file findings from `export2026-05-07.csv`:

- `502,760` rows checked by inventory preflight.
- `2` duplicate B-SKU groups.
- `25` blocking affected rows.
- `704` non-B/generated rows.
- `99` quarantine affected rows.

Safety rule: duplicate B-SKU groups must be quarantined before writes. Lightspeed quantities, costs, and accounting values must not be trusted for Counterpoint Sync.

### Pre-launch guarded import workflow

Use this order for the guarded authoritative import before launch:

1. Validate migration layout and ledger:
   ```bash
   RIVERSIDE_DB_NAME=riverside_os bash scripts/migration-status-docker.sh
   ```
2. Validate the active schema contract:
   ```bash
   RIVERSIDE_DB_NAME=riverside_os bash scripts/validate_schema_contract.sh
   ```
3. Run inventory/SKU preflight from the flattened Counterpoint CSV:
   ```bash
   node counterpoint-bridge/index.mjs preflight inventory --csv export2026-05-07.csv
   ```
4. Review preflight severity output before ingest:
   - **INFO**: context-only rows such as parent/catalog identities.
   - **WARNING**: rows that are not trusted as sellable variant inventory, such as generated/service/non-B rows.
   - **QUARANTINE**: unsafe rows skipped from writes but safe for the rest of the batch to continue.
   - **BLOCKING**: identity collisions, such as duplicate B-SKU groups or conflicting variant identity, that must not write.
5. Review `counterpoint_ingest_quarantine` after any guarded ingest attempt. Quarantine rows are review-only records and do not drive live inventory writes.
6. Ingest catalog first from authoritative Counterpoint catalog/cell data, then ingest inventory quantities after variants exist.

Expected behavior:

- Duplicate B-SKU groups never write to live catalog or inventory rows.
- Unsafe rows persist to `counterpoint_ingest_quarantine` for review.
- Clean rows continue through the existing ingest path.
- Counterpoint remains authoritative for inventory ownership.
- Lightspeed exports remain normalization-only references and must not be used for quantities, costs, accounting, or product identity.

Current known `export2026-05-07.csv` inventory preflight findings:

- `502,760` rows checked.
- `2` duplicate B-SKU groups.
- `25` blocking affected rows.
- `704` non-B/generated rows.
- `99` quarantine affected rows.

## Repeat import rehearsal checklist

Use this checklist for each pre-go-live rehearsal pass. Stop and resolve the issue before continuing if any required item cannot be confirmed.

### Pre-run checklist

- Confirm a current ROS database backup exists and is usable before changing import state.
- Confirm the Counterpoint bridge `.env` points at the correct Counterpoint company database and ROS server.
- Confirm `COUNTERPOINT_SYNC_TOKEN`, `CP_IMPORT_SINCE`, `RUN_ONCE`, staging mode, and enabled `SYNC_*` entities in the bridge runtime snapshot.
- Confirm the enabled entities follow the required order: staff / sales-rep stubs, vendors, customers, store credit opening, customer notes, catalog, inventory, vendor items, gift cards if used, tickets, open docs. Keep loyalty history disabled for the current-balance snapshot cutover.
- Confirm gift cards and loyalty are configured as snapshots: leave `CP_GFC_HIST_QUERY` empty, leave `CP_TICKET_GIFT_QUERY` empty, keep `SYNC_LOYALTY_HIST=0`, and ensure `CP_CUSTOMERS_QUERY` selects the current Counterpoint points balance as `pts_bal`.
- Decide whether to run **Settings → Counterpoint → Status → Fresh baseline reset** before this pass. Use it when you need a clean ROS import baseline while preserving reviewed Counterpoint mapping configuration.
- Decide whether to clear the bridge-local `.counterpoint-bridge-state.json` file before launch. Clear it only when the next run must replay from the beginning instead of continuing from saved bridge cursors.

### Run checklist

- Start the ROS server and confirm **Settings → Counterpoint → Status** is reachable.
- Start the Counterpoint bridge on the Counterpoint host.
- Start the selected entities from the bridge dashboard or allow the configured `RUN_ONCE=1` pass to begin.
- Watch bridge status, current entity, batch counts, and errors in the bridge dashboard.
- Watch ROS **Settings → Counterpoint → Status** for heartbeat state, staging queue movement, server sync history, and open sync issues.
- If staging is enabled, apply only the intended staged batches and keep the inbound queue under review.

### Post-run verification

- Review **Landing Verification** and confirm the expected domains landed in ROS.
- Review **Transaction Reconciliation (Preview)** for imported ticket count, lines, payments, total/payment difference, business-day grouping, and payment-type grouping.
- Review **Open Docs / Orders Verification** for open-doc transactions, lines, payments, customer links, zero-line docs, zero-payment docs, and staff attribution.
- Review **Inventory & Catalog Verification** for products, variants, SKU/barcode/cost/price coverage, quantity flags, category mapping, vendor links, and linked vendor count.
- Confirm the staging queue is empty after all intended batches are applied, or document every intentionally pending/discarded batch.
- Confirm open sync issues are empty, resolved, or explicitly documented with an owner and next action.

### Acceptance criteria

- No unresolved sync issues remain unless they are explicitly documented and accepted for this rehearsal pass.
- Every expected domain for the selected scope appears in Landing Verification.
- Customer, catalog product, catalog variant/SKU, and inventory quantity reconciliation rows show passing source-vs-ROS counts.
- Open-doc and open-doc line reconciliation rows show passing source-vs-ROS counts.
- Gift-card current balances and loyalty current points show passing source-vs-ROS count/sum reconciliation in Landing Verification.
- Customer-link, skipped-open-doc, and unmatched-inventory visibility rows show clear/zero unresolved rows.
- Weak or approximate domains, especially closed-ticket payments, have been reviewed and documented.
- Transaction, open-doc, and inventory/catalog warnings are documented with either a fix plan or an accepted explanation.
- Bridge counts, ROS landed counts, staging state, and verification snapshots are captured for the rehearsal record.

### Stop / rollback criteria

- Any batch POST failure, entity-level failure, or manual request failure appears in the bridge or ROS status.
- Expected landed counts drop unexpectedly from a prior accepted rehearsal with the same scope.
- Required customers, products, variants, tickets, or open docs are missing from ROS verification.
- Open docs show unexpected missing customer links, zero-line docs, or zero-payment docs.
- Inventory/catalog verification shows unexpected missing SKU, barcode, cost, price, category, or vendor-link coverage.
- The bridge cursor state does not match the intended run mode, such as a replay expected but `.counterpoint-bridge-state.json` was not cleared.

### Final go-live note

After the final accepted import, stop using the bridge. Disable or rotate `COUNTERPOINT_SYNC_TOKEN`, stop the Counterpoint bridge process, remove startup/scheduled launch paths, and treat ROS as the system of record.

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
6. **Catalog** then **inventory** then **vendor_items** — matrix keys on variants must exist before ticket/open-doc lines resolve. The shipped catalog query sends all nonblank `IM_ITEM` rows. The shipped inventory query sends MAIN `IM_INV` / `IM_INV_CELL` quantity rows, including zero-on-hand rows when Counterpoint has a row for that item or cell.
7. **Gift cards** — default off (`SYNC_GIFT_CARDS=0`) for bulk simplicity.
8. **Closed ticket history** (`SYNC_TICKETS`) — idempotent on `counterpoint_ticket_ref`.
9. **Open PS_DOC documents** (optional) — `SYNC_OPEN_DOCS=1` and `CP_OPEN_DOCS_*` queries **after** tickets. Posts to `POST /api/sync/counterpoint/open-docs`. Idempotent on `counterpoint_doc_ref`.
   Historical ticket/open-doc totals are useful for operational history, but tax remains non-authoritative unless you explicitly extend the bridge with proven Counterpoint tax columns.
10. **Loyalty** — current points come from `AR_CUST` during customer sync. Keep **`SYNC_LOYALTY_HIST=0`** for cutover; loyalty ledger history is not imported.

**Gift cards** — if Counterpoint is the source of current card balances, enable **`SYNC_GIFT_CARDS=1`** for the card master/current balance rows only. Leave **`CP_GFC_HIST_QUERY`** and **`CP_TICKET_GIFT_QUERY`** empty so historical gift-card activity is not imported and current balances are not replayed downward.

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
- Open documents are current obligations. Unlike closed ticket history, unresolved open-doc lines are skipped and surfaced as sync issues so deposits, previous payments, and remaining balance due cannot be fulfilled against ambiguous items.
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
4. **Inventory & Catalog Verification** shows live-query source-vs-ROS count proof for catalog products, variants, SKUs, barcodes, and inventory quantity rows.
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
- Customer, catalog product, catalog variant/SKU, and inventory quantity rows show source-vs-ROS count reconciliation.
- Vendor master, category master, catalog vendor-link, and catalog category-link rows show source-vs-ROS count reconciliation.
- Open-doc transaction and line rows show source-vs-ROS count reconciliation.
- Catalog price/cost, category/vendor, variant-label, and inventory quantity/cost rows show source-vs-ROS checksum reconciliation from the live Counterpoint query payloads.
- If a checksum row fails, the latest bridge-posted diagnostic report shows the bounded list of mismatched item keys/SKUs/fields for that group.
- Gift-card current balance and loyalty current point snapshot rows show **Pass**. These rows compare the Counterpoint source count/sum sent by the bridge to the landed ROS count/sum.
- Unresolved customer links, skipped open docs, and unmatched inventory rows are summarized and backed by **Open sync issues** with the exact Counterpoint reference or SKU/key where available.

What it does **not** prove:
- It is not full financial reconciliation.
- It does not compare Counterpoint financial totals, tender totals, tax, discounts, or receivables to ROS.
- It does not prove every source row was imported when provenance is missing or when the source SQL scope changed.
- It stores only the latest bounded mismatch diagnostics for catalog/inventory checksum failures, not the full source payload.
- It does not replace sync issue review or operator spot checks.

Weak or approximate domains:
- **Gift cards** are approximate only until the source count/sum proof has been received and the snapshot reconciliation row passes.
- **Closed ticket payments** are approximate because the count reflects payment transactions allocated to Counterpoint ticket transactions, not full tender reconciliation.

After each import pass:
1. Capture the bridge row counts for the entities that ran.
2. Confirm staging is applied or the **Inbound queue** is empty if staging was enabled.
3. Review **Landing Verification** and confirm every expected domain has a plausible landed count.
4. Confirm customer, catalog product, catalog variant/SKU, inventory quantity, open-doc, open-doc line, gift-card, and loyalty snapshot reconciliation rows pass.
5. Confirm vendor master, category master, catalog vendor-link, catalog category-link, customer-link, skipped-open-doc, and unmatched-inventory visibility rows are clear.
6. Review **Open sync issues** and resolve or deliberately defer each remaining issue.
7. Review live **Inventory & Catalog Verification** and confirm the field-fidelity checksum rows pass or document the blocking mismatch.
8. Record any approximate-domain caveats in the import sign-off notes.

### Limits of live inventory verification

- It uses the bridge's live Counterpoint SQL payload metrics and Counterpoint-linked ROS products and variants.
- Matching is **SKU-first**, with fallback to the Counterpoint item key or cell key carried in the live payload.
- Counterpoint parent item keys such as `I-XXXXX` are treated as product-group scope markers, not as direct row-level variant IDs for multi-row live-payload groups.
- It is read-only and does not correct data.
- It proves count reconciliation for products, variants, SKUs, barcodes, and matched quantity rows, and it exposes unresolved inventory rows.
- It field-verifies cost, price, category, vendor, variant-label, inventory quantity, and inventory cost fidelity at aggregate checksum level from the live bridge payloads. When a checksum fails, the bridge posts an on-demand diagnostic comparison and Settings shows the first bounded mismatched rows/fields. It does not store the full source payload.
- It does not validate ticket/open-doc financial history.

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
- **Partially repeatable with caveats**
  - `category_masters`
    The mapping/category outcome is stable, but manual map decisions still matter for final correctness.
  - `gift_cards`
    Card masters/current balances upsert. Historical gift-card event import is out of scope for cutover and should remain disabled.
  - `loyalty_hist`
    Optional historical replay only. Keep disabled for current-balance snapshot migration.
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
  - this is the preferred reset for repeat Counterpoint import rehearsals
  - it preserves bootstrap/runtime setup and reviewed Counterpoint mapping configuration while clearing imported business data plus Counterpoint migration state
  - preserved Counterpoint mapping tables include `counterpoint_category_map`, `counterpoint_payment_method_map`, and `counterpoint_gift_reason_map`
  - after the reset, clear the bridge-local `.counterpoint-bridge-state.json` file as well if you need the bridge to replay from the beginning instead of continuing from saved cursors
  - do not substitute `scripts/ros-wipe-business-data-keep-bootstrap-admin.sql` unless you intentionally want a broader operational wipe; that script may clear more setup and does not preserve the same Counterpoint rehearsal state
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
