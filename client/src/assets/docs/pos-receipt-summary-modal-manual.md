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

This is the post-sale receipt screen shown after checkout succeeds. It confirms that the sale is complete, then lets staff print the receipt, retry printing if needed, or send the receipt by SMS or email.

## How to use it

1. Confirm the sale total and tender summary at the top of the screen.
2. Use **Print receipt** for the standard customer copy or **Print gift receipt** for the gift version.
3. If printing fails, read the warning panel carefully. The sale is already complete even if the printer did not respond.
4. Use **Retry** or **Check station printer** before starting the next customer if the printer path is the problem.
5. If needed, send the receipt by **SMS** or **email** from the same screen.

## Tips

- A print failure does not undo the completed transaction.
- The warning panel is telling you about receipt delivery only, not payment failure.
- If the printer check passes after a failure, retry printing from this screen before moving on.

## Screenshots

Add PNGs under `../images/help/pos-receipt-summary-modal/` and embed them, for example:

![Example](../images/help/pos-receipt-summary-modal/example.png)
