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

![Reports catalog](../images/help/pos-register-reports/workflow-1.png)

![Insights dashboard](../images/help/pos-register-reports/workflow-2.png)

![Operational home](../images/help/pos-register-reports/workflow-3.png)

This screen provides a real-time audit of register activity, daily sales, and shared drawer coordination.

The Register cart keeps non-merchandise work visible: shipping charges and alteration-service charges appear as separate charge rows, and existing order-payment rows remain visible alongside merchandise when a customer is both making a payment and purchasing items. These charges remain separate from merchandise subtotal reporting.

## What this is

Use this screen to review the current register session, void a completed sale with Manager Access when store policy allows it, print the full-page daily report, and verify lane activity before final close.

Daily Sales payment totals use the same store-local effective business-date window as the Z-Report. A payment made on another date toward a sale booked today is shown on that payment's date only, so card, cash, and other tender totals reconcile to the register close. Z-Reports show net Cash, net CC, and net Checks as the primary reconciliation totals. Terminal, CNP, manual-card, and all-card-refund rows are CC detail; Deposit Applied, Exchange Credit, store credit, gift card, RMS, and similar rows are informational activity and are not additive to those primary totals.

## How to use it

1. Open **POS → Reports** while the register session is still active.
2. Review **Booked** for what was rung during the drawer/session and **Completed** for recognized revenue and pickup activity.
   Riverside loads the selected basis first so a slower comparison cannot keep the whole screen waiting. If the comparison misses the 15-second response deadline, the selected basis stays usable and the screen says that the other basis is unavailable; it shows an em dash for unavailable comparison metrics and never substitutes zero totals.
3. Open individual entries when you need receipt or tender detail. Click the customer name or Customer # to open CustomerHub for that customer.
4. Search by customer name, phone, email, Customer #, Transaction number, payment method, item name, or SKU. Search runs against the full selected date range, not only the rows currently visible. Use **Load more audited activity** when the result count is larger than the current page.
5. Use **Void** on a completed sale only after a manager confirms the transaction, reason, tender reversal, and inventory impact.

An active Register can request its own lane-scoped report only with that Register session's matching protected token. Supplying an open session number is not authorization. Store-wide and archived report access requires **register.reports** permission.

Archived Z-report output loads audited detail in timed, cancellable pages. Starting a different archived report cancels the earlier load, and a timeout opens nothing. Z-report history shows up to the newest 40 rows for the selected range; a loading failure is shown as an error with Retry and is never labeled as an empty range.
6. Use **View**, **Print**, or **Export** to prepare the complete matching activity set. Riverside asks the Main Hub for one read-only database snapshot and verifies its counts, row identities, and completion flags before producing output; it never labels an interactive page as a complete report. For stability, the screen stops at 2,000 loaded detail rows and generated output stops at 20,000 combined activity and pickup rows. Narrow the date range or search when ROS reports that limit.
7. Open **Z-Reports** to see which linked lanes are still open, which drawer is already reconciling, and whether Register #1 still needs to finish the shared close.

## Daily Sales Activity
The **Daily Sales** view shows a chronological timeline of every transaction. Each sale row shows its `TXN-` transaction number so the screen, printout, receipt, and payment records can be reconciled against the same reference. Counterpoint-imported rows keep the Counterpoint transaction time as the activity time and show **Imported at** only as secondary import context. Tap an entry to view the full receipt or reprint it. Merchandise **Subtotal** and **Net Sales** exclude shipping, alteration-service charges, and gift-card loads. Daily Sales reports show shipping and alterations as separate totals, and gift-card loads as separate count/amount activity. Gift-card loads are recorded as liability activity until redeemed; redemption is recorded as a tender and does not turn the original load into merchandise revenue. Use this for:
- Verifying the status of recent sales.
- Correcting tender types by reviewing the audit log.
- Monitoring mid-shift velocity without closing the drawer.
- Confirming whether the activity was **Takeaway**, **Pickup**, **Special Order**, **Custom Order**, **Wedding Order**, **Layaway**, or mixed fulfillment.
- Reviewing split tenders as separate payment lines with amount labels instead of a single collapsed method list.

