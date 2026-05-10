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

## What this is

Inventory Control Board is the main staff surface for finding products, reviewing stock, and opening Product Hub.

The product list is primary. Item Readiness and Inventory Cleanup Review sit below the inventory list so staff can search, filter, and page through products before reviewing cleanup work.

## How to use it

1. Search or filter the inventory list.
2. Review the first 20 rows and use **Load More Inventory** when you need more results.
3. Open a product row for Product Hub details and actions.
4. Use Item Readiness or Inventory Cleanup Review after reviewing the list.

## Search and filters

Use the main search field for product name, SKU, item number, or variation text. Use vendor, category, stock, label, high value, web, and department filters to narrow the list.

The list shows 20 items at a time. Select **Load More Inventory** to keep paging through results without losing the current filters.

## Open Product Hub

Select a product row to open the Product Hub drawer. Product Hub contains general information, variations, history, labels, damage, return-to-vendor, and other item actions.

## Item Readiness

Item Readiness shows visible inventory that is missing fields needed for purchasing, selling, or reporting.

The readiness cards are action cards. Select a card, such as **Category Missing** or **Vendor Missing**, to open the filtered list of items that need that fix.

Use the list first, then fix items in Product Hub.

## Inventory Cleanup Review

Inventory Cleanup Review summarizes Counterpoint and Lightspeed reference cleanup signals. It explains whether cleanup is ready and which references or aliases are available.

This review is informational. Use Product Hub and Counterpoint Settings for the actual review and safe apply workflows.

## What to watch for

- A true empty result means the current filters returned no matching inventory.
- A failed load should show a degraded state rather than pretending the inventory is empty.
- Do not treat readiness counts as automatic changes. Staff still review and apply fixes deliberately.
