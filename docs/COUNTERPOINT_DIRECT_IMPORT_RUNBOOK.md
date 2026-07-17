# Counterpoint Direct Import Runbook

This records the go-live import path used on June 25-26, 2026. It avoids the retired SYNC app and does not depend on the Bridge GUI for business decisions. The Node runner remains a thin SQL reader/transport; ROS/Main Hub owns landing, idempotency, proof, exceptions, and review.

Do not store live SQL passwords or sync tokens in this document.

## Source Authority

Counterpoint SQL is the source of truth for cutover customer profiles, open orders, gift cards, loyalty point balances, catalog identity, and inventory quantities. ROS must land those records into the correct operational tables with Counterpoint keys/provenance intact so daily store operations can continue from the imported state. The only ROS-created inventory identity allowed during import is a deterministic `CP-*` recovery SKU when Counterpoint provides a valid item/cell key but no usable `B-*` barcode/SKU; this is additive and must not remove or replace Counterpoint source data.

## Proven Path

1. Reset only from the ROS Counterpoint command center when the current landed proof must be discarded.
2. Keep the Counterpoint runner environment connection-only:
   - `ROS_BASE_URL`
   - `COUNTERPOINT_SYNC_TOKEN`
   - `SQL_CONNECTION_STRING`
   - `CP_AUTO_SCHEMA=1`
   - `CP_IMPORT_SCOPE=maximal`
   - empty stale `CP_*_QUERY` overrides unless an override is deliberately enabled.
3. Run the source-count preflight and confirm ROS reports `preflight_passed`.
4. Run import-first direct batches. The accepted flow is:
   - staff
   - sales rep stubs
   - category masters
   - vendors
   - catalog parent products and matrix cells
   - vendor items
   - inventory quantities
   - customers
   - customer notes
   - ticket history
   - open docs
   - store credit opening
   - loyalty balances
   - gift cards
5. If an area needs repair, rerun that area through the same import-first endpoint. Do not write directly to ROS tables.

## Critical Corrections From Go-Live

- Matrix cells must use the real Counterpoint `B-XXXXX` barcode from `IM_BARCOD` when one exists. The synthetic `I-XXXXX|dimension|...` key is only an internal fallback key and must not become the ROS SKU when a barcode exists. If Counterpoint has more than one valid `B-XXXXX` barcode for the same matrix cell, ROS keeps one as the variant barcode/SKU and stores the rest as active barcode aliases so scan/search resolves every Counterpoint barcode to the same ROS variant.
- Ticket and open-doc lines must also fall back to `IM_BARCOD` by item and dimensions when the line row itself does not provide `BARCOD`.
- The `2018-01-01` historical floor limits transaction/history activity. It must not be used to decide whether a current Counterpoint catalog product or matrix cell exists. Maximal catalog import includes active dormant products and variants even when they have no current quantity, sale, receipt, or open document activity after the floor date.
- Counterpoint ticket headers with no matching line rows must be excluded from closed-ticket import. They are not valid ROS sale records.
- Counterpoint zero-sale positive-payment ticket artifacts must not be surfaced as customer purchases. Those rows represent payment/deposit activity, not fulfilled merchandise sales.
- Open-doc payments imported from Counterpoint are deposits on the order even when they do not carry POS checkout `applied_deposit_amount` metadata.
- Every Counterpoint `I-XXXXX` parent item must be treated as the matrix family key. All visible `IM_INV_CELL` rows for that `I-XXXXX` must land as variants under the same ROS product, using their real `B-XXXXX` barcode aliases when Counterpoint provides them. Never remove or replace real Counterpoint `B-XXXXX` barcode data during import.
- If a Counterpoint item/cell has no usable `B-XXXXX` barcode, the importer must generate and reuse a deterministic `CP-*` recovery SKU from the Counterpoint item key. Catalog, inventory, ticket lines, and open-doc lines must all derive the same recovery SKU for the same key, and matrix-cell recovery SKUs must be collision-resistant across the full historical catalog.
- Catalog must create recovery variants before inventory, ticket history, or open docs are posted. If inventory/ticket proof shows unresolved `CP-*` rows, rerun catalog first.
- Rerunning ticket history must rebuild existing Counterpoint-imported ticket rows, not skip them. Existing imported lines and Counterpoint-tagged payments are safe to replace from source.

## June 26, 2026 Live Import Finding

The live direct repair run proved the transport and data mapping path, but it should not be treated as the final go-live baseline. The best final path is:

1. Ship the direct-import fixes in the Main Hub/ROS build.
2. Redeploy the current `v0.95.0` Main Hub package.
3. Reset Counterpoint import state from ROS.
4. Run one fresh full direct import from `2018-01-01`.
5. Review proof from that single clean run.

Evidence from the live repair passes:

- The corrected matrix barcode lookup reduced open proof exceptions from `10,334` to `7`.
- The final live proof run `9100f908-f3f6-4bb6-9f64-8f5c06aa5f60` completed, but ROS still reported `NO-GO` with `7` ticket rows and `7` matching inventory/source rows needing proof.
- A focused approved catalog ingest created the `7` missing recovery variants, and a focused inventory ingest then updated all `7` recovery rows. This confirmed the remaining issue was not SQL access or transport; the deployed Main Hub needed the repo-side recovery/rebuild fixes before a clean full proof run.
- A final proof run `23a706a4-399d-4499-8898-d946812f5553` completed after the focused repairs and reduced the live proof gap to `3` ticket rows plus `4` inventory proof rows. The inventory rows were accepted by the approved inventory endpoint, but the latest formal proof still showed them as open because the recovery happened outside the final full run.
- A focused approved ticket ingest could only partially repair the remaining rows on the deployed Main Hub because the live server still skipped some existing Counterpoint ticket refs. The rebuilt server includes the existing-ticket rebuild behavior needed for a clean fresh import.

Decision: do not use the partially repaired live run as the go-live baseline. Rebuild/redeploy, reset, and run a fresh full import.

## Validation Commands

From the repo root:

```bash
node --check counterpoint-bridge/index.mjs
```

From `counterpoint-bridge/`, with live env values set outside shell history:

```bash
node index.mjs sql-smoke
```

Health check:

```bash
curl -fsS "$ROS_BASE_URL/api/sync/counterpoint/health"
```

The health payload must be `ok: true`. For go-live, use the same history floor on ROS and the runner:

```bash
COUNTERPOINT_IMPORT_HISTORY_START=2018-01-01
CP_REQUIRED_IMPORT_SINCE=2018-01-01
CP_PREFLIGHT_HISTORY_START=2018-01-01
CP_IMPORT_SINCE=2018-01-01
```

The server health payload should then report `required_history_start: "2018-01-01"` before running preflight.

## Historical Backfill

For the fresh go-live rebuild/reset path, run the full import from `2018-01-01` so historical transactions and current cutover data share one clean proof run. After go-live, any later backfill should use a separate configured run so current proof is not confused with older history. Target history-only entities first:

- ticket headers, lines, and payments
- customer purchase history
- inventory movement derived from sales history

Do not backfill current inventory quantities from 2018. Current on-hand remains the cutover snapshot plus ROS movements after go-live.
