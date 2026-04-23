---
id: staff-commission-payouts-panel
title: "Commission Payouts Panel (staff)"
order: 1104
summary: "Review fulfillment-based commission payouts, filter by staff, run prior-month payroll windows, and finalize only eligible unfinalized lines."
source: client/src/components/staff/CommissionPayoutsPanel.tsx
last_scanned: 2026-04-23
tags: staff-commission-payouts-panel, component, commission, payroll
status: approved
---

# Commission Payouts Panel (staff)

<!-- help:component-source -->
_Linked component: `client/src/components/staff/CommissionPayoutsPanel.tsx`._
<!-- /help:component-source -->

## What this is

Use **Staff → Commissions → Payouts** to review fulfillment-based commission, run a staff report for a selected date window, and finalize realized commission that is ready for payroll.

## Before you start

- You need **insights.view** to read the ledger.
- You need **insights.commission_finalize** to finalize payouts.
- Commission follows the **fulfillment / recognition** date, not the original booking date.

## Steps

1. Open **Staff → Commissions** and stay on **Payouts**.
2. Choose a date window. Use **Prior month payroll** when paying the first paycheck of the new month from the previous month's fulfilled work.
3. Optional: pick a **Staff** member to run a staff-level report even if the summary table is empty.
4. Review **Realized (pending)** for the people or rows you are paying.
5. Select the rows with pending payout, then choose **Finalize payout**.

## What to watch for

- **Unpaid** is pipeline on open lines. It is not ready for payroll.
- **Realized (pending)** is the amount eligible for payout in the recognition window.
- **Paid out** is already finalized and locked.
- If a staff rate changes, Riverside can reconcile eligible unfinalized lines from the chosen effective date.
- If a salesperson changes on an eligible line, Riverside recalculates that line immediately.

## What happens next

After finalize, matching commission lines move from **Realized (pending)** to **Paid out** and are no longer eligible for silent attribution or rate rewrites.

## Related workflows

- Open **Staff → Commissions → Rates** or **Rules & SPIFFs** to manage rates, SPIFF rules, and combo incentives.
- Open the broader Insights / Staff manual for payroll timing and permissions guidance.
