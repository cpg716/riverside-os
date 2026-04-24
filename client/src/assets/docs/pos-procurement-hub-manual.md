---
id: pos-procurement-hub
title: "Procurement Hub (pos)"
order: 1065
summary: "POS-side procurement surface for opening purchase orders, direct invoices, and Receive Stock workflows."
source: client/src/components/pos/ProcurementHub.tsx
last_scanned: 2026-04-23
tags: pos-procurement-hub, pos, procurement, receiving
status: approved
---

# Procurement Hub (pos)

<!-- help:component-source -->
_Linked component: `client/src/components/pos/ProcurementHub.tsx`._
<!-- /help:component-source -->

## What this is

Use **Procurement Hub** in POS mode when staff need a register-friendly way to open purchase orders, direct invoices, and the receiving workflow without leaving the operational shell.

## When to use it

Use this workspace when you need to:

1. Find a purchase order or direct invoice that is ready for action.
2. Open **Receive Stock** from the procurement workflow.
3. Finish a receipt and review retail price tags for the received items.

## Before you start

- Confirm you have the vendor paperwork in hand.
- Use a submitted PO for standard receiving, or a direct invoice when the vendor already shipped and billed the goods.
- If you need shelf tags immediately after receiving, plan to use the built-in **Review price tags** step in Receive Stock.

## Steps

1. Open **Procurement Hub** in POS mode.
2. Find and open the PO or direct invoice you need.
3. Move into **Receive Stock** to stage the quantities that physically arrived.
4. Use **Review price tags** if you need retail price tags for those received items.
5. Print the required tags, then finish the receipt with **Post inventory** when everything matches the paperwork.

## What to watch for

- Receiving and printing tags are related but separate actions. Printing tags does not post inventory.
- The receiving worksheet is the source for prefilled tag quantities.
- Direct invoices and standard POs both flow through Receive Stock for the final receipt step.

## What happens next

- After printing, staff can continue receiving or return to the procurement list.
- After posting inventory, the products become part of live stock and the receiving step is complete.

## Related workflows

- Use **Receive Stock** for the final receipt worksheet and prefilled retail price-tag review.
- Use **Inventory Control Board** or **Product Hub Drawer** when you need to print more floor tags after receiving is complete.
