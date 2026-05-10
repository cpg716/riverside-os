---
id: inventory-purchase-order-panel
title: "Purchase Orders and Vendor Paperwork"
order: 1023
summary: "Create, review, refresh, and receive purchase orders or vendor paperwork."
source: client/src/components/inventory/PurchaseOrderPanel.tsx
last_scanned: 2026-05-10
tags: inventory-purchase-order-panel, inventory, purchase-orders, vendors
status: approved
---

# Purchase Orders and Vendor Paperwork

![Purchase Orders and vendor paperwork](../images/help/inventory-purchase-order-panel/main.png)
## What this is

Purchase Orders is the inventory surface for vendor paperwork. Staff use it to create purchase orders, review paperwork, and open Receive Stock.

## How to use it

1. Open Purchase Orders from Inventory.
2. Wait for vendor paperwork to load or review any failed-load warning.
3. Select the correct paperwork and open Receive Stock when ready.
4. Retry refresh before receiving if stale-paperwork copy appears.

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

Select the correct paperwork and open **Receive Stock**. Review the receiving drawer before posting stock.

## What to watch for

- Do not treat stale rows as newly confirmed paperwork.
- If vendor paperwork cannot load at all, retry or ask a manager before receiving.
- Do not create duplicate purchase orders just because a refresh failed.

## Related workflows

- [Receive Stock](manual:inventory-receiving-bay)
- [Inventory Control Board](manual:inventory-control-board)
