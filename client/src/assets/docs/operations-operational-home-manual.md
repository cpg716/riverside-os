---
id: operations-operational-home
title: "Operations Home"
order: 1047
summary: "Store-wide action board for daily changes, attention items, degraded feeds, and optional daily briefing."
source: client/src/components/operations/OperationalHome.tsx
last_scanned: 2026-05-10
tags: operations, dashboard, action-board, triage, weddings, alterations
status: approved
---

# Operations Home

## Screenshots

![Operational home](../images/help/operations-operational-home/main.png)

![Reports catalog](../images/help/reports/catalog.png)

![Orders workspace](../images/help/orders-workspace/main.png)

## What this is

Operations Home is the staff action board for the day. It keeps deterministic operational facts first: what changed, what needs attention, and where staff should go next.

## How to use it

1. Review **What Changed Today** for movement since the last shift.
2. Review **What Needs Attention** for blockers and warnings.
3. Follow the visible action links into the owning workflow.
4. Use Daily Operational Briefing only after the deterministic cards are understood.

## What to check first

Start with **What Changed Today** and **What Needs Attention**. These cards show current operational signals such as movement, blockers, warnings, weddings, alterations, pickups, and inventory work.

Successful **no issues** states are different from failed feeds. If a feed cannot load, Operations Home shows a quiet degraded indicator instead of looking calm or empty.

## Daily Operational Briefing

Daily Operational Briefing is optional. It appears below deterministic operational content and should explain the facts already on the screen.

If ROSIE is slow or unavailable, the briefing request times out or falls back quietly. Staff should keep using the deterministic cards and workflow links.

## Degraded feeds

A degraded indicator means that one part of the dashboard could not refresh. Use the visible cards that did load, then retry or report the degraded feed if it affects the shift.

Do not assume the store has no blockers just because a degraded feed is quiet.

## Operational detail

Operations Home is the daily command surface. Use it to decide what needs attention first, then open the underlying workspace for the actual action. Treat cards and queues as summaries: if a count or row looks surprising, drill into the source record before making a customer promise or manager decision.


## What to watch for

- Use blockers before warnings.
- Follow the card action links instead of searching manually when a next action is shown.
- Treat ROSIE as an explanation layer, not the source of sign-off.

## Related workflows

- [Inventory Control Board](manual:inventory-control-board)
- [Customer Relationship Hub](manual:customers-customer-relationship-hub-drawer)
