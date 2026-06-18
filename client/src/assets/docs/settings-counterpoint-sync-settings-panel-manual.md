---
id: settings-counterpoint-sync-settings-panel
title: "Counterpoint Sync and Sign-Off"
order: 1087
summary: "Connect Counterpoint SYNC, select prepared runs, run ROS preflight/import, and review proof."
source: client/src/components/settings/CounterpointSyncSettingsPanel.tsx
last_scanned: 2026-05-10
tags: settings-counterpoint-sync-settings-panel, counterpoint, bridge, sync, signoff
status: approved
---

# Counterpoint Sync and Sign-Off

## Screenshots

![Counterpoint command center](../images/help/settings-counterpoint-sync-settings-panel/main.png)

![Inventory control board](../images/help/inventory-control-board/main.png)

![Orders workspace](../images/help/orders-workspace/main.png)

## What this is

Counterpoint Sync Settings is the ROS Import Command Center. The Counterpoint Bridge extracts raw data into the standalone Counterpoint SYNC Workbench app. ROS Back Office connects to SYNC, selects a prepared run, runs ROS preflight, imports approved sections, and shows final proof.

Use this panel to verify facts. ROSIE can explain displayed facts only; it does not approve cutover or sign off reconciliation.

## How to use it

1. Save the **Counterpoint SYNC Connection** URL at the top of the panel: the Main Hub SYNC Workbench URL.
2. Confirm **Counterpoint Bridge heartbeat** for extraction status and **Counterpoint SYNC app connection** for prepared-run access.
3. In **Import runs from Counterpoint SYNC**, select the prepared run created in the SYNC Workbench.
4. Use **Approved package handoff into ROS** to confirm the selected run includes the expected business areas: Customers, Inventory, Ticket History / Sales Movement, Open Orders, Gift Cards, and Loyalty Points.
5. Review each section's SYNC status, source count, prepared count, warnings, blockers, ROS preflight state, ROS import state, and package fingerprint.
6. Use **ROS Preflight** for the selected section/package before importing.
7. Use **Import Section** only after blockers are zero, ROS preflight says the selected package is ready, and the confirmation modal shows the expected run, section, records, warnings, and blockers.
8. Review ROS Import exceptions and final proof before sign-off reconciliation.
9. Use **Support Diagnostics** only when deployment or recovery blockers need manual resolution.

If a failed support-queue batch has been reviewed and successfully replayed into a newer import run, use **Discard** to remove the stale failed row from active blockers while preserving the original audit record.

Some historical tickets or open documents may land with **Historical Counterpoint Sale (Item Unresolved)** when Counterpoint provides payment/header value but no exact item variant. Review those rows in **Import exceptions** after import; ROS preserves the original Counterpoint item key on the line so staff can correct the product when the exact size or source line is known.

Imported Counterpoint open documents are current obligations. Their lines are marked ready for pickup so staff can finish the customer handoff; they do not need the normal new-ROS order lifecycle before go-live review.

## Bridge and SYNC status

The status cards separate Bridge heartbeat, SYNC Workbench connection, browser/control API reachability, ROS selected-run preflight, ROS import status, and SYNC callback status. Browser controls only affect Start/Stop buttons from this workstation. They do not prove that SYNC has a ready package, and they do not replace selected-run proof.

The normal closed-store workflow does not require Bridge or SYNC Workbench tokens. The Bridge sends raw data to the SYNC Workbench, and ROS pulls prepared packages from that Workbench URL. Tokens are optional advanced compatibility settings only.

If saving credentials shows a `RIVERSIDE_CREDENTIALS_KEY` warning, run `Repair-RiversideCredentialsKey.cmd` from the Windows deployment package on the Backoffice / Server PC and reopen Settings. If SYNC is unreachable, confirm the Workbench is running and the saved URL matches the Workbench address.

The Bridge GUI includes **Check SYNC Workbench**. Use it before extraction; the Bridge must be able to load the Workbench `/api/bridge/health` endpoint before it starts sending batches. If the check fails, start or reopen the standalone Counterpoint SYNC Workbench app and confirm the exact URL shown in the Bridge GUI reaches that app.

For no-hardware rehearsal at home, start the local Workbench with `npm run dev:sync-workbench`, run `npm run sync:simulate-counterpoint`, then select the simulated run in ROS. The simulator creates warning-only sections and a blocked inventory section without requiring the Counterpoint PC. Do not import simulated packages into production ROS unless intentionally testing in a safe environment.

After simulator testing, use `npm run sync:clear-simulation` to remove only simulator-generated SYNC runs from the local Workbench store. This does not reset ROS and does not remove real Bridge/Counterpoint runs.

The SYNC Workbench uses a local SQLite store on the Main Hub. The Workbench health panel reports store readiness, full store path, backup availability, schema version, and Bridge heartbeat without letting the long Windows store path break the page layout. If an older JSON store exists, SYNC imports it into SQLite on first startup and preserves the JSON file.

## Command center and post-import verification

The command center appears before sign-off reconciliation. The current workflow is selected SYNC run first: run status, section status, prepared counts, warnings, blockers, package fingerprint, ROS preflight state, ROS import result, and run-scoped proof.

The default **Command center** is the primary one-time migration surface. Do not treat the import as successful while required domains still show zero landed proof, blocked source-count rows, open review rows, or review-landed rows that have not been accepted.

