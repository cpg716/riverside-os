---
id: settings-counterpoint-sync-settings-panel
title: "Counterpoint Sync Settings Panel (settings)"
order: 1087
summary: "Monitor the Counterpoint bridge, review staged batches, and maintain Counterpoint-to-ROS mapping tables."
source: client/src/components/settings/CounterpointSyncSettingsPanel.tsx
last_scanned: 2026-04-22
tags: settings-counterpoint-sync-settings-panel, component, counterpoint, bridge, sync
---

# Counterpoint Sync Settings Panel (settings)

<!-- help:component-source -->
_Linked component: `client/src/components/settings/CounterpointSyncSettingsPanel.tsx`._
<!-- /help:component-source -->

## What this is

Use **Settings → Counterpoint** to monitor the Windows Counterpoint bridge, request a pull, review staged inbound batches, and maintain the mapping tables that translate Counterpoint codes into Riverside values.

This screen is for **one-way import into Riverside**. Counterpoint is the source input. Riverside becomes the working system of record after data is accepted.

For cutover work, treat this as a **one-time migration** screen, not an ongoing live integration dashboard.

## Main areas

1. **Status**
   Check whether the bridge is online, syncing, or offline.
   Review the migration preflight scope, rerun warnings, CSV inventory verification, fresh-baseline reset preview, sign-off reconciliation, last heartbeat, current entity, recent run history, and unresolved sync issues.
   If the bridge dashboard is running on the same machine, you can also trigger a full pull or a targeted entity pull from here.

2. **Inbound queue**
   Use this when **Inbound staging** is enabled.
   New bridge payloads are stored here first and do **not** touch live data until a staff member clicks **Apply**.
   Use **Discard** for batches you do not want to import.

3. **Categories / Payments / Gift reasons**
   Maintain Counterpoint-to-Riverside mapping rows.
   Gift reason mappings must use valid Riverside card kinds:
   `purchased`, `loyalty_reward`, `donated_giveaway`

4. **Staff links**
   Review how Counterpoint staff/user codes are linked to Riverside staff records for attribution.

## Direct vs staged import

- **Inbound staging off**: the bridge posts directly to live Counterpoint ingest routes.
- **Inbound staging on**: the bridge posts to the staging queue and waits for staff review.

For large first-pass imports, confirm which mode you want before starting. A successful bridge run can still appear to have “done nothing” if staging is on and nobody applies the queued batches.

## Recommended workflow

1. Confirm the bridge is online in **Status**.
2. Confirm the **preflight scope** matches the intended migration window and enabled entities.
   For the accepted Counterpoint migration baseline, the Status card should show **`CP_IMPORT_SINCE=2018-01-01`** unless you are intentionally running a narrower rehearsal.
3. Confirm whether **Inbound staging** should be on or off.
4. Run the needed entity or full import.
5. If staging is on, review the **Inbound queue** and apply batches in a controlled order.
6. Review the **post-import verification** summary and unresolved issues before any rerun.
7. Review **Sign-off reconciliation** before migration acceptance.
8. Run **CSV inventory verification** when you need a direct SKU-by-SKU comparison between the Counterpoint export and ROS imported catalog, variant, inventory, and vendor data.
9. If you need a fresh pre-go-live rerun, use **Fresh baseline reset**, type the exact confirmation phrase, then clear the bridge-local cursor file before importing again.
10. After successful cutover, stop and retire the bridge.

`RUN_ONCE=1` means one bridge pass per launch. It is appropriate for repeat validation runs and for the final accepted migration run.

## Post-cutover retirement steps

Immediately after migration sign-off:

1. Stop the running bridge on the Counterpoint host.
2. Remove any startup shortcut, scheduled task, or other automatic launch path.
3. Retire the bridge folder/package or rotate the sync token so it cannot be used again casually.
4. Treat this screen as historical proof only unless a deliberate rollback/recovery decision is made.

## Fresh baseline reset

The **Fresh baseline reset** card is a destructive, pre-go-live-only workflow.

- It preserves bootstrap/runtime setup such as the seeded admin account, store settings, RBAC tables, and Counterpoint mapping tables.
- It clears imported business data and Counterpoint migration state so ROS returns to a fresh migration-ready baseline.
- It is intentionally **not** a generic wipe. Shared setup such as categories and non-Counterpoint operational modules are excluded unless they directly block the reset.

After a successful reset:

1. Stop the bridge if it is still running.
2. Delete or reset the bridge-local `.counterpoint-bridge-state.json` file on the Counterpoint PC if you want a full replay.
3. Reconfirm preflight scope in **Status**.
4. Run the next validation or cutover import pass.

## CSV inventory verification

The **CSV inventory verification** card is read-only.

- It compares the checked-in Counterpoint inventory CSV export against Counterpoint-linked ROS products and variants.
- Matching is done by **SKU first**, then by Counterpoint item key from the CSV `tags` field.
- The summary highlights matched rows, mismatches, missing ROS rows, extra ROS rows, supplier-field anomalies, variant-group splits, and missing vendor item links.
- The normalized report now separates **true mismatches** from **comparison artifacts** and **CSV-source issues**. In particular, Counterpoint parent item keys (`I-XXXXX`) are treated as product-group scope signals, not as direct row-level variant identifiers.
- Missing barcode rows whose parent `I-XXXXX` item is absent from ROS are surfaced as **expected out-of-scope exclusions** under the active catalog/inventory import rules, not as automatic import defects.
- The detailed table shows CSV values beside ROS values for SKU presence, name, category, variant label, retail price, cost, quantity, and supplier fields.

Use it when migration sign-off needs direct proof against the external Counterpoint export instead of only bridge-versus-ROS run counts.

## Tips

- **Catalog before inventory**: inventory updates depend on variants already existing in Riverside.
- **Staff before customers and tickets**: staff sync improves salesperson and processed-by attribution.
- **Gift reason mapping matters**: invalid mappings can break gift-card ingest for the affected rows.
- **Rerun caution**: gift-card history and receiving-history imports are not safe to rerun blindly.
- **Repeat validation runs are allowed**: keep the bridge in migration mode, rerun only the entities you are validating, and stop using it after the final accepted cutover.
- **Sign-off reconciliation caveat**: ROS landed counts are the last saved per-entity `records_processed` values and can include skipped/existing rows.
- **Bridge dashboard**: the local bridge control surface is expected at `http://localhost:3002` on the bridge machine.
