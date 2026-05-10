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

![Receive Stock workflow](../images/help/inventory-receiving-bay/main.png)
## What this is

Receive Stock is the guided workflow for counting inbound quantities and posting received stock from vendor paperwork.

Receiving does not post stock until the final post action succeeds.

## How to use it

1. Open Receive Stock from the correct vendor paperwork.
2. Confirm the vendor, stage, warnings, and line items.
3. Enter received quantities and resolve any blocking warnings.
4. Post receiving once the count is correct.

## Start receiving

Open Receive Stock from a purchase order or ready vendor paperwork. Confirm the vendor, paperwork, and line items before entering received quantities.

If paperwork cannot load, the drawer shows a recovery state with a retry action. The message confirms that receiving has not posted, so staff can retry or close safely.

## Current stage and warnings

Use the stepper, current-stage guidance, and receiving warnings first. These deterministic facts explain what is ready, what is missing, and what action comes next.

Optional ROSIE receiving insight appears below those facts and should only explain the visible receiving state.

## Receiving quantities

Enter received quantities carefully. Review warnings before posting, especially when quantities do not match the vendor paperwork.

## Stale paperwork

If the latest vendor paperwork cannot refresh but previously loaded rows remain visible, Riverside OS warns that the paperwork may not be current and that it is showing the last successfully loaded results.

The rows remain usable, but staff should retry refresh before posting whenever the warning appears.

## What to watch for

- Do not post receiving from stale paperwork unless a manager confirms it is acceptable.
- If QBO or account glance information is unavailable, receiving should continue with a quiet degraded state.
- If the final post fails, do not re-enter quantities blindly. Confirm whether stock changed before retrying.

## Related workflows

- [Purchase Orders and Vendor Paperwork](manual:inventory-purchase-order-panel)
- [Inventory Control Board](manual:inventory-control-board)
