---
id: inventory-bulk-bar
title: "Inventory Bulk Bar (inventory)"
order: 1015
summary: "Selection toolbar for inventory list actions including bulk retail price-tag printing."
source: client/src/components/inventory/InventoryBulkBar.tsx
last_scanned: 2026-06-02
tags: inventory-bulk-bar, inventory, bulk-actions, retail-price-tags
status: approved
---

# Inventory Bulk Bar (inventory)

## Screenshots

![Inventory list](../images/help/inventory-bulk-bar/workflow-1.png)

![Receive Stock workflow](../images/help/inventory-bulk-bar/workflow-2.png)

![Purchase order panel](../images/help/inventory-bulk-bar/workflow-3.png)

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

## Operational detail

Bulk actions are for clean, reviewed selections only. Before applying a bulk change, filter the list down to the exact intended SKUs and scan the selected rows for outliers such as inactive products, wrong category, or unexpected vendor. If the selection includes financial or stock-sensitive fields, pause and use a smaller batch.

## Batch Scan

Use **Inventory → Batch Scan** when you have a group of scanned SKUs, barcodes, or vendor UPCs and need to confirm which records ROS can resolve. Paste or scan one code per line, then run **Resolve Batch**.

Batch Scan is resolution-only. It does not receive inventory, adjust stock, start a physical count, or change costs. If the scan is part of receiving, continue through **Receive Stock**. If it is part of a count or correction, use **Physical Inventory** or the approved stock-adjustment workflow.


## What to watch for

- Bulk selection does not bypass review. The final dialog is still where you confirm the exact variation quantities.
- Tag quantities pre-fill from current on-hand stock. Zero-stock variations start at `0`; change a line quantity when you need a different tag count.
- Use a row's **Print tag** action when you only need tags for that one variation.

## What happens next

- Riverside sends the reviewed label batch to the configured **Zebra LP 2844** tag station using the saved tag printer language and layout. Desktop/Main Hub dispatch reports the printer error if the Zebra queue cannot accept the job.
- Riverside leaves shelf-label status unchanged until a direct tag-station job succeeds. Preview is not used as proof that tags printed.
- The selection toolbar stays tied to the current list so you can continue with another bulk action if needed.

## Related workflows

- Use **Inventory Control Board** for the main browse-and-select workflow.
- Use **Product Hub Drawer** when you want to print from one product’s detail view instead of from a bulk list.
