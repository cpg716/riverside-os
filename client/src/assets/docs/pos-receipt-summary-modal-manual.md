---
id: pos-receipt-summary-modal
title: "Receipt Summary Modal (pos)"
order: 1068
summary: "Use this screen after a completed sale to print, retry, or send the receipt."
source: client/src/components/pos/ReceiptSummaryModal.tsx
last_scanned: 2026-04-22
tags: pos-receipt-summary-modal, pos, receipt, printing
---

# Receipt Summary Modal (pos)

<!-- help:component-source -->
_Linked component: `client/src/components/pos/ReceiptSummaryModal.tsx`._
<!-- /help:component-source -->

## What this is

This is the post-sale receipt screen shown after checkout succeeds. It confirms that the sale is complete, then lets staff print, view, text, or email the customer receipt. Gift receipts open in a separate selection window so the main completion screen stays focused on finishing the sale.

## How to use it

1. Confirm the sale total and tender summary.
2. Use **Print receipt**, **Text receipt**, or **Email receipt** for the standard customer copy.
3. Use **View receipt** to preview the receipt and choose **Receipt printer** or **Reports printer** from the preview window.
4. Use **Gift receipt** only when a gift copy is needed. Select the included lines, then choose print, text, or email inside that window.
5. If a customer is attached, phone and email prefill from the customer profile. Staff may edit them for this receipt and use **Save** when the profile should be updated.
6. If printing fails, read the warning panel carefully. The sale is already complete even if the printer did not respond.
7. Use **Retry** or **Check station printer** before starting the next customer if the printer path is the problem.

## Tips

- A print failure does not undo the completed transaction.
- The warning panel is telling you about receipt delivery only, not payment failure.
- If the printer check passes after a failure, retry printing from this screen before moving on.

## Screenshots

Use governed screenshots from `../images/help/pos-receipt-summary-modal/` when this manual is refreshed so receipt-delivery examples stay aligned with the live UI.

![Example](../images/help/pos-receipt-summary-modal/example.png)
