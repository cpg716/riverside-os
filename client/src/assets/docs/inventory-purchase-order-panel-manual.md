---
id: inventory-purchase-order-panel
title: "Purchase Order Panel (inventory)"
order: 1023
summary: "Create purchase orders or direct invoices, submit standard POs, and open Receiving Bay with validated vendor and line rules."
source: client/src/components/inventory/PurchaseOrderPanel.tsx
last_scanned: 2026-04-20
tags: inventory-purchase-order-panel, inventory, purchase-orders, vendors
---

# Purchase Order Panel (inventory)

<!-- help:component-source -->
_Linked component: `client/src/components/inventory/PurchaseOrderPanel.tsx`._
<!-- /help:component-source -->

## What this is

Use **Purchase Orders** to build standard vendor orders or direct-invoice receipts before moving into **Receiving Bay**.

## How to use it

1. Select the correct **vendor** before creating a document.
2. Use **New PO** for a standard order that will be submitted to the vendor.
3. Use **Direct Invoice** when merchandise arrived with invoice paperwork but no pre-built PO.
4. Add lines with a valid SKU, quantity greater than zero, and a non-negative unit cost.
5. For standard POs, click **Submit PO** before receiving.
6. Open **Receiving Bay** to post stock from the finalized receipt.

## Validation rules

- The selected vendor must exist and still be active.
- Standard POs must contain at least one line before they can be submitted.
- PO lines can only be added while the document is still in **draft**.
- If a product already has a different **primary vendor**, ROS blocks adding that SKU to the wrong vendor’s PO.

## Tips

- If the system says a SKU belongs to a different primary vendor, check the product hub before forcing procurement through the wrong supplier.
- Direct invoices skip the separate submit step, but they still enforce the same line and vendor validation.
