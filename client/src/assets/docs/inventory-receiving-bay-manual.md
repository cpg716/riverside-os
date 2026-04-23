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

## When to use it

Use this workflow when you need to:

1. Receive a submitted standard PO.
2. Receive a direct invoice created from **Purchase Orders**.
3. Review the exact quantities that arrived before inventory posts.
4. Print the retail price tags that should go onto the newly received products.

## Before you start

- Confirm the PO or direct invoice is the correct vendor paperwork.
- Have invoice number, freight, and unit cost information ready before posting.
- If you plan to tag received products right away, enter the real received quantity for each variation first so the tag review can prefill correctly.

## How to use it

1. Open **Purchase Orders** and choose the submitted PO or direct invoice you want to receive.
2. In **Receiving Bay**, scan SKU or vendor UPC, or type the received quantity directly into the worksheet.
3. Review invoice number, freight, and unit cost before posting.
4. Use **Review price tags** when you want Riverside to prefill the tag batch from `qty_receiving`.
5. In the retail price-tag dialog, confirm or adjust the quantity for each received variation.
6. Print the tags you need.
7. Confirm **Post inventory** only when the worksheet matches the vendor paperwork.

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

## What the price-tag review does

- The dialog includes only lines with a staged `qty_receiving` greater than `0`.
- The default print quantity matches the staged receiving quantity for each line.
- `Use staged qty` restores the received-quantity defaults if you changed them.
- `Set all to 1` is useful when you only need one floor tag per received variation.
- Printing tags does not post inventory by itself. Posting still requires the explicit **Post inventory** action.

## What to watch for

- Do not skip the review dialog if the vendor short-shipped or substituted a variation. Adjust the receiving worksheet first so the prefilled tag count stays accurate.
- Direct invoices and standard POs use the same receiving and tag-review path.
- If the worksheet says a line is already at max quantity, stop and review the packing slip before forcing another receipt.
- If the vendor sent the wrong SKU, fix the PO or vendor linkage first instead of receiving it against the wrong line.

## What happens next

- Printed tags go to the Zebra LP2844 when direct print is available, or to print preview when it is not.
- After printing, staff can continue reviewing the worksheet and then post inventory once the receipt is final.
- Posting inventory is still the only action that mutates live stock.

## Tips

- Use `Review price tags` before posting when you want a single operator flow from receiving to floor-ready product tags.
- If you only want a few tags from a larger receipt, zero out the extra lines in the review dialog instead of editing the PO quantities themselves.
