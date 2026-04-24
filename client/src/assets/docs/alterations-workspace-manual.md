---
id: alterations-workspace
title: "Alterations Workspace (alterations)"
order: 1000
summary: "Garment-based alterations workbench for source labels, work requested, optional charge notes, due-date attention, and status movement after Register intake."
source: client/src/components/alterations/AlterationsWorkspace.tsx
last_scanned: 2026-04-23
tags: alterations-workspace, component, auto-scaffold
status: approved
---

# Alterations Workspace (alterations)

<!-- help:component-source -->
_Linked component: `client/src/components/alterations/AlterationsWorkspace.tsx`._
<!-- /help:component-source -->

## What this is

The Alterations workspace is a garment-based tailoring workbench shared by Back Office and POS. It tracks customer, item being altered, source label, work requested, optional charge note, target due date, notes, and status after alteration intake is created from the Register.

It groups work into **Overdue**, **Due Today**, **Ready for Pickup**, **Intake / Not Started**, and **In Work**. Existing order details appear only as source context when the garment came from a transaction line.

It does not create new alteration jobs, create Register cart lines, collect payment, print tickets/barcodes, or act as an orders dashboard.

## When to use it

Use it to review active garment work by due/status/source, move work from **Intake** to **In Work**, mark work **Ready**, or close it as **Picked Up**.

## Before you start

- Confirm you have **alterations.manage**.
- Start alteration intake from the Register.
- Confirm any actual price, rush fee, or payment handling outside this queue.

## Steps

1. Open **Alterations**.
2. Use due filters, source filters, or status filters to narrow the garment workbench.
3. For an existing job, read the customer, garment, source label, work requested, due date, and charge note.
4. Change status only when the physical work actually moved.

## What to watch for

- Marking a job **Ready** may notify the customer.
- Source labels are **Current sale**, **Stock/catalog item**, **Existing order**, **Past purchase**, and **Custom/manual item**.
- This queue can record an optional charge note, but it does not replace Register payment or transaction handling.
- Keep notes operational and customer-safe.

## What happens next

The queue refreshes and the job remains visible under the matching status filter.

## Related workflows

- `docs/staff/alterations-back-office.md`
- `docs/staff/pos-alterations.md`

## Screenshots

Screenshots are not currently embedded for this workflow.
