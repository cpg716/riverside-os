---
id: alterations-workspace
title: "Alterations Workspace (alterations)"
order: 1000
summary: "Standalone alterations queue for customer-linked tailoring intake, due dates, notes, and status movement."
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

The Alterations workspace is a standalone tailoring work queue shared by Back Office and POS. It tracks customer, target due date, notes, and status.

It does not create Register cart lines, collect payment, print tickets/barcodes, or automatically link a job to a transaction line.

## When to use it

Use it to intake a tailoring job, review active work, move work from **Intake** to **In Work**, mark work **Ready**, or close it as **Picked Up**.

## Before you start

- Confirm you have **alterations.manage**.
- Confirm the customer exists in Riverside OS.
- Confirm any price, rush fee, or payment handling outside this queue.

## Steps

1. Open **Alterations**.
2. Use **All**, **Intake**, **In Work**, **Ready**, or **Picked Up** to filter the queue.
3. For a new job, select the customer, add a target due date if known, enter notes, and create the job.
4. For an existing job, change status only when the physical work actually moved.

## What to watch for

- Marking a job **Ready** may notify the customer.
- This queue does not replace Register payment or transaction handling.
- Keep notes operational and customer-safe.

## What happens next

The queue refreshes and the job remains visible under the matching status filter.

## Related workflows

- `docs/staff/alterations-back-office.md`
- `docs/staff/pos-alterations.md`

## Screenshots

Screenshots are not currently embedded for this workflow.
