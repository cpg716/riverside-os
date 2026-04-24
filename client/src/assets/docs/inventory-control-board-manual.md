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

Use **Inventory List** as the main SKU browse and control surface for searching inventory, filtering large catalogs, opening the **Product hub**, and printing retail price tags with as little friction as possible.

## When to use it

Use this board when you need to:

1. Find a product quickly by SKU, product name, vendor, or category.
2. Open the **Product hub** to review availability, pricing, history, or variations.
3. Print one or more **retail price tags** for the floor without going through receiving.
4. Start from a filtered or selected list when several products need tags at once.

## Before you start

- Confirm you are working with the correct product and variation before printing.
- Use the Zebra LP2844 retail price-tag stock that matches your station.
- Treat this board as a browse-and-review surface. If the product arrived on a PO or direct invoice and you want the received quantity to drive the tag count, use **Receive Stock** instead.

## How to use it

1. Search by SKU, product name, vendor, or category filters.
2. Click the printer action on a row to open the **retail price tag review** dialog.
3. Review every variation the product includes. Riverside defaults to one tag per variation unless you change the quantities.
4. Use the quick actions when they help:
   - `Use staged qty` restores the prefilled quantity for each row.
   - `Set all to 1` is the fastest way to print one tag per variation.
   - `Clear all` lets you zero out the batch and build it back intentionally.
5. Confirm **Print retail price tags** to send the job to the Zebra station, or to the print preview when direct print is unavailable.
6. Open the **Product hub** when you need matrix, history, pricing, or vendor-linked corrections before printing.

## What to watch for

- The review dialog is variation-aware. Do not assume a single product row means a single printed tag.
- A quantity of `0` skips that variation.
- If the result is missing, confirm the exact SKU first and then widen filters instead of relying on broad fuzzy search alone.
- If a SKU looks wrong for a vendor, open the **Product hub** before printing or purchasing.
- Treat receiving as a procurement workflow, not as an inline stock-edit workflow from this board.

## What happens next

- Riverside sends the selected retail price tags to the Zebra LP2844 when the direct print path is available.
- If direct print is unavailable, Riverside opens the print preview instead so the batch can still be completed.
- Printed variations are marked as shelf-labeled so the team has a better signal that tags were already produced.

## Related workflows

- Use **Product Hub Drawer** when you want to print from the product detail surface instead of the browse list.
- Use **Receive Stock** when the correct tag quantity should come from what was actually received on a PO or direct invoice.

## Workflow notes

- This board is optimized for lookup, review, and controlled maintenance, not for inbound receipt posting.
- Low-stock and replenishment signals depend on the current catalog and variant settings.
- If you need to correct live on-hand after a full count, use **Physical count** review/publish rather than casual manual edits.
- The `Catalog Completeness` summary is a lightweight quality signal for the current filtered view. It calls out visible templates that are missing a brand, category, or primary vendor so staff can clean up the core identity fields before purchasing or merchandising work depends on them.

## Tips

- For the fastest floor workflow, filter the list, print the tags you need, and only open Product Hub when something looks off.
- Use bulk selection when you need to print several retail price-tag batches from the same filtered view.
