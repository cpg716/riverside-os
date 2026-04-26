# PWA and Small-Screen Layout Audit

Date: 2026-04-26

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

