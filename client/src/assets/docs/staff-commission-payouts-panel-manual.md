---
id: staff-commission-payouts-panel
title: "Commission Reports Panel (staff)"
order: 1104
summary: "Review fulfillment-based commission reporting by staff and period."
source: client/src/components/staff/CommissionPayoutsPanel.tsx
last_scanned: 2026-04-25
tags: staff-commission-payouts-panel, component, commission, reporting
status: approved
---

# Commission Reports Panel (staff)

<!-- help:component-source -->
_Linked component: `client/src/components/staff/CommissionPayoutsPanel.tsx`._
<!-- /help:component-source -->

## What This Is

Use **Staff → Commissions → Reports** to review commission activity by period.

The screen supports all-staff reporting and individual staff drilldown. It is reporting-only; payout finalization controls have been retired from the visible workflow.

## Before You Start

- You need **insights.view** to read commission reports.
- Commission follows the **fulfillment / recognition** date, not the original booking date.
- Staff base rates are managed on the Staff Profile.
- Fixed SPIFF and combo incentives are managed under **SPIFFs & Combos**.

## Steps

1. Open **Staff → Commissions** and stay on **Reports**.
2. Choose a date window. Use **Prior month payroll** when reviewing the previous calendar month for the first payday of the new month.
3. Optional: pick a **Staff** member to run an individual report.
4. Expand a staff row to review line-level detail.
5. Use **Trace** on a line when you need the calculation explainer.

## What To Watch For

- **Booked not fulfilled** is pipeline. It is not earned commission yet.
- **Earned in period** is commission earned in the selected recognition window.
- Returns and exchanges affect the period in which they occur through immutable adjustment events.
- Manual add/subtract adjustments require notes and audit tracking.

## What Happens Next

Use the report totals for owner/accounting review. If the numbers do not match store expectations, review the expanded staff lines and Trace details before making any payroll decision.

## Related Workflows

- Open **Staff → Staff Profile** to change a staff member's base commission rate with an effective date.
- Open **Staff → Commissions → SPIFFs & Combos** to manage fixed incentive add-ons.
