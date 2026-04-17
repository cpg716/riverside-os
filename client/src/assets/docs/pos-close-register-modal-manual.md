---
id: pos-close-register-modal
title: "Closing the Register (Z-Report)"
order: 1051
summary: "Reconciling your daily shift, counting cash, and generating the professional Z-Audit report."
source: client/src/components/pos/CloseRegisterModal.tsx
tags: pos, register, closing, Z-report, audit
---

# Z-Reconciliation & Closing

The **Close Register** workspace is the final step of a shift. It reconciles expected totals against actual physical counts.

## Till Group Closing
Riverside OS uses a **lane-aggregated model**. Opening **Register #1 (Main)** automatically opens satellite lanes (iPad and Back Office). 
- To close the entire group, you **MUST** use the **Close Register** action on **Register #1**.
- Closing Register #1 will automatically reconcile and close all satellite lanes in a single audit transaction.

## The Reconciliation Flow
1. **Count Cash**: Enter the total physical cash in the drawer (including the base float).
2. **Review Tenders**: Compare the provided totals for Card, Gift Card, and R2S charges against your terminal reports.
3. **Verify Discrepancies**: If current totals don't match, review the **Daily Sales** history before finalizing.
4. **Finalize Z-Report**: Tap **Close Register & Print Z-Report**.

## Professional Z-Report
Upon closing, a professional, full-page **Z-Audit Report** is generated. 
- **Audit Grade**: Replaces legacy thermal strips with high-fidelity Letter/A4 documents.
- **Reporting Station**: The header confirms the assigned printer name for accountability.
- **Routing**: This report prints automatically to your **Report Station** (System Printer).

## Tips
- **No mid-shift "X"**: Mid-shift counts should use the live Dashboard. The Z-close is a permanent shift-ending action.
- **Hardware Decoupling**: Ensure your **Report Printer** is correctly assigned in Register Settings to avoid routing Z-reports to the thermal receipt printer.
