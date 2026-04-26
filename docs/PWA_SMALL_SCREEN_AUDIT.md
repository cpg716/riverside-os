# PWA and Small-Screen Layout Audit

Date: 2026-04-26

## Status

- In-scope items: DONE
- Remaining in-scope items: 0
- Out-of-scope by direction: Counterpoint sync and QBO mapping surfaces

## Scope

This audit scans the React/Tauri client for layout patterns that commonly break or degrade PWA, tablet, and phone use. It focuses on production workspaces and shared shell components under `client/src`.

The scan looked for:

- desktop-only tables
- wide `min-w-*` layouts
- fixed pixel/rem widths
- `overflow-hidden` on primary containers
- nested `overflow-y-auto` / `overflow-x-auto`
- `h-screen` / viewport-height constrained panels
- fixed overlays and max-height modals
- desktop-only grid tracks such as `grid-cols-[...]`

## Summary

The app is PWA-capable, but many production workspaces are still desktop-workstation layouts with responsive compression rather than true small-screen modes.

Scan totals:

| Pattern | Count |
| --- | ---: |
| Flagged files | 125 |
| Tables | 59 |
| Wide min-widths | 80 |
| Fixed widths | 133 |
| `overflow-hidden` | 170 |
| Nested vertical scroll | 101 |
| Nested horizontal scroll | 42 |
| Viewport-height constraints | 48 |
| Desktop grid tracks | 28 |
| Fixed overlays | 47 |

## Highest-Risk Areas

| Area | Flagged files | Primary risks |
| --- | ---: | --- |
| POS | 34 | fixed-height drawers, nested scroll, checkout modal density |
| Inventory | 18 | table-heavy tactical panels, fixed grids, full-screen receiving/import flows |
| Settings | 16 | Counterpoint sync tables, fixed panels, admin-console density |
| Staff | 11 | tables and schedule grids |
| Layout shell | 8 | rail/topbar constraints, viewport-height assumptions |
| Customers | 7 | CRM tables, relationship drawer tables, shipments table |
| QBO | 2 | mapping matrices and audit tables |
| Scheduler | 2 | week grid minimum width, fixed search popover |
| Loyalty / Gift Cards | 3 | table-first history surfaces and nested panel scroll |
| Reports | 1 | detail tables and preformatted report panels |

## Critical Findings

### 1. Table-First Surfaces Need Card/List Mobile Modes

Horizontal scrolling is present in many places, but it should be treated as a fallback for dense admin tables, not the primary mobile UI.

Priority files:

- `client/src/components/settings/CounterpointSyncSettingsPanel.tsx`
- `client/src/components/qbo/QboMappingMatrix.tsx`
- `client/src/components/inventory/PhysicalInventoryWorkspace.tsx`
- `client/src/components/customers/CustomerRelationshipHubDrawer.tsx`
- `client/src/components/customers/ShipmentsHubSection.tsx`
- `client/src/components/gift-cards/GiftCardsWorkspace.tsx`
- `client/src/components/reports/ReportsWorkspace.tsx`
- `client/src/components/staff/StaffWorkspace.tsx`

### 2. Nested Scroll Is Overused

Many pages rely on `overflow-hidden` wrappers with internal scroll panels. This is useful for register-like tactical density, but it makes phone/PWA behavior feel trapped and prevents natural browser scrolling.

Priority files:

- `client/src/components/loyalty/LoyaltyWorkspace.tsx`
- `client/src/components/gift-cards/GiftCardsWorkspace.tsx`
- `client/src/components/settings/CounterpointSyncSettingsPanel.tsx`
- `client/src/components/inventory/CategoryManager.tsx`
- `client/src/components/pos/NexoCheckoutDrawer.tsx`
- `client/src/components/pos/ProcurementHub.tsx`
- `client/src/components/layout/DetailDrawer.tsx`

### 3. Several Workspaces Use Fixed Width Controls

Search fields, popovers, and action bars often use widths that are fine on desktop but crowd phone screens.

Examples:

