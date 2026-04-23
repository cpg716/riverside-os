---
id: customers-customer-relationship-hub-drawer
title: "Customer Relationship Hub"
order: 1004
summary: "Review customer history, profile details, messages, measurements, orders, shipments, and weddings without mixing in RMS support actions."
source: client/src/components/customers/CustomerRelationshipHubDrawer.tsx
last_scanned: 2026-04-21
tags: customers, relationship-hub, support, profile
---

# Customer Relationship Hub

<!-- help:component-source -->
_Linked component: `client/src/components/customers/CustomerRelationshipHubDrawer.tsx`._
<!-- /help:component-source -->

## What this is

This drawer is the main customer review surface in Back Office and mirrored POS workflows.

Use it when staff need to understand the customer as a person and account holder:

- profile and contact details
- timeline notes and customer history
- wedding linkage
- orders and transactions
- shipments
- measurements
- message history

This drawer is not the place to work RMS exceptions or reconciliation. Use `RMS Charge` for financing-account operations.

## Tabs and what they mean

- `Profile`
  Contact details, opt-ins, VIP status, joint account linkage, and customer notes.
- `Messages`
  Podium thread review and message follow-up when configured.
- `Transactions`
  Sale history for the customer.
- `Orders`
  Order-linked history and order follow-up entry points.
- `Shipments`
  Shipment status and shipment drill-in for this customer.
- `Measurements`
  Stored measurement records and fitting details.
- `Weddings`
  Wedding party linkage and wedding-related shortcuts.

## What the summary area tells you

At the top of the drawer, staff may see:

- lifecycle state
- VIP status
- loyalty points
- balance due
- store credit
- open deposit balance
- active wedding linkage
- lifetime sales
- profile completeness
- last visit timing

These are customer-review signals. They help staff understand the account quickly before taking the next action.

Lifecycle is derived from the customer's current order, shipment, wedding, and activity signals already in RiversideOS. It is meant to answer the simple question: what stage is this customer in right now?

## How to use it

1. Open the customer record and confirm you have the correct person before editing anything.
2. Review the summary area first to understand open balances, loyalty status, and recent activity.
3. Move into the tab that matches the task, such as profile cleanup, shipments, measurements, or wedding linkage.
4. Leave the drawer only when the task clearly belongs in a different workflow like RMS Charge or a full order follow-up.

## When to stay here versus move to RMS Charge

Stay in the relationship hub when you need to:

- confirm who the customer is
- review account history
- look at orders, shipments, or weddings
- update profile details
- review notes or communication history

Move to `RMS Charge` when you need to:

- confirm a linked RMS account
- review RMS purchase or payment posting
- link or unlink RMS accounts
- work RMS exceptions
- review RMS reconciliation

## Tips

- Start by confirming the customer record first.
- Use the customer hub to understand the full account before changing anything.
- If the issue is specifically about financing account behavior, switch to `RMS Charge` instead of trying to solve it here.