The result line states how many matching activity records and pickups are loaded out of the exact server-reported count. An activity record may be a sale, payment, or another audited event, so it is not labeled as a transaction count. Detail-derived dashboard boxes show an em dash while more source rows remain; this means the value is not yet complete, not zero. Load the remaining activity or use the complete View, Print, or Export output.

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
- **Business Summary Boxes**: New Orders, Orders Picked Up, Credit Card Total, RMS Payments, and RMS Charge appear in the top summary so daily review focuses on register operations. Credit Card Total includes CC/Card Reader, Card Manual, Card Not Present, saved-card, and card refund/credit activity; it does not include Staff Account or exchange credit.
- Administrative Counterpoint price repairs are excluded from Booked Sales; they do not represent new customer transactions or tender collected.
- **Card entry labels**: Hosted HelcimPay.js entries print as **Card Not Present**, while **Card Manual** is reserved for externally recorded/manual card activity.
- **Per-Transaction Subtotal Before Tax**: Each transaction card separates subtotal before tax, tax collected, and total before showing payments or balance.
- **Transaction Audit**: A complete list of all matching `TXN-` transaction numbers, payment-only activity, and amounts. Payment rows without merchandise lines remain present in CSV exports.
- **Truthful filter scope**: When search is active, the printed **Period Summary** is fetched separately and labeled as all activity in the selected period. The transaction and pickup sections state the exact filter, and detail-derived boxes are labeled **Filtered** so they cannot be mistaken for full-period totals.
- **Cents-safe CSV totals**: Export totals are summed as integer cents, including rows whose displayed amount contains a dollar sign or thousands separator.
- **Activity Cards**: Printed activity mirrors the on-screen grouped list with customer context, fulfillment chips, line items, payment/pickup context, and amount details.
- **Reporting Station**: The report header identifies the assigned printer for accountability.

To review the report first, tap **View**. In the desktop app, the preview opens inside ROS instead of a browser tab. To print, tap **Print** from the report screen or from the in-app preview. Daily Sales prints through the configured Reports printer so the activity cards, customer context, pickup rows, line items, and totals stay on office paper instead of the receipt printer.

Z-Reports also use the same contract in the desktop app. Each row and printed report shows its store-local **business date**, which may differ from the morning it was closed. **Open Report** opens the Z-report inside ROS for review, with each sale row labeled by its `TXN-` transaction number. ROS never combines multiple business dates; missed days appear as separate reports and must be closed oldest first. The Z-report quick-look boxes include daily business counts and amounts such as New Vendor Invoices from Back Office receiving, New Orders, Orders Picked Up, Credit Card Total, RMS Payments, RMS Charge, appointments, alterations, new wedding parties, shipping, and discounts. **Close & Print Z-Report** and preview **Print** send the report to the configured Reports printer. If a report prints as raw text instead of the formatted layout, check that the workstation is using the current build and rerun the report print.

After close, Riverside freezes the complete audited activity and pickup set for that business date inside one read-only repeatable-read database snapshot. It never saves the first page as though it were the full EOD snapshot. If every row cannot be verified, the drawer still closes, no partial snapshot is saved, and Riverside raises an operational alert for support follow-up.

Cash refunds processed before close appear as negative cash activity. They reduce Cash Sales (Gross), Expected Cash, and the amount available for deposit; any difference between the resulting expected cash and the physical count remains an over/short variance to explain.

Exchange Credit is reported separately from true card tenders and must never be included in the Credit Card total. When reconciling ROS against another register system, compare card tenders and exchange credits as separate payment methods.

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
- **One report per business date**: Satellite lanes stay visible for coordination. Register #1 closes each waiting date separately, and the final date closes the whole till group.
