---
id: pos-close-register-modal
title: "Closing the Register (Z-Report)"
order: 1051
summary: "Reconciling your daily shift, counting cash, and generating the professional Z-Audit report."
source: client/src/components/pos/CloseRegisterModal.tsx
tags: pos, register, closing, Z-report, audit
---

# Z-Reconciliation & Closing

## Screenshots

![Register dashboard](../images/help/pos-close-register-modal/workflow-1.png)

![Cart with lines](../images/help/pos-close-register-modal/workflow-2.png)

![Checkout drawer](../images/help/pos-close-register-modal/workflow-3.png)

The **Close Register** workspace is the final step of a shift. It reconciles expected totals against actual physical counts.

## What this is

Use this workflow to close the live till group, reconcile tender totals, and produce the final Z-audit output for the shift.

## Till Group Closing
Riverside OS uses a **lane-aggregated model**. Opening **Register #1 (Main)** automatically opens satellite lanes (iPad and Back Office). 
- To close the entire group, you **MUST** use the **Close Register** action on **Register #1**.
- Opening Register #1 fixes the store-local **business date** for that entire open period. Closing Register #1 reconciles all satellite lanes and produces one Z-Report for that open period.
- If yesterday's Register was left open, close it the following morning before opening a new period. Its Z-Report remains dated yesterday. Afterward, opening Register #1 creates today's period, and today's Z-Report contains today's register activity.

## The Reconciliation Flow
1. **Cash**: Count bills and coins by denomination, or enter one drawer total.
2. **Checks**: Confirm every check number and amount.
3. **Z-Report**: Review totals, confirm the Daily Cash Deposit date and amount, add required notes, then tap **Close & Print Z-Report**.

Cash count, check review, the Daily Cash Deposit date, and a note for a cash discrepancy over $5 remain required close inputs. Recovery and card-review items stay visible and repairable. When any remain, **Close & Print Z-Report** opens the dedicated **Close Register With Unresolved Issues** Manager Access approval before closing.

The Z-Report page shows the exact **business date** assigned when Register #1 opened. Closing on the following morning does not rename the report. The report separately records when the open period started, when it closed, and when the report was printed, so a late close remains auditable without changing its business date.

Cash refunds processed before close are recorded as negative cash activity and reduce **Cash Sales (Gross)**, **Expected Cash**, and the amount available for deposit. If the physical count differs after a refund, the Z-Report must show the resulting over/short instead of remaining balanced.

If a card terminal outcome needs review, use **Review** in the closing workflow or **POS → Payments** to record the outcome when possible. An unresolved card issue remains visible and is captured under **Unresolved Issues at Close**; it does not block the authorized close action.

If **Checkout recovery** appears, Riverside OS has durable work that needs review: an offline sale waiting to sync, an online checkout whose server result was not confirmed, a paid pickup follow-up, an exchange replacement waiting for its return settlement, or a receipt retry. Register #1 asks every linked workstation to acknowledge its local checkout queue after reconciliation begins. The close panel reports local, Main Hub, and linked-workstation evidence separately; it never treats a missing acknowledgement as an empty queue or hides it, but that warning does not prevent an authorized close.

Use **Attempt Exact Replay** for saved offline or unconfirmed checkout payloads only when the saved payment target is still open. The manager enters an identity, Access PIN, and a reason of at least 12 characters. Riverside replays the original Register session, checkout identity, full sale snapshot, and payment fingerprint. An altered payload, a checkout identity from another session, or an order-payment target that is no longer open is rejected instead of creating a second Transaction Record.

If the paid Transaction Record already exists but its **Unconfirmed checkout** recovery remains open, use **Match Existing Paid Transaction** on that exact item instead of replaying the sale. Enter the completed `TXN-######`, Helcim provider transaction, and a specific Manager reason, then complete Manager Access. Riverside verifies the original checkout, customer, amount, currency, Register session, final provider status, payment allocation, and immutable fingerprints before closing only the recovery record. It creates no sale, charge, refund, payment, or payment movement; any mismatch leaves the item visible for investigation.

For a paid order follow-up, complete every named shipping, pickup, or alteration step in **Orders** or **Alterations** first. Then select **Verify completed follow-up** and complete Manager Access. Riverside checks the recorded Transaction Record, line, shipment, pickup, and alteration evidence before resolving the recovery record. The approval does not perform missing work or treat it as complete.

