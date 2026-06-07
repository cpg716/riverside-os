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

## Screenshots

![Scheduler workspace](../images/help/scheduler-workspace/main.png)

![Operational home](../images/help/operations-operational-home/main.png)

![Alterations workspace](../images/help/alterations-workspace/main.png)

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

1. **Reports**: review earned commission for a selected period. Each staff row has one payroll total that includes base commission plus SPIFF and combo incentive dollars.
2. **SPIFFs & Combos**: manage fixed-dollar SKU SPIFFs and 3- or 4-requirement combo rewards.

## Operational detail

Commission review depends on recognized fulfillment activity and audited adjustment events. Use the reports tab for review, then investigate surprising totals from the related transaction, staff profile, and commission trace. Do not change staff rates to force a one-off correction; use the audited adjustment path when management approves it.


## What To Watch For

- Rate changes start on the selected effective date.
- SPIFFs and combos add to the staff base commission; they do not replace the base rate.
- SPIFF setup is SKU-focused: scan or search each SKU that should earn the fixed add-on.
- Combo rewards are category or product based. Add 3 or 4 requirements, set the quantity needed for each one, and avoid SKU-specific combo setup.
- Wedding transactions are excluded from combo rewards.
- Manual add/subtract adjustments are audited.
- Returns and exchanges affect the period in which they happen through immutable adjustment events.

## What happens next

After reviewing a period, export or print only when the date range, staff member, and recognition basis are correct. If a payout question depends on a return, exchange, or manual adjustment, open the trace before giving a final answer.


## Manager review

Manager review is needed before changing SPIFFs, combo incentives, payout adjustments, or staff commission settings. Commission changes should explain why the adjustment exists, which period it affects, and which transaction or policy decision supports it.


## Related Workflows

- [staff-commission-payouts-panel-manual.md](./staff-commission-payouts-panel-manual.md)
- [settings-staff-profile-panel-manual.md](./settings-staff-profile-panel-manual.md)
