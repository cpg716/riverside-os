---
id: qbo-workspace
title: "QBO Workspace (qbo)"
order: 1082
summary: "Central hub for QuickBooks Online integration: credentials, staging queue, and journal synchronization."
source: client/src/components/qbo/QboWorkspace.tsx
last_scanned: 2026-04-11
tags: qbo, quickbooks, accounting, journal, staging, finance
---

# QBO Workspace (qbo)

<!-- help:component-source -->
_Linked component: `client/src/components/qbo/QboWorkspace.tsx`._
<!-- /help:component-source -->

The **QBO Bridge** is the financial gateway between Riverside OS sales data and your QuickBooks Online general ledger. It uses a "Staging & Approval" workflow to ensure data integrity before any entries are synced to your live books.

## Workflow overview

The standard operational rhythm follows three steps:
1. **Connection**: Ensure your OAuth token is active and valid.
2. **Mappings**: Define which Riverside accounts (Tenders, Categories, Fees) map to which QBO Chart of Account IDs.
3. **Staging**: Propose a daily journal, review the lines, and sync to QBO.

## How to use it

### 1. Connection tab
- **Authorization**: If the status shows "inactive," you must re-authorize Riverside to access your QBO company.
- **Environment**: Set this to "Production" for live syncing or "Sandbox" for testing.

### 2. Staging & History tab
This is where the daily work happens.
1. **Pick a Date**: Select the business day you want to summarize (usually yesterday).
2. **Propose Journal**: ROS will scan all transactions for that date and build a balanced journal entry.
3. **Review Lines**: Click any journal line to see the "Drill-down" — this shows exactly which orders or inventory moves contributed to that dollar amount.
4. **Approve & Sync**: Once reviewed, mark the row as **Approved**. Only approved rows can be **Synced** to QuickBooks.

## Critical reconciliation patterns

### Stripe Clearing Account
For Stripe transactions, ROS posts a **Clearing Account pattern**. This means the Gross amount is debited to a clearing account, and Fees are recorded separately. This allows you to match bundled bank deposits by "transferring" the net value from the clearing account to your checking account.

### Variance Reporting
If a proposed journal does not balance (Debits ≠ Credits), it will be flagged as "Faulty." This usually indicates a missing account mapping or a corrupted transaction.

## Tips

- **Audit Log**: The "Access Log" at the bottom of the page tracks which staff members proposed, approved, or synced journals to ensure accountability.
- **Refresh Cache**: If you added a new account in QuickBooks, use the "Refresh QBO Accounts" button in the Mappings tab to pull the new ID into Riverside.
