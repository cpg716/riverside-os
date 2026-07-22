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
- Closing Register #1 reconciles all satellite lanes for one store-local business date. If activity exists on more than one unclosed date, ROS closes the oldest date first and requires each later date to be closed separately. The final date closes the till group.

## The Reconciliation Flow
1. **Cash**: Count bills and coins by denomination, or enter one drawer total.
2. **Checks**: Confirm every check number and amount.
3. **Z-Report**: Review totals, confirm the Daily Cash Deposit date and amount, add required notes, then tap **Close & Print Z-Report**.

The Z-Report page shows the exact **business date** being closed. Closing on the following morning does not rename the report. When multiple dates are waiting, repeat the flow in the order shown; ROS never combines two days. If no separate drawer count was captured for a missed historical day, the report says so instead of inventing an over/short amount.

Cash refunds processed before close are recorded as negative cash activity and reduce **Cash Sales (Gross)**, **Expected Cash**, and the amount available for deposit. If the physical count differs after a refund, the Z-Report must show the resulting over/short instead of remaining balanced.

If a card terminal outcome blocks close, use **Review** in the closing workflow or **POS → Payments** to record the outcome before continuing.

If **Checkout recovery** appears, Riverside OS has durable work that needs review: an offline sale waiting to sync, an online checkout whose server result was not confirmed, a paid pickup follow-up, an exchange replacement waiting for its return settlement, or a receipt retry. Register #1 also waits for every linked workstation to acknowledge its local checkout queue after reconciliation begins. The close panel reports local, Main Hub, and linked-workstation evidence separately; it never treats a missing acknowledgement as an empty queue.

Use **Manager Recover Sales** for saved offline or unconfirmed checkout payloads. The manager enters an identity, Access PIN, and a reason of at least 12 characters. Riverside replays the original Register session, checkout identity, full sale snapshot, and payment fingerprint. An altered payload or a checkout identity from another session is rejected instead of creating a second Transaction Record.

If the paid Transaction Record already exists but its **Unconfirmed checkout** recovery remains open, use **Match Existing Paid Transaction** on that exact item instead of replaying the sale. Enter the completed `TXN-######`, Helcim provider transaction, and a specific Manager reason, then complete Manager Access. Riverside verifies the original checkout, customer, amount, currency, Register session, final provider status, payment allocation, and immutable fingerprints before closing only the recovery record. It creates no sale, charge, refund, payment, or payment movement; any mismatch leaves the item visible for investigation.

For a paid order follow-up, complete every named shipping, pickup, or alteration step in **Orders** or **Alterations** first. Then select **Verify completed follow-up** and complete Manager Access. Riverside checks the recorded Transaction Record, line, shipment, pickup, and alteration evidence before resolving the recovery record. The approval does not perform missing work or treat it as complete.

Use **Complete Exchange Settlement** for a saved exchange replacement whose original return settlement did not finish. This requires Manager Access, a reason of at least 12 characters, and the currently authenticated Register session. Riverside locks the exact Main Hub recovery record, derives all amounts and return details from its saved server snapshot, verifies the replacement checkout identity and the original exchange-credit tender against the origin Register session, then records any new relief or refund movement in the current Register session. It refreshes the reconciliation totals after completion. If a linked provider card refund was intentionally deferred, the close panel keeps its exact remaining amount visible and directs staff to finish it from the original Transaction Record; it does not claim that provider refund completed. A legacy or altered record without complete server provenance remains visible and is rejected instead of moving money.

If the business must close before every recovery record is resolved, the Z-Report step offers **Manager Force Z-Close**. This requires the same audited Manager approval and reason. Force-close preserves and lists every unresolved recovery record in the Z-Report audit snapshot; it does not dismiss the record or claim the work completed. A recovered sale posted after close is recorded as a post-close supplement tied to the original Register session.

The separate **Prior or other till-group recovery** panel uses Staff Access with **Register Reports** permission to find open recovery outside the till group being closed. Those records are informational for the current Z-close and never become current close blockers. Saved checkouts can be replayed with Manager Access and remain tied to their original Register session. Exchange settlement records use the Manager completion workflow above and post new ledger movements only to the current Register session. Paid follow-up records use evidence verification. Receipt-print records are informational and must be handled through Print Recovery; they are never treated as missing sales or checkout replay. If the Main Hub, Staff Access, or permission check fails, the panel says the global list is unavailable; it never reports an authoritative empty list.

## ✨ Register close explainer

The Z-Report step includes a ROSIE explainer for visible close facts: expected cash, actual counted cash, Daily Cash Deposit, cash over/short, card review blockers, check review, and checkout recovery blockers.

ROSIE does not close the register, change tender totals, change counted cash, approve payment outcomes, or remove required notes. Treat the explainer as a plain-English review aid before the normal close controls.

## Professional Z-Report
Upon closing, a professional, full-page **Z-Audit Report** is generated. 
- **Audit Grade**: Produces high-fidelity Letter/A4 documents for accounting review.
- **Reporting Station**: The header confirms the assigned printer name for accountability.
- **Per-Transaction Subtotal Before Tax**: The audit list separates merchandise subtotal before tax from payment totals. Shipping and alteration-service charges are shown separately from merchandise subtotal, while gift-card loads are shown as separate liability activity and are not included in merchandise sales.
- **Line Discounts**: Each transaction line shows the final line price plus the regular price and discount percent applied.
- **Daily Cash Deposit**: Captures the bank deposit date and cash deposit amount for deposit verification and accounting review.
- **QBO Preview**: Shows the journal-entry breakdown staged for QuickBooks review.
- **Inventory Activity**: Lists non-sale inventory moves for the day, including Receiving, RTV, Damaged, Physical Count, and Adjustments.
- **Routing**: In the desktop app, the Z-Report prints through the configured Reports printer instead of the receipt printer or an external browser tab. ROS waits for that print dispatch before leaving close and shows a message if the Reports printer path fails. The report header shows the saved Reports printer name for accountability.

## Recovery and escalation

The final pending business-day close is final for the till group. If cash, card, gift card, pickup completion, checkout recovery, or RMS/R2S totals do not match expected evidence, stop before closing and review the daily sales and terminal reports. A manager should normally recover the work first. Use audited force-close only when delaying the till close would be worse than carrying an explicitly listed recovery item into accounting follow-up.


## Tips
- **No mid-shift "X"**: Mid-shift counts should use the live Dashboard. The Z-close is a permanent shift-ending action.
- **Hardware Decoupling**: Ensure your **Report Printer** is correctly assigned in **Settings -> Printers & Scanners** to avoid routing Z-reports to the thermal receipt printer.

## Related workflows

- [POS Register Dashboard](manual:pos-register-dashboard)
- [Register Reports](manual:pos-register-reports)
