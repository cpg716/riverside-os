---
id: inventory-workspace
title: "Inventory Workspace (inventory)"
order: 1017
summary: "Back Office inventory hub for item lookup, product setup, purchase orders, receiving, vendors, import, and physical count."
source: client/src/components/inventory/InventoryWorkspace.tsx
last_scanned: 2026-04-21
tags: inventory-workspace, inventory, back-office, operations
---

# Inventory Workspace (inventory)

## Screenshots

![Inventory control board](../images/help/inventory-control-board/main.png)

![Receive Stock workflow](../images/help/inventory-receiving-bay/main.png)

![Purchase order panel](../images/help/inventory-purchase-order-panel/main.png)

## What this is

Use **Back Office → Inventory** as the main operational hub for item lookup, purchase orders, receiving, vendor maintenance, import, and physical count.

Each subsection is job-based:

- **Inventory List** for SKU lookup, stock review, and product hub access
- **New Item** for creating a product and its sellable SKUs
- **Purchase Orders** for standard POs, direct invoices, customer order needs, and Min/Max reorder suggestions
- **Receive Stock** for the same purchase-order-backed receiving workflow
- **Reports** for historical PO, invoice, and receiving reports
- **Import** for catalog-only CSV mapping
- **Vendors** for supplier review and merge cleanup
- **Physical count** for full-store or category reconciliation

## How to use it

1. Enter the subsection that matches the current task instead of trying to do every inventory job from the same panel.
2. Use **Purchase Orders** or **Receive Stock** for receiving entry points, including direct invoices.
3. Use **Inventory List** or **Product hub** for catalog corrections, not the receiving worksheet.
4. Use **Import** only for catalog structure. Live stock changes belong in **Receiving** or **Physical count**.
5. Use **Reports** when you need to search, view, or reprint historical receiving paperwork by vendor, invoice, PO, item, SKU, or date.

## Workflow notes

- **Receive Stock** opens the purchase-order-backed workflow directly. It is not a separate manual stock-adjustment path.
- Standard POs must be **drafted**, lined, and **submitted** before receiving can begin.
- Direct invoices skip the separate submit step but still land in the same **Receive Stock** final posting path.
- Inventory guidance in this workspace now assumes **Counterpoint sync** is the authoritative pre-launch inventory source.

## Operational detail

Use Inventory List for search, review, and triage. Use Product Hub for item-level cleanup, Receive Stock for inbound quantity changes, and Physical Inventory for count reconciliation. If search returns no rows during a known outage or stale-index warning, treat it as a lookup problem, not proof that the SKU does not exist.


## Tips

- If you are unsure where to adjust quantity, ask whether the change is an **inbound receipt**, a **reconciliation**, or a **catalog correction**.
- If a workflow needs supplier context, start with a clean vendor record before building the PO.

## Related workflows

- [Inventory Control Board](manual:inventory-control-board)
- [Receive Stock](manual:inventory-receiving-bay)
