---
id: inventory-receiving-bay
title: "Receiving Bay (inventory)"
order: 1024
summary: "Stage inbound quantities from submitted POs or direct invoices, then post stock exactly once from the final receipt action."
source: client/src/components/inventory/ReceivingBay.tsx
last_scanned: 2026-04-21
tags: inventory-receiving-bay, inventory, receiving, purchase-orders
---

# Receiving Bay (inventory)

<!-- help:component-source -->
_Linked component: `client/src/components/inventory/ReceivingBay.tsx`._
<!-- /help:component-source -->

## What this is

Use **Receiving Bay** to finish inbound receipts for either:

- a **submitted standard purchase order**, or
- a **direct invoice** created from **Purchase Orders**

This is the only workflow that posts received inventory into live stock for procurement receipts.

## How to use it

1. Open **Purchase Orders** and choose the submitted PO or direct invoice you want to receive.
2. In **Receiving Bay**, scan SKU or vendor UPC, or type the received quantity directly into the worksheet.
3. Review invoice number, freight, and unit cost before posting.
4. Confirm **Post inventory** only when the worksheet matches the vendor paperwork.

## Receiving integrity rules

- Scanning and worksheet edits only **stage** receiving quantities. They do **not** change live `stock_on_hand`.
- The final **Post inventory** action is the authoritative stock mutation path.
- Standard POs and direct invoices share the same final posting logic.
- Replaying the same receipt cannot double-post stock.

## Matching and validation

- If the vendor is configured to use **vendor UPC**, the scanner checks vendor UPC first and then falls back to SKU.
- Standard POs cannot be received while still in **draft**.
- Quantity cannot exceed the remaining open amount on the PO line.
- Freight and unit cost must stay non-negative.

## Tips

- If the worksheet says a line is already at max quantity, stop and review the packing slip before forcing another receipt.
- If the vendor sent the wrong SKU, fix the PO or vendor linkage first instead of receiving it against the wrong line.