- Scheduler search popover uses `w-[400px]`.
- Scheduler week view uses `min-w-[720px]`, `md:min-w-[960px]`, and `xl:min-w-[1200px]`.
- Inventory and settings panels contain many `min-w-[...]` toolbar controls.
- POS drawers contain fixed-width action clusters and dense two-column layouts.

### 4. Modal and Drawer Patterns Need Mobile Rules

Most overlays fit within viewport height, but many still use desktop-centered modal assumptions. On phones, drawers and modals should generally become bottom sheets or full-height panels with sticky headers/footers.

Priority files:

- `client/src/components/pos/CloseRegisterModal.tsx`
- `client/src/components/pos/ReceiptSummaryModal.tsx`
- `client/src/components/pos/PosAlterationIntakeModal.tsx`
- `client/src/components/pos/RegisterGiftCardLoadModal.tsx`
- `client/src/components/scheduler/AppointmentModal.tsx`
- `client/src/components/customers/CustomerRelationshipHubDrawer.tsx`
- `client/src/components/layout/DetailDrawer.tsx`

## Already Started

The first implementation pass added real mobile presentations for:

- `CustomersWorkspace`
- `OrdersWorkspace`
- `CustomerAlterationsPanel`
- Alterations shell overflow handling in `App.tsx`

Those changes reduce the most visible customer/order/alterations failures, but the broader pattern remains across other modules.

## Recommended Implementation Order

1. **Shared layout primitives**
   - Add reusable responsive table/card primitives.
   - Add a standard mobile toolbar pattern.
   - Add a standard mobile drawer/bottom-sheet mode.

2. **High-frequency POS/PWA workflows**
   - Register lookup
   - Checkout/payment drawers
   - Close register
   - POS alteration intake

3. **Customer-adjacent mirrored workspaces**
   - Shipments hub
   - Gift cards
   - Loyalty
   - Customer relationship drawer tables

4. **Scheduling and staff workflows**
   - Scheduler day/week mobile modes
   - Staff schedule grid
   - Staff workspace tables

5. **Admin-heavy settings and sync panels**
   - Counterpoint sync
   - QBO mapping
   - Reports detail tables
   - Inventory physical/count/import flows

## Verification Needed

Add Playwright coverage for:

- 390 x 844 phone viewport
- 768 x 1024 tablet viewport
- 1024 x 1366 iPad Pro-style viewport
- desktop 1440 x 900 baseline

Minimum smoke routes:

- Customers
- Orders
- Alterations
- POS Register
- Register Lookup
- Gift Cards
- Loyalty
- Shipments
- Scheduler
- Inventory
- Settings / Counterpoint Sync

## Execution Progress (2026-04-26)

Completed in this pass:

