---
id: staff-commission-manager-workspace
title: "Commission Manager Workspace (staff)"
order: 1110
summary: "Use Staff → Commissions as the single workspace for commission payouts, category rates, and SPIFF or combo incentive rules."
source: client/src/components/staff/CommissionManagerWorkspace.tsx
last_scanned: 2026-04-23
tags: staff-commission-manager-workspace, component, commission, payroll, rates
status: approved
---

# Commission Manager Workspace (staff)

<!-- help:component-source -->
_Linked component: `client/src/components/staff/CommissionManagerWorkspace.tsx`._
<!-- /help:component-source -->

## What this is

Use **Staff → Commissions** as the single hub for commission work. This workspace combines payroll review, category commission rates, and SPIFF or combo incentive rules in one place so managers do not need to bounce between separate Staff sections.

## Before you start

- **Payouts** requires **insights.view** and **insights.commission_finalize**.
- **Rates** and **Rules & SPIFFs** require **staff.manage_commission**.
- Commission follows the **fulfillment / recognition** date, not the original booking date.

## Tabs

1. **Payouts**: review realized commission, filter by date or staff member, and finalize eligible payout rows.
2. **Rates**: manage category-level override percentages for commission-eligible sales.
3. **Rules & SPIFFs**: manage fixed-dollar SPIFF rules and combo rewards.

## What to watch for

- Finalized payouts stay locked.
- Rate changes can reconcile eligible unfinalized lines only from the chosen effective date.
- Sales Support continues to earn no commission unless store policy and code change separately.

## Related workflows

- [staff-commission-payouts-panel-manual.md](./staff-commission-payouts-panel-manual.md)
- [settings-staff-profile-panel-manual.md](./settings-staff-profile-panel-manual.md)
