---
id: operations-operational-home
title: "Operations Home"
order: 1047
summary: "Store-wide command center for daily changes, source-linked timeline planning, attention items, register status, till control, and optional daily briefing."
source: client/src/components/operations/OperationalHome.tsx
last_scanned: 2026-05-10
tags: operations, dashboard, timeline, calendar, action-board, triage, weddings, alterations
status: approved
---

# Operations Home

## Screenshots

![Operational home](../images/help/operations-operational-home/main.png)

![Reports catalog](../images/help/reports/catalog.png)

![Orders workspace](../images/help/orders-workspace/main.png)

## What this is

Operations Home is the staff command center for the day. It keeps deterministic operational facts first: what changed, what needs attention, whether registers are open, till control state, and where staff should go next.

## How to use it

1. Review the top KPI strip for sales, register status, pickup, alterations, inventory, and attention pressure.
2. Review **What Changed Today** for movement since the last shift.
3. Review **What Needs Attention** for blockers and warnings.
4. Follow the card or row into the owning workflow before taking action.
5. Use Daily Operational Briefing only after the deterministic cards are understood.

## Operational Timeline

Open **Operations → Timeline** when the manager needs the planning view instead of the summary dashboard. Timeline combines existing source workflows into one visual surface: appointments, wedding readiness, pickup commitments, alteration due dates, tasks, receiving commitments, physical inventory sessions, QBO review, register close work, and open alerts.

Use **Agenda** for what is next, **Week** for staffing and workload planning, **Month** for deadline pressure, and **Workload** for where pressure is coming from. Filters isolate Today, Overdue, Manager, Appointments, Weddings, Pickups, Alterations, Tasks, QBO, Receiving, Inventory, and Alerts.

Timeline rows are not editable. Open the row and make changes in the source workflow so the scheduler, Wedding Manager, Pickup Queue, Alterations, Tasks, QBO, Inventory, and Notifications remain the source of truth.

## Customer Notifications

Open **Operations → Customer Notifications** to review automated customer messages. This includes ready-for-pickup, alteration-ready, appointment confirmation, appointment reminder, receipt, unknown-sender welcome, and review-invite messages.

Use this center for automated-message delivery and staff review only. It does not show regular staff-written Podium texts or regular staff-written emails, and it does not mark an order picked up, mark an alteration picked up, collect payment, or change customer communication preferences.

Use the full-width search row to find a customer, message type, status, delivery method, or delivery error. Use the status chips and **Reviewed archive** filter below search to separate active rows from reviewed history.

## What to check first

Start with the KPI strip, then **What Changed Today** and **What Needs Attention**. These cards show current operational signals such as movement, register status, till control, blockers, warnings, weddings, alterations, pickups, and inventory work.

Successful **no issues** states are different from failed feeds. If a feed cannot load, Operations Home shows a quiet degraded indicator instead of looking calm or empty.

## Daily Operational Briefing

Daily Operational Briefing is optional. It appears below deterministic operational content and should explain the facts already on the screen.

If ROSIE is slow or unavailable, the briefing request times out or falls back quietly. Staff should keep using the deterministic cards and workflow links.

## Degraded feeds

A degraded indicator means that one part of the dashboard could not refresh. Use the visible cards that did load, then retry or report the degraded feed if it affects the shift.

Do not assume the store has no blockers just because a degraded feed is quiet.

## Operational detail

Operations Home is the daily command surface. Use it to decide what needs attention first, then open the underlying workspace for the actual action. Treat cards and queues as summaries: if a count or row looks surprising, drill into the source record before making a customer promise, register close, inventory, or manager decision.


## What to watch for

- Use blockers before warnings.
- Follow the card action links instead of searching manually when a next action is shown.
- Treat ROSIE as an explanation layer, not the source of sign-off.

## Related workflows

- [Inventory Control Board](manual:inventory-control-board)
- [Customer Relationship Hub](manual:customers-customer-relationship-hub-drawer)
