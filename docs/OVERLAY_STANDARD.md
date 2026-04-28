# Riverside OS Overlay Standard

Status: v1 (documentation baseline)
Owner: Client UI
Scope: Drawers, modals, wizards, dropdowns, popovers, and system-priority overlays.

## Why This Exists

Riverside currently has mixed overlay patterns (shared drawers, portal modals, fixed in-place overlays, and local absolute panels). This standard defines one contract so future work is predictable across POS and Back Office, especially in scroll-heavy screens.

## Overlay Categories

1. DetailDrawer drawers and slide-outs
- Use for major side workflows and deep-edit surfaces.
- Expected behavior: viewport-anchored, focus-trapped dialog behavior, body scroll locked while open.

2. Portal fixed modals and wizards
- Use for confirmations, guided workflows, blocking decisions, and full-screen/lightbox interactions.
- Expected behavior: portal mount, fixed `inset-0` backdrop layer, predictable stacking.

3. Anchored dropdowns and popovers
- Use for lightweight, local choice lists or menus tied to one trigger.
- Expected behavior: anchor to trigger, keep interaction local, no global scroll lock.

4. System-priority overlays
- Use for global/system-critical surfaces (for example top-priority prompts or simulations that must always stay above application modals/drawers).

## Required Mount Rules

1. Drawers
- Must use `DetailDrawer` (or a direct wrapper around `DetailDrawer`).

2. Modals, dialogs, and wizards
- Must render through `createPortal(...)`.
- Must use a fixed viewport layer (`fixed inset-0`) and modal backdrop pattern.

3. Anchored dropdowns/popovers
- May remain local (in-flow absolute positioning) only when they are lightweight and tied to a specific trigger.
- If used inside scrollable containers, they must include viewport collision handling.

4. Mount target
- Standard portal mount target is `#drawer-root`.
- Root-target behavior must be consistent across shared and custom overlays (no mixed null-return, fallback, and non-null assertion behavior in parallel patterns).

## Required Z-Index Tiers

Use only these tiers unless a documented exception is approved.

- `z-[100]`: drawers and slide-outs
- `z-[200]`: modals, dialogs, wizards
- `z-[300]`: system-priority overlays

Rules:
- Do not introduce ad-hoc intermediate overlay tiers without documenting why.
- Keep shell/navigation below overlay tiers.

## Scroll-Lock Rules

1. Must lock body scroll
- Drawers
- Modals
- Wizards
- Fullscreen overlays

2. Must not lock body scroll
- Lightweight anchored dropdowns
- Tooltips
- Small local popovers

## Anchored Dropdown Collision Rules

When a dropdown/popover is rendered inside a scrollable or constrained workspace:

1. Measure trigger position with `getBoundingClientRect()`.
2. Compare available space above and below using `window.innerHeight`.
3. Open downward by default.
4. Flip upward when below-space is insufficient and above-space is greater.
5. Keep max-height and internal overflow so the panel remains usable in constrained viewports.

## Current Status and Remaining Drift

Completed in commit `017c2785` (overlay migration pass):
- `client/src/components/alterations/scheduler/AlterationSchedulingDrawer.tsx` moved to portal-backed viewport root mounting.
- `client/src/components/customers/ShipmentsHubSection.tsx` manual shipment modal moved to portal-backed viewport root mounting.
- `client/src/components/layout/RegisterPickModal.tsx` moved to portal-backed viewport root mounting.

Remaining consistency drift:
- Root target consistency still needs broader normalization across shared/custom overlay paths.
- Z-index tier drift beyond `100/200/300` still exists in some active overlay paths.
- Full manual overlay flow validation remains pending for Alteration Scheduling, Manual Shipment modal, and Register Pick modal in a reachable authenticated runtime path.

## Migration Plan

Phase 1: Standardize docs (this file + staff companion)
- Define one overlay contract and migration sequence.

Phase 2: Migrate fixed in-place overlays
- Status: complete for the high-risk set listed above (commit `017c2785`).

Phase 3: Normalize z-index and root handling
- Enforce tier map (`100/200/300`) and one root-target policy.

Phase 4: Add regression tests
- Add focused Playwright checks for near-bottom visibility, layering order, and scroll-lock behavior.

## PR Checklist For Overlay Changes

- Category selected correctly (drawer vs modal vs anchored dropdown).
- Mount target follows standard.
- Z-index tier follows `100/200/300` policy.
- Scroll-lock behavior matches category.
- Dropdown collision handling added where container scroll can clip visibility.
- No unrelated overlay pattern changes included.
