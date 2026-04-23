---
id: inventory-control-board
title: "Inventory Control Board (inventory)"
order: 1016
summary: "High-density SKU discovery surface for catalog search, filtering, product hub access, and controlled inventory maintenance."
source: client/src/components/inventory/InventoryControlBoard.tsx
last_scanned: 2026-04-21
tags: inventory-control-board, inventory, control-board, catalog
---

# Inventory Control Board (inventory)

<!-- help:component-source -->
_Linked component: `client/src/components/inventory/InventoryControlBoard.tsx`._
<!-- /help:component-source -->

## What this is

Use **Inventory List** as the main SKU browse and control surface for searching inventory, filtering large catalogs, opening the **Product hub**, and handling controlled stock maintenance tasks.

## How to use it

1. Search by SKU, product name, vendor, or category filters.
2. Open the **Product hub** for matrix, history, pricing, and vendor-linked corrections.
3. Use bulk tools carefully for labels and catalog maintenance.
4. Treat receiving as a procurement workflow, not as an inline stock-edit workflow from this board.

## Workflow notes

- This board is optimized for lookup, review, and controlled maintenance, not for inbound receipt posting.
- Low-stock and replenishment signals depend on the current catalog and variant settings.
- If you need to correct live on-hand after a full count, use **Physical count** review/publish rather than casual manual edits.
- The `Catalog Completeness` summary is a lightweight quality signal for the current filtered view. It calls out visible templates that are missing a brand, category, or primary vendor so staff can clean up the core identity fields before purchasing or merchandising work depends on them.

## Tips

- When a SKU looks wrong for a vendor, open the **Product hub** before building a PO.
- If a result is missing, confirm the exact SKU first and then widen filters instead of relying on broad fuzzy search alone.
