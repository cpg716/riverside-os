# Overlay Behavior Standard (Staff Guide)

This guide explains how popups, drawers, and menus should behave in Riverside OS so staff do not lose context while working.

## What Staff Should Experience

1. Drawers and slide-outs
- Open against the current screen (not far below the visible area).
- Stay visible even if the page was already scrolled.

2. Modals and wizards
- Open centered or full-screen above the current work.
- Keep background from scrolling while the modal is open.

3. Search dropdowns and quick menus
- Open next to the field/button you used.
- If there is not enough room below, they should open upward instead.

4. System-priority overlays
- Always appear above normal drawers and modals when shown.

## Layering Rules (Internal Reference)

- Drawers: `z-[100]`
- Modals/Wizards: `z-[200]`
- System-priority: `z-[300]`

## Current Known Drift

Migrated in commit `017c2785`:
- `client/src/components/alterations/scheduler/AlterationSchedulingDrawer.tsx`
- `client/src/components/customers/ShipmentsHubSection.tsx` (manual shipment modal path)
- `client/src/components/layout/RegisterPickModal.tsx`

Also tracked:
- Some overlays still differ in mount-root behavior.
- Some overlay layers still use non-standard z-index values.
- Full manual overlay flow validation remains pending for Alteration Scheduling, Manual Shipment modal, and Register Pick modal in a reachable authenticated runtime path.

## Rollout Plan

1. Phase 1: Publish and align on this standard.
2. Phase 2: Migrate the three fixed in-place overlays (completed in commit `017c2785`).
3. Phase 3: Normalize mount-root and z-index usage.
4. Phase 4: Add regression tests for visibility and layering.

## When To Report A Bug

Report an overlay bug if any of the following happen:
- A popup/drawer opens off-screen near the bottom of a long page.
- You must scroll upward just to see an opened overlay.
- A modal appears behind another panel.
- Background keeps scrolling while a blocking modal is open.
