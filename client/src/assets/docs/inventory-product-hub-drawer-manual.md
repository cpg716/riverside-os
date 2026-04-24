---
id: inventory-product-hub-drawer
title: "Product Hub Drawer (inventory)"
order: 1021
summary: "Authoritative product detail drawer for inventory truth, variation review, and low-friction retail price-tag printing."
source: client/src/components/inventory/ProductHubDrawer.tsx
last_scanned: 2026-04-23
tags: inventory-product-hub-drawer, inventory, product-hub, retail-price-tags
status: approved
---

# Product Hub Drawer (inventory)

<!-- help:component-source -->
_Linked component: `client/src/components/inventory/ProductHubDrawer.tsx`._
<!-- /help:component-source -->

## What this is

Use Product Hub when staff need the authoritative SKU view for inventory, recent movement, and purchase-order context.

## When to use it

Use Product Hub when you need to:

1. Confirm the live inventory truth for one product before promising or printing.
2. Review all variations in one place.
3. Print retail price tags from the product detail view instead of the Inventory List.
4. Check recent inventory events or incoming PO context before taking action.

## Before you start

- Open the correct product from **Inventory List** or another inventory surface.
- Confirm whether you want tags for all variations or only selected variations.
- If the quantity should match a shipment you just received, use **Receive Stock** first so the received quantity is staged correctly there.

## What the inventory truth panel means

- `On hand`
  Physical units Riverside currently counts in stock.
- `Reserved in store`
  Units already committed to open order, wedding, or other pickup work.
- `Available now`
  The live sellable quantity after Riverside subtracts reserved units from on-hand stock.
- `On order`
  Incoming purchase-order units only. These are not available to sell until the receipt posts.

The Product Hub panel is a visibility surface. It uses current server-computed values instead of asking staff to calculate availability themselves.

## How to use it

1. Open the product from Inventory.
2. Review `On hand`, `Reserved in store`, and `Available now` before promising stock.
3. Check `On order` only as incoming pipeline, not as current sellable stock.
4. Use `Print retail price tags` from the General section when you want to print from the product detail view.
5. In the Variations tab, use `Print all tags` or select specific variations first and then use `Print selected tags`.
6. Review the shared retail price-tag dialog, adjust quantities, and confirm the final print batch.
7. Use recent inventory events when you need to confirm why the number changed.

## What the retail price-tag review does

- Riverside brings in the real product name, variation label, SKU, brand, and effective retail price.
- The print review dialog lets you change tag quantity per variation before anything prints.
- A quantity of `0` skips that variation.
- After a successful print, Riverside marks the printed variations as shelf-labeled.

## What to watch for

- Reserved units are already promised and should not be treated as walk-in availability.
- Available quantity follows the current server rule, not a manual floor estimate.
- Incoming PO units only count after receiving posts the inventory movement.
- `Print all tags` includes every variation shown in the workspace. Use selection first if you only need a smaller subset.

## What happens next

- Direct print sends the approved retail price-tag batch to the Zebra LP2844.
- If direct print is unavailable, Riverside opens the print preview instead.
- Product Hub stays open so you can keep reviewing the product, switch tabs, or correct the next variation batch.

## Related workflows

- Use **Inventory Control Board** when you want the fastest browse-to-print path.
- Use **Variations Workspace** for matrix selection and selected-variation printing.
- Use **Receive Stock** when a PO or direct invoice should drive the tag quantity.

## Rule reminders

- Reserved units are already promised and should not be treated as walk-in availability.
- Available quantity follows the current server rule, not a manual floor estimate.
- Incoming PO units only count after receiving posts the inventory movement.
