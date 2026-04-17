# Porting New Features to OLD UI - Implementation Plan

## Overview
Carefully adding new features from the overhaul stash while maintaining OLD UI styling.

---

## Type 1: New Components (Priority Order)

### 1. CommandPalette (Cmd+K)
- **File**: `client/src/components/layout/CommandPalette.tsx`
- **Status**: ✅ Written with OLD UI styling
- **Next**: Wire into App.tsx with Cmd+K trigger
- **Test**: Press Cmd+K, search works, navigation works

### 2. InventoryInventory OverviewPanel
- **File**: `client/src/components/inventory/InventoryInventory OverviewPanel.tsx`
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

- All new components MUST use OLD UI tokens:
  - `--app-surface`, `--app-border`, `--app-text`, `--app-accent`
  - Existing component patterns as reference
  - NO new colors from the broken overhaul

- Testing protocol:
  - `npm run lint` = 0 errors
  - `npm run build` = passes  
  - Manual test = feature works + looks like OLD UI

---

## History
- 2026-04-12: Initial plan created
- First feature to port: CommandPalette