- High-frequency POS modal and drawer mobile treatment was expanded across register flows (checkout, close/handoff, gift card load, alteration intake, shipping, exchange/suit swap, approvals, cash adjust, price override, and receipt summary).
- POS cart shell was adjusted for true small-screen behavior (single-column stack on phones, two-column split only at `lg+`) to reduce pointer interception and action-bar reachability problems.
- Shared drawer behavior in `DetailDrawer` was updated to improve bottom-sheet ergonomics and root-level scrolling behavior on compact screens.
- Back Office mobile sidebar stacking was corrected (`client/src/components/layout/Sidebar.tsx`) so workspace content no longer intercepts sidebar taps on phone viewports.
- `ShipmentsHubSection` now renders a compact mobile card list instead of forcing a table-first layout on phones/tablets, while preserving the desktop table view.
- `InventoryControlBoard` now contains horizontal overflow inside the board shell, reduces rigid minimum widths on small screens, and keeps quick-pick controls usable with compact horizontal scrolling.
- `CustomerRelationshipHubDrawer` now renders compact small-screen card layouts for transaction/order history and measurement archive rows, with existing table layouts preserved for desktop.
- `StaffWorkspace` audit events now render compact card rows on small screens (`staff-audit-cards`) while preserving the desktop audit table (`staff-audit-table`), and audit/team filter controls now wrap without fixed-width crowding on phones.
- `ReportsWorkspace` now renders compact card lists for row-based report outputs (`reports-detail-cards`) and row-object report outputs (`reports-detail-row-object-cards`) on small screens while preserving desktop tables.
- `SchedulerWorkspace` search popover and week grid minimum widths were reduced for better phone/tablet horizontal fit.
- `LoyaltyWorkspace` settings/adjust columns now avoid fixed-width side-panel squeeze on compact screens, issuance-history action buttons remain touch-accessible on small screens (`loyalty-history-actions`), and small-screen stat cards use tighter min-width sizing.
- `GiftCardsWorkspace` now exposes deterministic responsive mode hooks (`gift-cards-card-list`, `gift-cards-table`) and improves compact header/action wrapping on smaller screens.
- `SchedulerWorkspace` day/week grid time columns now compress on very small screens and date-range controls wrap without horizontal clipping.
- `StaffWorkspace` team bulk controls now stack cleanly on compact screens (`staff-team-bulk-controls`) with full-width action buttons for tap reliability.
- `ReportsWorkspace` detail header + filter controls now use compact full-width stacking on small screens (`reports-detail-filters`) to prevent horizontal crowding.
- `CategoryManager` now reduces compact indentation and fixed-width create-form pressure, with mobile-first stacking and reduced nested-scroll trapping.
- `AppointmentModal` now stacks phone/notes fields correctly on small screens, keeps status and footer actions tap-reachable with compact full-width controls, and exposes `appointment-modal` for deterministic viewport testing.
- `SettingsWorkspace` content density was normalized for compact screens (responsive root/workspace padding and card spacing for general/remote sections) via `settings-workspace-content`.

New small-screen smoke coverage added:

- `client/e2e/pos-small-screen-smoke.spec.ts` (phone/tablet/iPad/desktop): POS register baseline + checkout drawer reachability.
- `client/e2e/pos-modal-smoke.spec.ts` (phone/tablet): gift-card modal to completed sale flow with tender application/finalize assertions.
- `client/e2e/backoffice-workspace-nav-smoke.spec.ts` (phone/tablet/iPad/desktop): customers, orders, gift cards, loyalty, appointments, inventory, and settings navigation stability.
- `client/e2e/backoffice-mobile-workflow-smoke.spec.ts` (phone/tablet/iPad/desktop): deeper workflow interaction checks for scheduler controls, inventory receive-stock handoff, customers shipments subsection, gift-card refresh actions, and loyalty eligible-customer refresh.
- `client/e2e/customer-relationship-mobile-cards.spec.ts` (phone/tablet/iPad/desktop): mocked deterministic coverage that opens the customer relationship drawer and verifies compact card rendering for transaction history + measurement archive on small screens while preserving table behavior on larger layouts.
- `client/e2e/reports-mobile-cards.spec.ts` (phone/tablet/iPad/desktop): mocked deterministic coverage for margin pivot and NYS tax audit responses to verify compact card rendering on small screens and table rendering on desktop.
- `client/e2e/gift-cards-mobile-cards.spec.ts` (phone/tablet/iPad/desktop): mocked deterministic coverage for gift-card inventory responsive rendering (compact cards on small screens vs table on larger layouts).
- `client/e2e/scheduler-mobile-ergonomics.spec.ts` (phone/tablet/iPad/desktop): verifies compact scheduler week-grid time-column sizing and search popover width behavior across viewports.
- `client/e2e/loyalty-eligible-mobile.spec.ts` (phone/tablet/iPad/desktop): verifies loyalty eligible-list row/action visibility and compact action reachability on small screens.
- `client/e2e/settings-mobile-sections.spec.ts` (phone/tablet/iPad/desktop): verifies compact Settings workspace routing and visibility for General, Help Center, and Bug Reports sections.
- `client/e2e/alterations-register-lookup-mobile.spec.ts` (phone/tablet/iPad/desktop): verifies compact Alterations interaction and register lookup viability through POS product search on the register surface.

Explicitly deferred per current direction:

- Counterpoint sync and QBO mapping audit items are out of scope for this implementation batch.
