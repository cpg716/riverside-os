---
id: inventory-receiving-bay
title: "Receive Stock"
order: 1024
summary: "Receive vendor paperwork, recover from load failures, and post stock exactly once."
source: client/src/components/inventory/ReceivingBay.tsx
last_scanned: 2026-05-10
tags: inventory-receiving-bay, inventory, receiving, purchase-orders
status: approved
---

# Receive Stock

## Screenshots

![Inventory control board](../images/help/inventory-control-board/main.png)

![Purchase order panel](../images/help/inventory-purchase-order-panel/main.png)

![Receive Stock workflow](../images/help/inventory-receiving-bay/main.png)
## What this is

Receive Stock is the guided workflow for counting inbound quantities and posting received stock from vendor paperwork.

Receiving does not post stock until the final post action succeeds.

## How to use it

1. Open Receive Stock from the correct vendor paperwork.
2. Confirm the vendor, stage, warnings, and line items.
3. Search or scan any extra vendor invoice items that arrived with the shipment, then confirm quantity, unit cost, and retail before adding the line.
4. If the scanned item is not in the catalog, use **Quick Add Item** to create the vendor-linked SKU and return it to the invoice line entry.
5. Enter received quantities, invoice number, and freight.
6. Post receiving once the count is correct.

## Start receiving

Open Receive Stock from a purchase order or ready vendor paperwork. Confirm the vendor, paperwork, and line items before entering received quantities.

If paperwork cannot load, the drawer shows a recovery state with a retry action. The message confirms that receiving has not posted, so staff can retry or close safely.

The item-entry strip appears above the receiving table for open receiving documents. Search by product name, SKU, or scanner input, confirm the current cost and retail, then add the line. Use it when a vendor shipment includes extra non-PO items on the invoice. Added invoice lines stage their received quantity but still do not change live inventory until **Post Receipt** succeeds.

Use **Quick Add Item** when paperwork contains a SKU that does not exist yet. Riverside OS creates the catalog item for the current vendor with zero starting stock, selects it for the invoice, and leaves stock unchanged until the receipt posts.

When a reviewed vendor import is converted to a direct invoice, Riverside OS opens this same Receive Stock screen for the created invoice so staff can finish invoice number, freight, staged quantities, and final posting from one place.

## Current stage and warnings

Use the stepper, current-stage guidance, and receiving warnings first. These deterministic facts explain what is ready, what is missing, and what action comes next.

Optional ROSIE receiving insight appears below those facts and should only explain the visible receiving state.

## Receiving quantities

Enter received quantities carefully. Review warnings before posting, especially when quantities do not match the vendor paperwork.

Before posting, unreceived lines can be corrected for ordered quantity and invoice unit cost. Once **Post Receipt** succeeds, those inventory and accounting records are history; use stock correction or vendor return workflows instead of editing the posted receipt.

Unit cost and freight fields accept typed decimal amounts from the invoice paperwork. Enter the exact invoice cost before posting.

Posted receiving reports show invoice unit cost, merchandise extended total, and freight allocation as separate values. Freight is not added into item cost; QBO distribution and sync review post inbound freight separately from merchandise receiving.

## Stale paperwork

If the latest vendor paperwork cannot refresh but previously loaded rows remain visible, Riverside OS warns that the paperwork may not be current and that it is showing the last successfully loaded results.

The rows remain usable, but staff should retry refresh before posting whenever the warning appears.

## What to watch for

- Do not post receiving from stale paperwork unless a manager confirms it is acceptable.
- If QBO or account glance information is unavailable, receiving should continue with a quiet degraded state.
- If the final post fails, do not re-enter quantities blindly. Confirm whether stock changed before retrying.
- Freight is entered separately from item cost and posts through the receiving workflow for QBO freight handling.

## Related workflows

- [Purchase Orders and Vendor Paperwork](manual:inventory-purchase-order-panel)
- [Inventory Control Board](manual:inventory-control-board)