Use **Complete Exchange Settlement** for a saved exchange replacement whose original return settlement did not finish. This requires Manager Access, a reason of at least 12 characters, and the currently authenticated Register session. Riverside locks the exact Main Hub recovery record, derives all amounts and return details from its saved server snapshot, verifies the replacement checkout identity and the original exchange-credit tender against the origin Register session, then records any new relief or refund movement in the current Register session. It refreshes the reconciliation totals after completion. If a linked provider card refund was intentionally deferred, the close panel keeps its exact remaining amount visible and directs staff to finish it from the original Transaction Record; it does not claim that provider refund completed. A legacy or altered record without complete server provenance remains visible and is rejected instead of moving money.

If recovery work remains after staff review, use **Close & Print Z-Report**, then approve **Close Register With Unresolved Issues** with Manager Access. This approval only authorizes the close: it never replays a checkout, creates a sale, attaches a payment, or dismisses an issue. Riverside captures the exact issues visible immediately before close under **Unresolved Issues at Close** and uses the same Main Hub-frozen tender reconciliation for the immediate and archived Z-Report.

Every completed Z-Report includes the **Quick Look** totals. Before committing the close, the Main Hub builds and verifies the complete booked-day summary inside one read-only database snapshot and includes those totals in the immutable close response. If the complete totals cannot be finalized, Riverside leaves the Register open and shows an error instead of printing or archiving a partial Z-Report. A recovered sale posted later remains tied to the original Register session and is recorded as post-close recovery when applicable.

The separate **Prior or other till-group recovery** panel uses Staff Access with **Register Reports** permission to find open recovery outside the till group being closed. Those records are informational for the current Z-close and never affect current close availability. Saved checkouts can be replayed with Manager Access and remain tied to their original Register session. Exchange settlement records use the Manager completion workflow above and post new ledger movements only to the current Register session. Paid follow-up records use evidence verification. Receipt-print records are informational and must be handled through Print Recovery; they are never treated as missing sales or checkout replay. If the Main Hub, Staff Access, or permission check fails, the panel says the global list is unavailable; it never reports an authoritative empty list.

## ✨ Register close explainer

The Z-Report step includes a ROSIE explainer for visible close facts: expected cash, actual counted cash, Daily Cash Deposit, cash over/short, card-review warnings, check review, and checkout-recovery warnings.

ROSIE does not close the register, change tender totals, change counted cash, approve payment outcomes, or remove required notes. Treat the explainer as a plain-English review aid before the normal close controls.

## Professional Z-Report
Upon closing, a professional, full-page **Z-Audit Report** is generated. 
- **Audit Grade**: Produces high-fidelity Letter/A4 documents for accounting review.
- **Reporting Station**: The header confirms the assigned printer name for accountability.
- **Open-period audit dates**: The header separates the business date from the open timestamp, close timestamp, and current print date/time.
- **Per-Transaction Subtotal Before Tax**: The audit list separates merchandise subtotal before tax from payment totals. Shipping and alteration-service charges are shown separately from merchandise subtotal, while gift-card loads are shown as separate liability activity and are not included in merchandise sales.
- **Line Discounts**: Each transaction line shows the final line price plus the regular price and discount percent applied.
- **Daily Cash Deposit**: Captures the bank deposit date and cash deposit amount for deposit verification and accounting review.
- **Unresolved Issues at Close**: Freezes the exact card, recovery, and linked-workstation warnings that existed immediately before close. Recovery entries include their close-time kind, status, label, identifiers, timestamps, attempt count, and last error when available. Before close, the preview is explicitly labeled as current preview evidence; only the completed close labels the evidence **at close**. Later repair does not rewrite the archived report.
- **QBO Preview**: Shows the journal-entry breakdown staged for QuickBooks review.
- **Inventory Activity**: Lists non-sale inventory moves for the day, including Receiving, RTV, Damaged, Physical Count, and Adjustments.
- **Routing**: In the desktop app, the Z-Report prints through the configured Reports printer instead of the receipt printer or an external browser tab. ROS waits for that print dispatch before leaving close and shows a message if the Reports printer path fails. The report header shows the saved Reports printer name for accountability.

## Recovery and escalation

The final pending business-day close is final for the till group. Review cash, card, gift card, pickup completion, checkout recovery, and RMS/R2S evidence before closing. Repair issues when practical; otherwise assign an owner and use the dedicated Manager Access close approval. The Z-Report must list every unresolved issue that existed immediately before close, and the issue must remain available for later audited recovery. Required cash, check, deposit-date, and over-$5 discrepancy-note inputs still must be completed.


## Tips
- **No mid-shift "X"**: Mid-shift counts should use the live Dashboard. The Z-close is a permanent shift-ending action.
- **Hardware Decoupling**: Ensure your **Report Printer** is correctly assigned in **Settings -> Printers & Scanners** to avoid routing Z-reports to the thermal receipt printer.

## Related workflows

- [POS Register Dashboard](manual:pos-register-dashboard)
- [Register Reports](manual:pos-register-reports)
