---
id: pos-cart
title: "Cart (pos)"
order: 1050
summary: "Register cart surface for sale lines, customer context, toolbar actions, and safe alteration intake handoff."
source: client/src/components/pos/Cart.tsx
last_scanned: 2026-04-23
tags: pos-cart, component, auto-scaffold
status: draft
---

# Cart (pos)

<!-- help:component-source -->
_Linked component: `client/src/components/pos/Cart.tsx`._
<!-- /help:component-source -->

## What this is

The Register cart is the selling surface for active sale lines, customer context, payment entry, and sale tools. The toolbar includes separate actions for Wedding, Alteration, Exchange, Layaway, Gift Card, Park Sale, Clear Sale, Options, and Orders.

The **Alteration** action starts intake for garment work orders. It does not sell alteration-only items, does not add alteration charges to checkout in this phase, and does not replace the shared Alterations queue.

## When to use it

Use this screen when helping a customer at the Register, adding sale lines, reviewing sale tools, or starting alteration intake tied to a selected customer.

## Before you start

- Confirm the cashier is signed in.
- Select or create the customer before using **Alteration**.
- For alteration-only scanned or past-purchase items, use the Alteration intake modal. Do not add those garments to the sale.

## Steps

1. Add sale lines through product search or scanner when the customer is buying items.
2. Use toolbar actions as separate commands; **Exchange** and **Layaway** are independent actions.
3. To start alteration intake, select the customer, choose **Alteration**, choose the item source, enter work requested, and save.
4. Continue checkout only for actual sale items. Alteration checkout linkage is handled in a later workflow phase.

## What to watch for

- Alteration intake requires a customer.
- Scanned/entered alteration-only items are lookup-only and are not added to the cart.
- Optional alteration charge notes do not create Register charge lines yet.

## What happens next

Sale items remain in the Register cart. Standalone alteration intakes are saved to the shared Alterations queue; current-cart alteration drafts remain attached to the cart for later checkout-linkage work.

## Related workflows

- `docs/staff/pos-alterations.md`
- `docs/staff/pos-register-cart.md`

## Screenshots

Add PNGs under `../images/help/pos-cart/` and replace this example with governed screenshots.

![Example](../images/help/pos-cart/example.png)
