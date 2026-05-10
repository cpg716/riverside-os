---
id: pos-receipt-summary-modal
title: "Receipt Preview and Delivery"
order: 1068
summary: "Preview, print, text, or email the completed sale receipt."
source: client/src/components/pos/ReceiptSummaryModal.tsx
last_scanned: 2026-05-10
tags: pos-receipt-summary-modal, pos, receipt, printing
status: approved
---

# Receipt Preview and Delivery

## What this is

The sale complete receipt preview shows the customer receipt after checkout. It should match the Receipt Builder style closely enough that staff can trust what will print, email, or text.

## How to use it

1. Review the sale total, tender, and transaction number on the sale complete screen.
2. Choose print, view, text, email, gift receipt, or reports printer based on the customer request.
3. Confirm the preview or printer path shows the formatted receipt before handing it off.

## Actions

- **Print receipt** sends the customer receipt to the station receipt printer.
- **View receipt** opens the preview.
- **Text receipt** and **Email receipt** send the customer copy when the sale has the needed customer contact information.
- **Gift receipt** prints a gift copy without exposing normal payment detail.
- **Reports printer** opens the formatted receipt for the workstation report printer path.

## Receipt preview

The preview is intentionally narrow and receipt-like. It uses the same receipt content that the customer should receive by print, text, or email.

If the reports printer opens a blank page, retry from the receipt preview and report the transaction number to support. The report-printer window should contain the formatted receipt, not a white page.

## Walk-in sales

If no customer is attached, the sale complete screen explains that SMS or email delivery requires a customer on file. Staff can still print or view the receipt.

## What to watch for

- Confirm the receipt total, paid amount, tender, and status before handing the receipt to the customer.
- Use gift receipt only when the customer asks for one.
- Do not use screenshots of receipts as customer delivery unless support asks for troubleshooting evidence.

## Related workflows

- [Register Checkout](manual:pos-nexo-checkout-drawer)
- [Receipt Settings](manual:settings-receipt-builder-panel)
