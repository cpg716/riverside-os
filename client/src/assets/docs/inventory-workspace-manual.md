---
id: inventory-workspace
title: "Inventory Workspace (inventory)"
order: 1017
summary: "Back Office inventory hub for control board, product setup, procurement, receiving, vendors, import, and physical count."
source: client/src/components/inventory/InventoryWorkspace.tsx
last_scanned: 2026-04-21
tags: inventory-workspace, inventory, back-office, operations
---

# Inventory Workspace (inventory)

<!-- help:component-source -->
_Linked component: `client/src/components/inventory/InventoryWorkspace.tsx`._
<!-- /help:component-source -->

## What this is

Use **Back Office → Inventory** as the main operational hub for catalog control, procurement, receiving, vendor maintenance, import, and physical count.

Each subsection is job-based:

- **Inventory List** for SKU lookup, stock review, and product hub access
- **Add Inventory** for new product templates
- **Purchase Orders** for standard POs and direct invoices
- **Receiving** as a guided handoff back into **Purchase Orders / Receiving Bay**
- **Import** for catalog-only CSV mapping
- **Vendors** for supplier review and merge cleanup
- **Physical count** for full-store or category reconciliation

## How to use it

1. Enter the subsection that matches the current task instead of trying to do every inventory job from the same panel.
2. Use **Purchase Orders** for all receiving entry points, including direct invoices.
3. Use **Inventory List** or **Product hub** for catalog corrections, not the receiving worksheet.
4. Use **Import** only for catalog structure. Live stock changes belong in **Receiving** or **Physical count**.

## Workflow notes

- The standalone **Receiving** subsection is a routing surface, not a separate stock-adjustment workflow.
- Standard POs must be **drafted**, lined, and **submitted** before receiving can begin.
- Direct invoices skip the separate submit step but still land in the same **Receiving Bay** final posting path.
- Inventory guidance in this workspace now assumes **Counterpoint sync** is the authoritative pre-launch inventory source.

## Tips

- If you are unsure where to adjust quantity, ask whether the change is an **inbound receipt**, a **reconciliation**, or a **catalog correction**.
- If a workflow needs supplier context, start with a clean vendor record before building the PO.
