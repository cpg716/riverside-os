# Historical Porting Plan: New Features to Legacy UI

**Status:** **Superseded / historical.** This was a one-time porting checklist for an older UI transition. Do not treat the component list below as current shell guidance; use **[`DEVELOPER.md`](../DEVELOPER.md)**, **[`docs/CLIENT_UI_CONVENTIONS.md`](./CLIENT_UI_CONVENTIONS.md)**, and **[`docs/ROS_UI_CONSISTENCY_PLAN.md`](./ROS_UI_CONSISTENCY_PLAN.md)** for current UI architecture.

## Overview
Historical checklist for carefully adding features from an overhaul stash while preserving the then-current legacy UI styling.

---

## Type 1: New Components (Priority Order)

### 1. CommandPalette (Cmd+K)
- **File**: `client/src/components/layout/CommandPalette.tsx`
- **Status**: Written with the legacy styling of that period
- **Next**: Wire into App.tsx with Cmd+K trigger
- **Test**: Press Cmd+K, search works, navigation works

### 2. InventoryIntelligencePanel
- **File**: `client/src/components/inventory/InventoryIntelligencePanel.tsx`
- **Status**: Pending review
- **Next**: Style check, wire into Inventory workspace

### 3. FulfillmentCommandCenter  
- **File**: `client/src/components/operations/FulfillmentCommandCenter.tsx`
- **Status**: Pending review
- **Next**: Style check, wire into Operations workspace

### 4. CommissionTraceModal
- **File**: `client/src/components/staff/CommissionTraceModal.tsx`
- **Status**: Pending review
- **Next**: Style check, wire into Staff workspace

### 5. WeddingHealthHeatmap
- **File**: `client/src/components/wedding-manager/components/WeddingHealthHeatmap.jsx`
- **Status**: Pending review
- **Next**: Style check, wire into Wedding Manager

---

## Type 2: Existing Screen Changes

These require careful diff analysis - port only functionality, apply OLD styling.

### Priority Screen Changes:
1. Cart.tsx - New hooks (useCartActions, useCartPersistence, etc.)
2. InventoryWorkspace - New panels
3. Settings panels - New configuration

---

## Implementation Notes

- At the time, all new components used legacy UI tokens:
  - `--app-surface`, `--app-border`, `--app-text`, `--app-accent`
  - Existing component patterns as reference
  - NO new colors from the broken overhaul

- Testing protocol:
  - `npm run lint` = 0 errors
  - `npm run build` = passes  
  - Manual test = feature works + matches the legacy UI

---

## History
- 2026-04-12: Initial plan created
- First feature to port: CommandPalette
