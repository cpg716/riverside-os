---
id: operations-operational-home
title: "Operations Home"
order: 1047
summary: "Use Operations for the store dashboard, alterations snapshot, daily sales, pickup queue, Podium inbox, and review tracking."
source: client/src/components/operations/OperationalHome.tsx
last_scanned: 2026-04-22
tags: operations, dashboard, daily-sales, pickup-queue, podium-inbox, reviews
---

# Operations Home

<!-- help:component-source -->
_Linked component: `client/src/components/operations/OperationalHome.tsx`._
<!-- /help:component-source -->

## What this is

Operations is the Back Office triage area for live store work. It is not the same thing as the Orders workspace.

Use it for:

- **Dashboard**: store-wide action board, alterations snapshot, activity, weather, and team context
- **Daily Sales**: register totals and daily reporting
- **Pickup Queue**: priority order follow-up for ready, rush, due-soon, and blocked orders
- **Podium Inbox**: shared SMS and email thread list
- **Reviews**: review invite tracking

## How to use it

1. Open **Operations** from the Back Office sidebar.
2. Pick the subsection that matches the job:
   - **Dashboard** for triage
   - **Daily Sales** for register/day reporting
   - **Pickup Queue** for order pickup follow-up
   - **Podium Inbox** for customer communications
   - **Reviews** for post-sale reputation follow-up

On the main dashboard, start with:

- **What Changed Today** for booked sales, pickups, online orders, appointments, new wedding activity, and the short plain-language movement summary under those counts
- **What Needs Attention** for the shortest list of problems that already need a decision
- **Top Issues** for the operator-readable meaning of the queue, inventory, and inbox load
- **Alterations** for overdue, due-today, ready pickup, and total open garment work created from Register intake

## Tips

- **Orders** is still the full transaction and order workspace. Use **Pickup Queue** to decide what needs attention first, then open the order record to finish the work.
- **Alterations** on Operations is only a snapshot. Use the Alterations Hub for full workbench filtering, search, and status movement.
- **Podium Inbox** is a communications surface, not a general task inbox.
- If a subsection is missing, check permissions before assuming the feature is broken.
- The dashboard is meant to answer "what changed" and "what matters" quickly. If you need the full ledger or transaction detail, jump from Operations into the dedicated workspace instead of treating the overview as the full report.
