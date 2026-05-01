---
id: reports-workspace
title: "Reports Workspace (reports)"
order: 1083
summary: "Find curated store reports by task, question, keyword, audience, or sensitivity."
source: client/src/components/reports/ReportsWorkspace.tsx
last_scanned: 2026-05-01
tags: reports-workspace, reports, search, reporting, staff
status: approved
---

# Reports Workspace (reports)

<!-- help:component-source -->
_Linked component: `client/src/components/reports/ReportsWorkspace.tsx`._
<!-- /help:component-source -->

## What this is

Reports is the Back Office report library. Use it when you need a trusted store report without building a custom Insights question.

## When to use it

Use Reports to find sales, inventory, register, wedding, customer, finance, staff, and operations reports by the task you are trying to finish.

## Before you start

- Sign in to Back Office.
- You need the report's required staff access before its tile appears.
- Admin-only reports stay separated and are visible only to Admin role users.

## Steps

1. Open Back Office -> Reports.
2. Use the search box: "Search reports by task, question, or keyword".
3. Search with plain terms such as pickup, balance, tax, cash, drawer, slow stock, appointments, no-show, or open orders.
4. Choose a report tile.
5. Use From, To, Basis, and Group by when those controls appear.
6. Use Refresh after changing filters.
7. Use CSV or Print Report when the table view supports it.

## What to watch for

- Category labels describe the report area: Sales, Inventory, Register, Weddings, Customers, Finance, Staff, or Operations.
- Audience labels describe the usual reader: Staff, Manager, Owner, or Admin.
- Sensitivity labels describe access expectations: Staff-safe, Manager, or Admin-only.
- Roadmap reports should only appear as planned when they do not have a real backend report yet.

## What happens next

Available reports open a detail view and load current data from Riverside.

## Related workflows

- Reports (curated) staff manual
- Daily Sales Reports
- Booked vs Fulfilled reporting
- Insights / Metabase

## Screenshots

Screenshots should be captured from the live Reports workspace with customer names and financial details redacted.
