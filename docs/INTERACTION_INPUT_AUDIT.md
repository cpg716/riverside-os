# ROS touch, keyboard, mouse, and trackpad audit

**Audit date:** 2026-08-02
**Scope:** Staff-facing React client, representative Back Office workspaces,
Register/POS, Wedding Manager, shared overlays, and existing Playwright coverage.

## Required outcome

Staff must be able to finish every input and action using touch only, keyboard
only, or mouse/trackpad. Touch and keyboard support are release requirements,
not optional enhancements.

## Evidence reviewed

- Static JSX/TSX inspection of clickable non-native elements, dialog focus
  management, explicit compact control sizing, input labels, and focus styling.
- Runtime checks at an iPad-sized 834 by 1194 viewport across Dashboard,
  Customers, Orders, Inventory, Staff, Payments, Settings, and POS.
- Root horizontal-overflow checks in the sampled workspaces.
- Keyboard focus inspection of the POS Staff Access gate.
- Existing responsive/modal Playwright coverage and the new input-modality
  regression contract.

## Confirmed findings and corrections

### Critical: POS Staff Access did not contain keyboard focus

The open system-priority dialog left focus on the page body, allowing keyboard
navigation to reach controls behind the blocking gate. The overlay now uses the
shared dialog accessibility hook, receives initial focus, traps Tab and
Shift+Tab, supports Escape when cancellation is allowed, restores prior focus,
and exposes a labelled modal-dialog contract.

### High: pointer-only operational controls

The source sweep found non-native click paths in staff cards, transaction and
fulfillment tables, inventory sorting, scheduling, Wedding Manager, and POS
custom/wedding inputs. Native buttons were used where practical; remaining
composite rows/cards now receive focus, an accessible name/state, visible focus,
and Enter/Space activation through the shared interaction helper. Layout-only
click handlers that collapse chrome, preserve keypad focus, or coordinate an
already keyboard-managed grid remain intentionally non-operable.

### High: compact touch targets

Representative runtime sampling found compact global actions and many dense
workspace controls below the 44px touch baseline. Global Search, ROSIE/Help, Bug
Report, and Notifications now use the shared touch-target utility. A
coarse-pointer CSS safeguard applies a 44px minimum hit area to buttons,
text-entry/form controls, and custom button/checkbox/switch roles without
enlarging their icons. Native checkboxes and radios continue to rely on their
associated label hit areas so dense tables are not distorted.

### Medium: inconsistent visible focus

ROS contained controls that removed the browser outline without always adding a
replacement. A global `:focus-visible` fallback now provides a consistent focus
ring while preserving stronger component-specific focus treatments.

### Resolved: compact field labelling

Runtime DOM checks found search/filter or compact form inputs without persistent
programmatic labels in Customers, Orders, and Staff. The audited customer and
wedding-party searches, order search and filters, staff search/status/bulk-role
controls, and staff access-event search now expose stable accessible names that
describe the dataset or filter purpose instead of relying on placeholder text.

## Regression gates

- `client/e2e/input-modality-accessibility.spec.ts` proves that the POS Staff
  Access dialog receives and contains keyboard focus.
- The same spec runs under a coarse-pointer/touch context and verifies that key
  persistent global actions render at least 44 by 44 CSS pixels.
- TypeScript and lint validation protect the shared activation helper and
  converted controls.

## Remaining certification work

This pass establishes a systemic baseline and corrects the confirmed blockers;
it does not certify every conditional screen state. Before declaring complete
ROS-wide conformance, run a workflow matrix on physical touch hardware and with
the mouse disconnected, covering every create/edit form, combobox, table action,
drawer, nested modal, payment/refund path, inventory post, Wedding workflow,
drag/reorder alternative, and error/recovery state. Add each reproduced gap to
the targeted Playwright suite rather than relying on a one-time manual check.

Trackpad behavior shares the pointer path and sampled workspaces showed no root
horizontal overflow. Nested horizontal grids and long scheduling tables still
need physical two-axis gesture verification on macOS and Windows precision
trackpads.
