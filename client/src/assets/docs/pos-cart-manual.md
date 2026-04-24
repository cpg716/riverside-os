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

The **Alteration** action starts intake for garment work orders. Every Register alteration creates an editable **Alteration** cart line. Free/included alterations show **$0.00**; charged alterations show the entered service amount. Alteration-only scanned, past-purchase, or custom items are tracked as sources and are not sold again.

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
4. Review the alteration cart line. Use **Edit** on that line to change work requested, source details, due date, notes, or charge amount before checkout.

## What to watch for

- Alteration intake requires a customer.
- Scanned/entered alteration-only items are lookup-only and are not added to the cart.
- Every alteration cart line must match its intake before checkout can complete.
- Charged alteration lines are service lines, not merchandise lines.

## What happens next

Sale items remain in the Register cart. Register alteration drafts stay attached to their alteration cart line and become linked alteration work orders when checkout succeeds. Removing an alteration line removes its pending intake.

## Related workflows

- `docs/staff/pos-alterations.md`
- `docs/staff/pos-register-cart.md`

## Screenshots

Add PNGs under `../images/help/pos-cart/` and replace this example with governed screenshots.

![Example](../images/help/pos-cart/example.png)