Command center proof is scoped to the selected SYNC run, selected ROS import run, section, and package fingerprint. Accumulated verification is support-only: it can include rows from older rehearsals, support-queue diagnostics, or dirty dev data and must not be used as current-run sign-off proof.

If a package changes after ROS preflight, the section shows **Package changed after preflight** and Import Section is disabled. Run ROS Preflight again for that selected section and package fingerprint.

If ROS import succeeds but the SYNC callback cannot mark the section imported, ROS shows a warning. Treat ROS as the source of truth for database writes, then reconnect to SYNC and reconcile the section status before continuing the rehearsal.

The import is proof-gated. Bridge row counts do not by themselves prove that ROS has reviewable data. If source counts are suspiciously low, such as too few open docs or tickets without line detail, preflight blocks the run before ROS can show a completed import. Receiving/movement history is optional for this cutover because Riverside OS only needs SKU sales history, not receiving history, to support historical customer lookup and returns review.

After package preflight passes, ROS can start an import run for the selected SYNC run and section only while the package fingerprint still matches the recorded preflight. Each successful package import records raw Counterpoint rows and provenance for landed ROS rows, and failed imports create ROS Import exceptions for review. SYNC preparation exceptions remain separate from ROS import exceptions.

Only the Lightspeed inventory CSV and Counterpoint inventory CSV belong in the SYNC Workbench CSV input area. They are product/SKU/item-number/variation cleanup references for inventory preparation; inventory quantities come from Counterpoint SQL unless SQL has no usable value. CSV files are not the SYNC-to-ROS import mechanism. ROS imports JSON packages pulled from the selected SYNC run.

The visible ingest path is business-area based: Customers, Inventory, Ticket History / Sales Movement, Open Orders, Gift Cards, and Loyalty Points each move from selected SYNC JSON package to ROS preflight to explicit ROS section import to PostgreSQL through the existing backend import services.

Customer rows with duplicate email addresses do not stop the customer section import. ROS keeps the unique email constraint, lands the Counterpoint customer without an email address, preserves the original email in the raw payload/provenance trail, and opens an Import exception so staff can merge or correct the duplicate before go-live sign-off.

Use **Reset Baseline** before a rehearsal when you need to start over from a clean migrated/seeded ROS database. Reset clears imported Counterpoint rows, import-run proof, exceptions, support-queue state, and the active ROS import-run pointer while keeping staff access, store settings, register/printer configuration, and reviewed mappings.

Catalog cleanup approval is valid only when Counterpoint catalog parent products and variants have landed in ROS. Stale approval badges from an earlier rehearsal do not count.

Counterpoint parent products are scoped to active items plus items with evidence since January 1, 2018. Matrix/cell variants remain attached under those parent products, including large variation sets.

## Counterpoint SYNC Workbench Review

The Main Hub SYNC Workbench also supports AI Review Packages before ROS import. Export a package from SYNC, review it with Codex/ChatGPT, import returned suggestion JSON, then accept, reject, edit, or mark each suggestion for manual review. Accepted suggestions update prepared SYNC data only. Raw Counterpoint source payloads and provenance are preserved. Applying accepted suggestions regenerates the ROS-ready package and changes the package fingerprint when content changes, so ROS preflight must be rerun.

AI suggestions must never auto-merge customers/vendors, invent emails, invent costs or quantities, or change gift card/store credit/tax/payment/refund/balance/accounting values. High-risk sections are manual-review only.

Generate the review pack from the standalone SYNC Workbench, download the JSON, copy the prompt, and review the file manually outside Riverside OS. Import only the returned JSON result file back into SYNC. Riverside OS validates the final prepared package during ROS preflight before any database import.

Imported suggestions never apply automatically. Staff must accept, reject, edit, or block each suggestion in SYNC. Financial totals, tax, tenders, gift card balances, store credit balances, deposits, quantities, costs, dates, original Counterpoint IDs, customer merge targets, and QBO/accounting mappings remain review-only.

For returns/exchanges, use the returns readiness scope to flag whether historical Counterpoint purchases resolve to current ROS items and original tender evidence. It preserves original Counterpoint ticket and line identity.

The staging diagnostics view shows replay status, stale applying batches, landed-row proof, and recovery actions. Use **Mark stale apply failed** only when a batch has been stuck long enough for support review; it records the recovery state without replaying the batch.

## Blockers and warnings

Review blockers before warnings. Common blockers include failed source-count preflight, unresolved sync issues, missing ROS landed proof, open import exceptions, and Bridge entity errors.

Do not proceed with sign-off while blockers remain.

## Imported tax semantics

Historical Counterpoint-imported transactions preserve gross historical totals for audit and reconciliation. Imported tax fields may be zero when Counterpoint did not provide itemized tax detail.

That zero imported tax detail should not be treated as current-period tax collection. Current Riverside OS tax reporting and QBO proposals should use current ROS activity, not historical imported activity.

Use the sign-off proof and tax semantics copy to explain that imported rows are distinguishable by source metadata and are for historical migration evidence.

## ROSIE placement

Counterpoint ROSIE insight appears below deterministic proof, blockers, warnings, and reconciliation tables. It should help explain the visible evidence and limits, not approve the migration.

## What to watch for

- Do not sign off on cutover from a ROSIE summary.
- Confirm imported rows are auditable and distinguishable from current ROS transactions.
- Review limits and caveats before making migration decisions.

## Related workflows

- [QBO Workspace](manual:qbo-workspace)
- [Inventory Control Board](manual:inventory-control-board)
