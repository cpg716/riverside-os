# Counterpoint Real-Data Test Run Audit

This runbook turns the Counterpoint real-data rehearsal into an evidence pack for go-live review. Run it only against a staging clone loaded with real Counterpoint Bridge data.

## Safety Defaults

- Use a staging clone, not production.
- Keep QBO in sandbox mode only.
- Do not settle live Helcim/card payments.
- Do not repair historical financial, provider, liability, or accounting rows from this audit script.
- Treat any row returned by the final GO/CAUTION helper as an operator-reviewed blocker or evidence gap.

## Evidence Probe

Run the read-only database evidence probe for the business date used in the register rehearsal:

```bash
AUDIT_DATE=2026-06-10 \
DATABASE_URL="postgres://..." \
OUTPUT_PATH="docs/reviews/evidence/counterpoint_real_data_test_run_2026-06-10.txt" \
bash scripts/audit_counterpoint_real_data_test_run.sh
```

The wrapper forces PostgreSQL read-only mode. It exits if `DATABASE_URL` is missing and never runs repair statements.

## 10 Audit Areas

1. **Bridge-to-ROS ingestion completeness**
   - Evidence: bridge rows, staging rows, applied rows, landed ROS rows, quarantine rows, unresolved sync issues.
   - Pass: every Bridge-reported entity is traceable to staging/apply proof or ROS landed proof.
   - NO-GO: the final helper reports `bridge_rows_without_ros_proof`.

2. **Counterpoint sync wizard progression gates**
   - Evidence: screenshots of Step 1, the blocker banner if present, and the disabled/enabled Next state.
   - Pass: Step 1 cannot advance when Bridge totals have no staging or landed proof; Step 8 cannot open or complete with blockers.

3. **Review pack and apply readiness**
   - Evidence: generated review packs by scope, imported suggestions by status, and accepted/applied suggestion counts.
   - Pass: inventory catalog safe suggestions can apply; financial, tax, tender, gift-card, store-credit, deposit, cost, quantity, Counterpoint ID, customer-merge, and QBO/accounting suggestions remain review-only.

4. **Post-sync operational smoke test**
   - Evidence: sample imported products, variants, barcodes/SKUs, prices/costs, customer counts, vendor counts, and operator screenshots from search/detail pages.
   - Pass: imported rows are discoverable and usable in normal inventory, customer, vendor, receiving, and navigation workflows.

5. **Audit, rollback, and reconciliation proof**
   - Evidence: batch ledger status, sync requests, recovered stale apply claims, unresolved issues, duplicate Counterpoint references, and quarantine summaries.
   - Pass: failed/partial batches are diagnosable without silent data loss; no duplicate Counterpoint ticket/open-doc references exist.

6. **POS sale flow with Counterpoint-ingested items**
   - Evidence: current ROS transactions on `AUDIT_DATE` that include Counterpoint-ingested products/variants, tender allocations, receipts, and attached customers.
   - Pass: imported items sell like native ROS rows by barcode/manual search, with correct tax, discounts, tenders, receipts, and ledger rows.

7. **Register close and drawer reconciliation**
   - Evidence: register sessions for `AUDIT_DATE`, Z-report presence, tender totals by session, cash/check/card separation, and QBO staging preview.
   - Pass: close modal, transaction ledger, register reports, and Z-report agree.

8. **Register inventory and fulfillment impact**
   - Evidence: imported variant stock/reserved/on-layaway/available values, same-day inventory movements, returns/voids where safe, and order-style movement probes.
   - Pass: register activity affects imported inventory the same way it affects ROS-native inventory.

9. **QBO staging from real register activity**
   - Evidence: QBO staging rows for `AUDIT_DATE`, balanced payload totals, warnings, and current ROS transaction totals.
   - Pass: current ROS register activity stages cleanly; historical Counterpoint imports do not contaminate current QBO proposals.

10. **QBO sync safety and reconciliation**
    - Evidence: QBO sandbox setting, pending/approved/syncing/failed/synced counts, duplicate staging probe, stale syncing probe, and retry/failure records.
    - Pass: manual sync/retry uses claim-before-post behavior, duplicate protection holds, and no row is marked externally synced without sandbox proof.

## GO / CAUTION / NO-GO

- **GO**: the final helper query returns zero rows, QBO is sandboxed, imported-item POS/register/QBO smoke evidence is present, and operator screenshots/log excerpts match the database evidence.
- **CAUTION**: only non-financial caveats remain, every caveat has an owner and operating workaround, and accounting agrees it does not block day-to-day rehearsal.
- **NO-GO**: any final helper row remains, QBO is live, Bridge totals lack ROS proof, staging/apply failures remain unresolved, imported items cannot be sold, register close does not reconcile, or QBO staging can double-post or falsely mark success.
