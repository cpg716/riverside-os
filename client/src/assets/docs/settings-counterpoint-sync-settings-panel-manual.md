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

## Post-import verification

Post-import verification appears before sign-off reconciliation. It shows import proof such as bridge rows sent, ROS rows landed, missing landed proof, count matches, lower ROS counts, and bridge-only entities.

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
