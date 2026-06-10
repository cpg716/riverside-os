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

Counterpoint Sync Settings monitors the Counterpoint bridge, staged imports, reconciliation proof, and migration sign-off evidence.

Use this panel to verify facts. ROSIE can explain displayed facts only; it does not approve cutover or sign off reconciliation.

## How to use it

1. Confirm the bridge status and workstation reachability.
2. Review post-import verification proof before sign-off reconciliation.
3. Clear blockers before reviewing warnings and caveats.
4. Use imported tax semantics to explain historical rows without changing current tax or QBO math.

## Bridge status

The bridge status shows whether the Counterpoint workstation bridge is reachable, online, offline, or degraded. If bridge controls are not reachable on this workstation, use **Reconnect to Bridge** or review the bridge host before continuing.

The Bridge sync token saved in this panel must match `COUNTERPOINT_SYNC_TOKEN` in `C:\counterpoint-bridge\.env` on the Counterpoint host. If saving credentials shows a `RIVERSIDE_CREDENTIALS_KEY` warning, run `Repair-RiversideCredentialsKey.cmd` from the Windows deployment package on the Backoffice / Server PC and reopen Settings. If the bridge console shows `health 401`, run `Set-CounterpointBridgeToken.cmd` on the server PC and paste the exact bridge `.env` token. If it shows `health 503`, Riverside Server does not have a Counterpoint token configured yet.

## Post-import verification

Post-import verification appears before sign-off reconciliation. It shows import proof such as bridge rows sent, ROS rows landed, missing landed proof, count matches, lower ROS counts, and bridge-only entities.

The migration steps are proof-gated. Bridge row counts do not by themselves prove that ROS has reviewable data. If Step 1 shows Bridge-reported rows but there is no staged, applied, or ROS landed proof, **Advance to Inventory Mapping** stays blocked. Apply or recover the matching staging batch until the step has staged, applied, or ROS landed proof.

## Counterpoint Transition Review Packs

Use Counterpoint Transition Review Packs when staff need a manual ChatGPT/Codex review of Counterpoint migration rows.

Generate a pack, download the JSON, copy the prompt, and review the file manually outside Riverside OS. Import only the returned JSON result file. Riverside OS validates the source hash, row keys, allowed actions, confidence, reason, category targets, and forbidden fields before staging suggestions.

Imported suggestions never apply automatically. Staff must accept, reject, edit, or block each suggestion. **Apply Approved** is available only for safe inventory catalog name/category cleanup. Financial totals, tax, tenders, gift card balances, store credit balances, deposits, quantities, costs, dates, original Counterpoint IDs, customer merge targets, and QBO/accounting mappings remain review-only.

For returns/exchanges, use the returns readiness scope to flag whether historical Counterpoint purchases resolve to current ROS items and original tender evidence. It preserves original Counterpoint ticket and line identity.

## Blockers and warnings

Review blockers before warnings. Common blockers include pending staging batches, unresolved sync issues, missing ROS landed proof, and bridge entity errors.

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
