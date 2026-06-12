---
id: settings-counterpoint-sync-settings-panel
title: "Counterpoint Sync and Sign-Off"
order: 1087
summary: "Monitor the Counterpoint bridge, review imported proof, and understand historical tax semantics."
source: client/src/components/settings/CounterpointSyncSettingsPanel.tsx
last_scanned: 2026-05-10
tags: settings-counterpoint-sync-settings-panel, counterpoint, bridge, sync, signoff
status: approved
---

# Counterpoint Sync and Sign-Off

## Screenshots

![Reports catalog](../images/help/reports/catalog.png)

![Insights dashboard](../images/help/insights/metabase-main.png)

![Operational home](../images/help/operations-operational-home/main.png)

## What this is

Counterpoint Sync Settings runs the one-time Counterpoint import-first migration, monitors Bridge source-count proof, and shows landed proof for sign-off.

Use this panel to verify facts. ROSIE can explain displayed facts only; it does not approve cutover or sign off reconciliation.

## How to use it

1. Confirm the Bridge status and workstation reachability.
2. Use **Command center** to confirm source-count preflight passed for inventory/catalog, customers, sales and movement history, open orders, gift cards/store credit, and loyalty balances.
3. Use **Reset Baseline** for a clean rehearsal database when needed.
4. Click **Run Full Import** only after preflight passes.
5. Review landed proof, rows needing review, and review-landed rows before sign-off reconciliation.
6. Use support diagnostics only when mapping, quarantine, or review blockers need manual resolution.
7. Use imported tax semantics to explain historical rows without changing current tax or QBO math.

If a failed support-queue batch has been reviewed and successfully replayed into a newer import run, use **Discard** to remove the stale failed row from active blockers while preserving the original audit record.

Some historical tickets or open documents may land with **Historical Counterpoint Sale (Item Unresolved)** when Counterpoint provides payment/header value but no exact item variant. Review those rows in **Import exceptions** after import; ROS preserves the original Counterpoint item key on the line so staff can correct the product when the exact size or source line is known.

Imported Counterpoint open documents are current obligations. Their lines are marked ready for pickup so staff can finish the customer handoff; they do not need the normal new-ROS order lifecycle before go-live review.

## Bridge status

The bridge status separates three facts: Bridge heartbeat, browser control API reachability, and import preflight receipt. Browser controls only affect Start/Stop buttons from this workstation. They do not prove that the Bridge sent source-count preflight, and they do not replace current import-run proof.

The Bridge sync token saved in this panel must match `COUNTERPOINT_SYNC_TOKEN` in `C:\counterpoint-bridge\.env` on the Counterpoint host. If saving credentials shows a `RIVERSIDE_CREDENTIALS_KEY` warning, run `Repair-RiversideCredentialsKey.cmd` from the Windows deployment package on the Backoffice / Server PC and reopen Settings. If the bridge console shows `health 401`, run `Set-CounterpointBridgeToken.cmd` on the server PC and paste the exact bridge `.env` token. If it shows `health 503`, Riverside Server does not have a Counterpoint token configured yet.

## Command center and post-import verification

The command center appears before sign-off reconciliation. It shows expected Counterpoint rows, Bridge-sent rows, ROS rows landed, missing landed proof, rows needing review, review-landed rows, and readiness.

The default **Command center** is the primary one-time migration surface. Do not treat the import as successful while required domains still show zero landed proof, blocked source-count rows, open review rows, or review-landed rows that have not been accepted.

Command center proof is scoped to the latest import-first run when an import run exists. Accumulated verification is support-only: it can include rows from older rehearsals, support-queue diagnostics, or dirty dev data and must not be used as current-run sign-off proof.

The import is proof-gated. Bridge row counts do not by themselves prove that ROS has reviewable data. If source counts are suspiciously low, such as too few tickets or open docs, preflight blocks the run before ROS can show a completed import.

After preflight passes, the Bridge starts a ROS import run before sending batches. The latest import run tile must show a running, completed, or failed run; blank run proof means the Bridge has not begun the real import path. Each successful batch records raw Counterpoint rows and provenance for landed ROS rows, and failed batches create Import exceptions for review.

Customer rows with duplicate email addresses do not stop the full import. ROS keeps the unique email constraint, lands the Counterpoint customer without an email address, preserves the original email in the raw payload/provenance trail, and opens an Import exception so staff can merge or correct the duplicate before go-live sign-off.

Use **Reset Baseline** before a rehearsal when you need to start over from a clean migrated/seeded ROS database. Reset clears imported Counterpoint rows, import-run proof, exceptions, support-queue state, and the active ROS import-run pointer while keeping staff access, store settings, register/printer configuration, and reviewed mappings.

Catalog cleanup approval is valid only when Counterpoint catalog parent products and variants have landed in ROS. Stale approval badges from an earlier rehearsal do not count.

Counterpoint parent products are scoped to active items plus items with evidence since January 1, 2018. Matrix/cell variants remain attached under those parent products, including large variation sets.

## Counterpoint Data Workbench

Use **Data Workbench** after import when staff need a manual ChatGPT/Codex review of imported Counterpoint rows and CSV references. It is optional and is not the primary import path.

Generate a pack, download the JSON, copy the prompt, and review the file manually outside Riverside OS. Import only the returned JSON result file. Riverside OS validates the source hash, row keys, allowed actions, confidence, reason, category targets, and forbidden fields before saving suggestions for staff review.

Imported suggestions never apply automatically. Staff must accept, reject, edit, or block each suggestion. **Apply Approved** is available only for safe inventory catalog name/category cleanup. Financial totals, tax, tenders, gift card balances, store credit balances, deposits, quantities, costs, dates, original Counterpoint IDs, customer merge targets, and QBO/accounting mappings remain review-only.

For returns/exchanges, use the returns readiness scope to flag whether historical Counterpoint purchases resolve to current ROS items and original tender evidence. It preserves original Counterpoint ticket and line identity.

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
