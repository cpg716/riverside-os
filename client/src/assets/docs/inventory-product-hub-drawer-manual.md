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

# Product Hub Drawer

## Screenshots

![Inventory list](../images/help/inventory-product-hub-drawer/inventory-list.png)

![Receive Stock context](../images/help/inventory-product-hub-drawer/receiving-context.png)

![Purchase order context](../images/help/inventory-product-hub-drawer/purchase-orders-context.png)

The Product Hub is the single source of truth for a specific SKU. Use it to verify inventory levels, review variations, and print retail price tags.

## What this is

Use the **Product Hub** when you need to drill down into the details of a single product. It aggregates live inventory counts, recent movement logs, and purchase order context into one side panel.

## When to use it

Use Product Hub when you need to:

1. Confirm the live inventory truth for one product before promising or printing.
2. Review all variations in one place.
3. Print retail price tags from the product detail view instead of the Inventory List.
4. Check recent inventory events or incoming PO context before taking action.
5. Review or update primary and secondary vendor assignments before ordering.
6. Confirm the product-level `Catalog # / vendor style #` and Counterpoint item number are not being confused.

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

## Vendor assignments

- `Primary vendor`
  The vendor Riverside uses for Min/Max reorder suggestions and stock-out ordering context.
- `Secondary vendors`
  Approved alternate vendors that can be used for PO line entry and receiving without changing the primary Min/Max suggestion vendor. Use the search box to add an alternate vendor, then remove selected vendors from their chips when needed.
- `Catalog # / vendor style #`
  The vendor or supplier identifier used for NuORDER, purchase orders, catalog import, and receiving paperwork.
- `Counterpoint item #`
  A Counterpoint-assigned internal item number such as `I-103067`. Do not treat this as the vendor style/catalog number.

Internal POS and Custom SKUs are sale items, not shelf-counted inventory. Product Hub shows sales and open-order context for those items instead of on-hand and available quantities.

## How to use it

1. Open the product from Inventory.
2. Review `On hand`, `Reserved in store`, and `Available now` before promising stock.
3. Check `On order` only as incoming pipeline, not as current sellable stock.
4. Search vendors in `Primary vendor` or `Secondary vendors` instead of scanning a long vendor list.
5. Use `Print retail price tags` from the General section when you want to print from the product detail view.
6. In the Variations tab, use `Print all tags` or select specific variations first and then use `Print selected tags`.
7. Record variation-level `Product UPC` for manufacturer barcodes and `Catalog # / vendor style #` for supplier buying/receiving identifiers.
8. Review the shared retail price-tag dialog, adjust quantities, and confirm the final print batch.
9. Use recent inventory events when you need to confirm why the number changed.

## What the retail price-tag review does

- Riverside brings in the real product name, variation label, SKU, brand, and effective retail price.
- The print review dialog lets you change tag quantity per variation before anything prints.
- A quantity of `0` skips that variation.
- After a confirmed direct Zebra print, Riverside marks the printed variations as shelf-labeled. If direct tag dispatch fails, Riverside shows the printer error and does not clear the shelf-label-needed state.

## What to watch for

- Reserved units are already promised and should not be treated as walk-in availability.
- Sale-only Internal POS and Custom SKUs do not use on-hand counts. Review sales history and open orders for those items.
- Available quantity follows the current server rule, not a manual floor estimate.
- Incoming PO units only count after receiving posts the inventory movement.
- `Print all tags` includes every variation shown in the workspace. Use selection first if you only need a smaller subset.

## What happens next

- Direct print sends the approved retail price-tag batch to the configured **Zebra LP 2844** tag station using **EPL2**.
- If direct print fails in the desktop app, Riverside shows the printer error and leaves shelf-label status unchanged. Browser/PWA sessions can open print preview as a fallback.
- Product Hub stays open so you can keep reviewing the product, switch tabs, or correct the next variation batch.

## Related workflows

- Use **Inventory Control Board** when you want the fastest browse-to-print path.
- Use **Variations Workspace** for matrix selection and selected-variation printing.
- Use **Receive Stock** when a PO or direct invoice should drive the tag quantity.

## Rule reminders

- Reserved units are already promised and should not be treated as walk-in availability.
- Available quantity follows the current server rule, not a manual floor estimate.
- Incoming PO units only count after receiving posts the inventory movement.
