---
id: pos-register-reports
title: "Register Reports & Daily Sales"
order: 1074
summary: "Daily sales activity timeline, completed-sale voids, tender totals, and professional audit printing for the current register session."
source: client/src/components/pos/RegisterReports.tsx
tags: pos, register, reports, audit, printing
---

# Register Reports (Daily Sales)

## Screenshots

![Reports catalog](../images/help/reports/catalog.png)

![Insights dashboard](../images/help/insights/metabase-main.png)

![Operational home](../images/help/operations-operational-home/main.png)

This screen provides a real-time audit of register activity, daily sales, and shared drawer coordination.

## What this is

Use this screen to review the current register session, void a completed sale with Manager Access when store policy allows it, print the full-page daily report, and verify lane activity before final close.

## How to use it

1. Open **POS → Reports** while the register session is still active.
2. Review **Booked** for what was rung during the drawer/session and **Completed** for recognized revenue and pickup activity.
3. Open individual entries when you need receipt or tender detail. Click the customer name or Customer # to open CustomerHub for that customer.
4. Use **Void** on a completed sale only after a manager confirms the transaction, reason, tender reversal, and inventory impact.
5. Use **Print Report (Full Page)** when the shift needs a professional audit printout.
6. Open **Z-Reports** to see which linked lanes are still open, which drawer is already reconciling, and whether Register #1 still needs to finish the shared close.

## Daily Sales Activity
The **Daily Sales** view shows a chronological timeline of every transaction. Tap an entry to view the full receipt or reprint it. Use this for:
- Verifying the status of recent sales.
- Correcting tender types by reviewing the audit log.
- Monitoring mid-shift velocity without closing the drawer.
- Confirming whether the activity was **Takeaway**, **Pickup**, **Special Order**, **Custom Order**, **Wedding Order**, **Layaway**, or mixed fulfillment.
- Reviewing split tenders as separate payment lines with amount labels instead of a single collapsed method list.

## Void a completed sale

The **Void** action is for manager-approved completed-sale reversals. It does not delete the transaction. ROS keeps the original Transaction Record and writes a permanent void record with the approver, reason, tender summary, refund queue state, and inventory impact.

1. Find the sale in **Daily Sales Activity**.
2. Confirm customer, amount, tender, and timestamp.
3. Tap **Void**.
4. Enter a clear reason.
5. Manager approves with **Manager Access**.
6. Read the completion message:
   - **Refund workflow opened** means the refund still needs to be processed.
   - **No refund balance remains** means there is no remaining paid balance to reverse.

Use the refund workflow to finish cash, card, gift card, store credit, or split-tender reversal work. Do not tell the customer a reversal is complete until the refund state is resolved.

## Professional Audit Printing
You can now generate a professional, full-page **Daily Sales Report** that includes:
- **Tender Breakdown**: Totals for Cash, Card, Gift Card, and R2S charges.
- **Transaction Audit**: A complete list of all ticket numbers and amounts.
- **Activity Cards**: Printed activity mirrors the on-screen grouped list with customer context, fulfillment chips, line items, payment/pickup context, and amount details.
- **Reporting Station**: The report header identifies the assigned printer for accountability.

To print, tap **Print Report (Full Page)**. Daily Sales opens as the formatted full-page report so the activity cards, customer context, pickup rows, line items, and totals stay readable on office paper.

Z-Reports also open the formatted full-page report for close review and printing. **Open Report** shows whether the report opened successfully, so support can tell the difference between a report with no data and a workstation preview/opening failure. If a report prints as raw text instead of the formatted layout, check that the workstation is using the current build and rerun the report print.

## Performance Metrics
The summary cards at the top of the screen provide instant visibility into:
- **Gross Sales**: Total volume before taxes and returns.
- **Tender Totals**: Net collections per payment method.
- **Transaction Count**: Total number of finalized tickets.

## Register Coordination
The **Z-Reports** view now acts as the shared drawer coordination surface.

- **Active Sessions** shows how many register lanes are still open.
- **Open Drawers** counts physical till groups, not individual lanes.
- **Pending Closes** shows drawer groups that are already in reconciliation.
- **Register #1 close anchor** identifies the lane that must finish the single Z-close for that shared drawer.

If a drawer group is already marked **Closing now**, avoid starting a second close from another linked register.

## Tips
- **Decoupled Printing**: Receipts print on receipt paper; Reports print on office paper. Ensure your **Report Printer** is set in **Settings -> Printers & Scanners**.
- **Shared till group**: Reporting on Register #1 includes data aggregated from all satellite lanes (iPad and Back Office).
- **One close per drawer**: Satellite lanes stay visible for coordination, but the final Z-close still happens once from Register #1 for the whole till group.
