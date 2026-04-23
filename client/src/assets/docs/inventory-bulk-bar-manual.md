---
id: inventory-bulk-bar
title: "Inventory Bulk Bar (inventory)"
order: 1015
summary: "Selection toolbar for inventory list actions including bulk retail price-tag printing."
source: client/src/components/inventory/InventoryBulkBar.tsx
last_scanned: 2026-04-23
tags: inventory-bulk-bar, inventory, bulk-actions, retail-price-tags
status: approved
---

# Inventory Bulk Bar (inventory)

<!-- help:component-source -->
_Linked component: `client/src/components/inventory/InventoryBulkBar.tsx`._
<!-- /help:component-source -->

## What this is

Use the **Inventory Bulk Bar** when you have selected one or more products in Inventory List and need to act on that selection without opening every product one by one.

## When to use it

Use it when you need to:

1. Print retail price tags for a selected product set.
2. Run other bulk inventory actions from the current list selection.

## Before you start

- Make sure the selected products are the ones you actually want to act on.
- For tag printing, remember that each selected product may expand into multiple variations in the review dialog.

## Steps

1. In **Inventory List**, select the products you want.
2. Use `Bulk print price tags`.
3. Review the variation-aware print dialog and adjust quantities where needed.
4. Confirm the final retail price-tag batch.

## What to watch for

- Bulk selection does not bypass review. The final dialog is still where you confirm the exact variation quantities.
- Use `Set all to 1` in the dialog when you want the fastest one-tag-per-variation batch.

## What happens next

- Riverside sends the reviewed batch to the Zebra LP2844 or opens print preview if direct print is unavailable.
- The selection toolbar stays tied to the current list so you can continue with another bulk action if needed.

## Related workflows

- Use **Inventory Control Board** for the main browse-and-select workflow.
- Use **Product Hub Drawer** when you want to print from one product’s detail view instead of from a bulk list.
