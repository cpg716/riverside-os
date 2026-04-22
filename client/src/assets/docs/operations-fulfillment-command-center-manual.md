---
id: operations-fulfillment-command-center
title: "Pickup Queue"
order: 1053
summary: "Prioritize ready, rush, due-soon, and blocked orders from the Operations pickup queue."
source: client/src/components/operations/FulfillmentCommandCenter.tsx
last_scanned: 2026-04-22
tags: operations, pickup-queue, orders, ready-for-pickup, rush
---

# Pickup Queue

<!-- help:component-source -->
_Linked component: `client/src/components/operations/FulfillmentCommandCenter.tsx`._
<!-- /help:component-source -->

## What this is

Pickup Queue is the Operations priority view for order follow-up.

It highlights:

- **Ready for Pickup**
- **Rush Orders**
- **Due Soon**
- **Stagnant / Blocked**

This is narrower than the full **Orders** workspace. Use it to decide what needs attention first.

## How to use it

1. Open **Operations** → **Pickup Queue**.
2. Tap a metric card to filter the list.
3. Open an order row to continue work in the order record.
4. Use **Print Queue** if the floor needs a paper priority list.

## Tips

- **Ready for Pickup** is about customer release and follow-up.
- **Rush** and **Due Soon** help staff prioritize same-day and near-term work.
- **Blocked** is the cleanup list for orders that have stalled and need staff action.
