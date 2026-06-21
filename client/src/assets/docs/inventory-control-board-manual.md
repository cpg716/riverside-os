---
id: inventory-control-board
title: "Inventory Control Board"
order: 1016
summary: "Find inventory, page through product rows, open Product Hub, and review readiness or cleanup issues."
source: client/src/components/inventory/InventoryControlBoard.tsx
last_scanned: 2026-05-10
tags: inventory-control-board, inventory, control-board, catalog
status: approved
---

# Inventory Control Board

## Screenshots

![Receive Stock workflow](../images/help/inventory-receiving-bay/main.png)

![Purchase order panel](../images/help/inventory-purchase-order-panel/main.png)

![Inventory control board](../images/help/inventory-control-board/main.png)
## What this is

Inventory Control Board is the main staff surface for finding products, reviewing stock, and opening Product Hub.

The product list is primary. Item Readiness and Inventory Cleanup Review sit below the inventory list so staff can search, filter, and page through products before reviewing cleanup work.

## How to use it

1. Search or filter the inventory list.
2. Review the loaded product families and use **Load More Inventory** when you need more results.
3. Open a product row for Product Hub details and actions.
4. Use Item Readiness or Inventory Cleanup Review after reviewing the list.

## Search and filters

Use the main search field for product name, SKU, product UPC, catalog/vendor style number, or variation text. The list is product-centered and shows each product's variation count; direct SKU or exact variation searches show the matched SKU/variation on that product row. Use vendor, category, stock, label, high value, web, and department filters to narrow the list.

Select **Load More Inventory** to keep paging through results without losing the current filters.

## Open Product Hub

Select a product row to open the Product Hub drawer. Product Hub contains general information, variations, history, labels, damage, return-to-vendor, and other item actions.

## Print Tags

Inventory List and Product Hub tag actions send the reviewed batch directly to the configured tag station using the saved tag layout and printer language. The Inventory List tag review pre-fills each variation's tag quantity from current on-hand stock, leaves zero-stock variations at `0`, and lets staff print one variation row by itself. If direct dispatch fails, Riverside shows the printer error and leaves shelf-label status unchanged.

## Item Readiness

Item Readiness shows visible inventory that is missing fields needed for purchasing, selling, or reporting.

The readiness cards are action cards. Select a card, such as **Category Missing** or **Vendor Missing**, to open the filtered list of items that need that fix.

Use the list first, then fix items in Product Hub.

## Inventory Cleanup Review

Inventory Cleanup Review is the cleanup launch area for catalog data-quality work. It shows the biggest safe cleanup queues and lets staff start the work from the card.

Use **Work missing categories** or **Work missing vendors** to filter the inventory list to the affected products. Open a product row from that filtered list and make the correction in Product Hub.

If a Counterpoint/Lightspeed normalization candidate exists, use **Review next product** to open Product Hub for that product family. If the reference status says **Not ready**, rebuild Counterpoint aliases and import the Lightspeed reference from Settings > Counterpoint before treating the normalization counts as actionable.

Use **Show diagnostics** only when you need the detailed reference counters. The **✨ Product cleanup review queue** explains the visible cleanup counts and reference status. ROSIE insight is optional. If ROSIE is unavailable, the deterministic cleanup counts above it remain the source of truth.

## What to watch for

- A true empty result means the current filters returned no matching inventory.
- A failed load should show a degraded state rather than pretending the inventory is empty.
- Do not treat readiness counts as automatic changes. Staff still review and apply fixes deliberately.

## Related workflows

- [Product Hub Drawer](manual:inventory-product-hub-drawer)
- [Purchase Orders and Vendor Paperwork](manual:inventory-purchase-order-panel)
