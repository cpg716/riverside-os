---
id: customers-customer-alterations-panel
title: "Customer Alterations Panel (customers)"
order: 1002
summary: "Shared garment-based alterations workbench with summary cards, search, source labels, optional charge notes, due dates, and status movement after Register intake."
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

This panel powers the shared Alterations queue in Back Office and POS. It is a garment-based tailoring workbench for customer, item/source details, work requested, optional charge note, due date, notes, and status.

The top cards show **Overdue**, **Due Today**, **Ready for Pickup**, and **Total Open**. Search can narrow the workbench by customer, garment, work requested, SKU, alteration ID, or source transaction.

It does not create new alteration jobs, add alteration charges to the Register cart, print tickets/barcodes, or act as an orders dashboard. New alteration intake starts from the Register.

## When to use it

Use it when staff need to review garment work by due/status/source, search for a garment, or move a job through **Intake**, **In Work**, **Ready**, and **Picked Up**.

## Before you start

- Confirm the staff member has **alterations.manage**.
- Start new alteration intake from the Register.
- Confirm any actual pricing/payment questions outside this queue.

## Steps

1. Select a summary card or use search, due, source, or status filters.
2. Review the customer, garment, source label, work requested, due date, and optional charge note.
3. To update a job, press the matching status button.
4. Confirm the success toast and refreshed queue.

## What to watch for

- Marking a job **Ready** may send the configured alteration-ready customer message.
- Status changes are audit-tracked.
- This panel can record whether a charge was noted, but it is not a Register checkout/payment surface.

## What happens next

The job appears in the queue under its current status.

## Related workflows

- `docs/staff/alterations-back-office.md`
- `docs/staff/pos-alterations.md`

## Screenshots

Screenshots are not currently embedded for this workflow.
