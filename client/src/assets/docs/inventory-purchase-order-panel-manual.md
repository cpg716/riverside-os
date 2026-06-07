---
id: inventory-purchase-order-panel
title: "Purchase Orders and Vendor Paperwork"
order: 1023
summary: "Create, review, refresh, and receive purchase orders or vendor paperwork."
source: client/src/components/inventory/PurchaseOrderPanel.tsx
last_scanned: 2026-06-02
tags: inventory-purchase-order-panel, inventory, purchase-orders, vendors
status: approved
---

# Purchase Orders and Vendor Paperwork

## Screenshots

![Inventory control board](../images/help/inventory-control-board/main.png)

![Receive Stock workflow](../images/help/inventory-receiving-bay/main.png)

![Purchase Orders and vendor paperwork](../images/help/inventory-purchase-order-panel/main.png)
## What this is

Purchase Orders is the inventory surface for vendor paperwork. Staff use it to create purchase orders, review paperwork, and open Receive Stock.

## How to use it

1. Open Purchase Orders from Inventory.
2. Select a vendor, then choose **New PO** when you are building an order.
3. Review customer order items and **Min/Max reorder suggestions** for the selected vendor. Suggested Min/Max quantities use the item reorder point, available stock, and units already on open POs.
4. Add lines in the open paperwork panel. Search or scan an item, confirm quantity, unit cost, and retail, then add the line.
5. If the item is not in the catalog yet, use **Quick Add Item** to create the SKU for the selected vendor and immediately use it on the open paperwork.
6. Mark a standard PO sent only after the lines are correct.
7. Open **Receive Stock** when submitted paperwork or a direct invoice is ready to post inventory.

## Vendor paperwork states

Riverside OS separates three states:

- **Loading:** paperwork is still being fetched.
- **Failed load:** paperwork could not load and staff should retry.
- **Successful empty:** no vendor paperwork is ready.

The empty message only appears after a successful empty response.

## Stale refresh warning

If paperwork loaded successfully once and a later refresh fails, the existing rows stay visible. A quiet warning explains that vendor paperwork may not be current and that the screen is showing the last successfully loaded results.

Retry refresh before receiving when this warning appears.

## Open Receive Stock

Use the visible **Open** action to continue editing draft paperwork. Use **Receive** or **Receive Stock** to open the receiving drawer when the document is ready.

Direct invoices are for merchandise already in hand without a pre-built standard PO. They open into Receive Stock so staff can add invoice lines, quick-create missing SKUs, confirm costs and retail, enter freight, and post inventory from the same receipt workflow.

Min/Max reorder suggestions are vendor-specific. The product primary vendor controls these suggestions; secondary vendors are approved alternate PO/receiving sources but do not take over Min/Max suggestion ownership.

Imports from vendor paperwork also open the created document. Direct-invoice imports continue into Receive Stock; standard PO imports continue into Order Stock for final review before marking sent.

## Operational detail

Use the purchase order panel to understand vendor paperwork before receiving. A PO can explain what should arrive, what is overdue, and which lines are still open. Do not use receiving to compensate for a wrong PO without first correcting or documenting the vendor paperwork issue.


## What to watch for

- Do not treat stale rows as newly confirmed paperwork.
- If vendor paperwork cannot load at all, retry or ask a manager before receiving.
- Do not create duplicate purchase orders just because a refresh failed.
- Sent standard POs do not post inventory until Receive Stock is posted. Unposted receiving lines can still be corrected for ordered quantity and invoice unit cost before posting.
- Posted receipts are immutable inventory/accounting history. Use stock correction or vendor return workflows for fixes after posting.

## Related workflows

- [Receive Stock](manual:inventory-receiving-bay)
- [Inventory Control Board](manual:inventory-control-board)
