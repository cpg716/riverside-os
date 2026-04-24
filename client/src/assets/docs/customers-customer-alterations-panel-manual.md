---
id: customers-customer-alterations-panel
title: "Customer Alterations Panel (customers)"
order: 1002
summary: "Shared alterations queue panel for standalone tailoring intake, due dates, notes, and status movement."
source: client/src/components/customers/CustomerAlterationsPanel.tsx
last_scanned: 2026-04-23
tags: customers-customer-alterations-panel, component, auto-scaffold
status: approved
---

# Customer Alterations Panel (customers)

<!-- help:component-source -->
_Linked component: `client/src/components/customers/CustomerAlterationsPanel.tsx`._
<!-- /help:component-source -->

## What this is

This panel powers the shared Alterations queue in Back Office and POS. It is a standalone tailoring tracker for customer, due date, notes, and status.

It does not add alteration charges to the Register cart, print tickets/barcodes, or link jobs to SKU/order-line revenue.

## When to use it

Use it when staff need to create a standalone alteration job or move a job through **Intake**, **In Work**, **Ready**, and **Picked Up**.

## Before you start

- Confirm the staff member has **alterations.manage**.
- Confirm the customer record exists.
- Confirm any pricing/payment questions outside this queue.

## Steps

1. Select the relevant filter: **All**, **Intake**, **In Work**, **Ready**, or **Picked Up**.
2. To create a job, select a customer, enter a due date if known, add job notes, and create the standalone job.
3. To update a job, press the matching status button.
4. Confirm the success toast and refreshed queue.

## What to watch for

- Marking a job **Ready** may send the configured alteration-ready customer message.
- Status changes are audit-tracked.
- This panel is not a Register checkout/payment surface.

## What happens next

The job appears in the queue under its current status.

## Related workflows

- `docs/staff/alterations-back-office.md`
- `docs/staff/pos-alterations.md`

## Screenshots

Screenshots are not currently embedded for this workflow.
