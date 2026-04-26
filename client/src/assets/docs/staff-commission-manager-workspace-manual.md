---
id: staff-commission-manager-workspace
title: "Commission Manager Workspace (staff)"
order: 1110
summary: "Use Staff → Commissions for commission reports, fixed SPIFFs, and combo incentives."
source: client/src/components/staff/CommissionManagerWorkspace.tsx
last_scanned: 2026-04-25
tags: staff-commission-manager-workspace, component, commission, reporting, incentives
status: approved
---

# Commission Manager Workspace (staff)

<!-- help:component-source -->
_Linked component: `client/src/components/staff/CommissionManagerWorkspace.tsx`._
<!-- /help:component-source -->

## What This Is

Use **Staff → Commissions** for reporting and incentives.

The workspace is intentionally simple:

- **Reports** shows all-staff and individual staff commission reporting by period.
- **SPIFFs & Combos** manages fixed-dollar incentive add-ons.

Category commission rate overrides and percentage override rules are retired from the staff-facing workflow.

## Before You Start

- **Reports** requires **insights.view**.
- **SPIFFs & Combos** requires **staff.manage_commission**.
- Staff base commission rates are set on each Staff Profile.
- Commission follows the fulfillment / recognition date, not the booking date.

## Tabs

1. **Reports**: review booked pipeline and earned commission for a selected period.
2. **SPIFFs & Combos**: manage fixed-dollar SPIFFs and combo rewards.

## What To Watch For

- Rate changes start on the selected effective date.
- SPIFFs and combos add to the staff base commission; they do not replace the base rate.
- Manual add/subtract adjustments are audited.
- Returns and exchanges affect the period in which they happen through immutable adjustment events.

## Related Workflows

- [staff-commission-payouts-panel-manual.md](./staff-commission-payouts-panel-manual.md)
- [settings-staff-profile-panel-manual.md](./settings-staff-profile-panel-manual.md)
