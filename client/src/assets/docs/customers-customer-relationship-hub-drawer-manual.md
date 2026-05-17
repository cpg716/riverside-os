---
id: customers-customer-relationship-hub-drawer
title: "Customer Relationship Hub"
order: 1004
summary: "Review customer profile, snapshot, orders, alterations, loyalty, messages, measurements, and timeline."
source: client/src/components/customers/CustomerRelationshipHubDrawer.tsx
last_scanned: 2026-05-10
tags: customers, relationship-hub, support, profile
status: approved
---

# Customer Relationship Hub

## Screenshots

![Customers workspace](../images/help/customers-workspace/main.png)

![Orders workspace](../images/help/orders-workspace/main.png)

![Wedding lookup drawer](../images/help/pos/wedding-lookup-drawer.png)

## What this is

Customer Relationship Hub is the drawer for one customer. It brings profile facts, customer snapshot, transactions, alterations, loyalty, messages, measurements, and timeline context into one place.

Deterministic customer facts stay primary. Optional ROSIE customer snapshot insight appears after the visible profile and snapshot facts.

## How to use it

1. Confirm the customer name and contact details.
2. Review Customer Snapshot and profile facts.
3. Open the needed tab for orders, alterations, loyalty, messages, measurements, or timeline.
4. Treat degraded section messages as missing data until that section reloads.

## Customer Snapshot

Customer Snapshot summarizes current customer context, recent activity, important relationship details, and next steps. Use it to orient yourself before opening deeper tabs.

## Tabs and sub-sections

Each sub-section distinguishes:

- **Loading:** the customer data is still being fetched.
- **Failed sub-load:** that section could not load and shows a quiet degraded message.
- **Successful empty:** the section loaded and has no matching records.

This applies to transaction or order history, alterations, loyalty activity, messages, measurements, and timeline.

## Working with degraded sections

If one section is degraded, use the sections that are still loaded. Do not assume there are no orders, messages, measurements, or loyalty events when the section says it could not load.

Retry or reopen the drawer if the missing section matters before helping the customer.

## ROSIE customer insight

ROSIE insight is optional and secondary. It should explain visible customer facts and should not replace staff review of the profile, tabs, and customer history.

If ROSIE is unavailable, the hub remains usable.

## What to watch for

- Confirm the customer name and contact details before taking action.
- Keep private notes and sensitive customer information out of screenshots or bug reports unless support specifically needs them.
- Use the visible transaction and alteration records as the source of truth.

## Related workflows

- [Customers Workspace](manual:customers-workspace)
- [Orders Workspace](manual:orders-workspace)
