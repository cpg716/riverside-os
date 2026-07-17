---
id: pos-receipt-summary-modal
title: "Receipt Preview and Delivery"
order: 1068
summary: "Preview, print, text, or email the completed sale receipt."
source: client/src/components/pos/ReceiptSummaryModal.tsx
last_scanned: 2026-07-17
tags: pos-receipt-summary-modal, pos, receipt, printing
status: approved
---

# Receipt Preview and Delivery

## Screenshots

![Receipt summary](../images/help/pos/receipt-summary.png)

![Receipt preview](../images/help/pos/receipt-preview.png)

![Printers and settings context](../images/help/settings-help-center-settings-panel/example.png)

## What this is

The sale complete receipt preview shows the customer receipt after checkout. It should match the Receipt Builder style closely enough that staff can trust what will print, email, or text.

## How to use it

1. Review the sale total, tender, and transaction number on the sale complete screen.
2. Choose print, view, text, email, gift receipt, or reports printer based on the customer request.
3. Confirm the preview or printer path shows the formatted receipt before handing it off.

## Actions

- **Print receipt** sends the customer receipt through the station receipt-printer route. If it fails, the completed sale stays intact and Riverside offers retry, printer check, SMS, or email delivery.
- **View receipt** opens the preview.
- **Text receipt** and **Email receipt** send the customer copy when the sale has the needed customer contact information.
- **Gift receipt** prints a gift copy without exposing normal payment detail.
- **Reports printer** opens the formatted receipt copy for the workstation report-printer path; it does not replace the Epson receipt-station print route.
- **Review Request** lets the cashier send or skip the Podium review request for eligible completed or picked-up sales.

## Review requests

The review request option appears on eligible sale completion screens when Podium review requests are enabled. Riverside only sends after completed or picked-up sales, and only once per customer every 180 days. If the customer was asked recently, has no phone or email, or the cashier chooses **Do not send**, Riverside records that outcome instead of silently failing.

## Receipt preview

The preview is intentionally narrow and receipt-like. It uses the same receipt content that the customer should receive by print, text, or email.

Receipt line items keep the product name as the primary line, show quantity only when more than one unit is sold, and place SKU with the price on the item detail line. Pickup receipts still use the normal **RECEIPT** heading; picked-up merchandise appears in the body under **PICKED UP** with the original order date on those lines. Items still remaining on the transaction are not printed on the pickup receipt.

When a customer picks up an order and buys new merchandise in the same checkout, the sale complete screen prints one checkout receipt. It includes the new sale lines plus the exact picked-up items and their source Transaction number. Daily Sales lists the checkout once, while **Pickups Today** preserves the fulfillment record. Pure pickup checkouts still print the pickup receipt for the original transaction.

Split tenders print as separate tender lines, such as **Cash**, **CC**, **RMS90**, **RMS**, **Check**, or **SC**, so the receipt matches the payment breakdown staff see in history and reporting.

Manager-approved backdated sales are marked **BACKDATED SALE** with the backdated business date. The printed receipt timestamp remains the server checkout time; payment movement still belongs to the actual processing day.

If the reports printer opens a blank page, retry from the receipt preview and report the transaction number to support. The report-printer window should contain the formatted receipt, not a white page.

## Walk-in sales

If no customer is attached, the sale complete screen explains that SMS or email delivery requires a customer on file. Staff can still print or view the receipt.

## What to watch for

- Confirm the receipt total, paid amount, tender, and status before handing the receipt to the customer.
- On Register #1, CASH and CHECK sales open the Epson-attached cash drawer automatically when the drawer setting is enabled.
- Receipt reprints and gift receipts do not intentionally open the cash drawer.
- Use gift receipt only when the customer asks for one.
- Do not use screenshots of receipts as customer delivery unless support asks for troubleshooting evidence.

## Related workflows

- [Register Checkout](manual:pos-nexo-checkout-drawer)
- [Receipt Settings](manual:settings-receipt-builder-panel)
- [Printers & Scanners](manual:settings-printers-and-scanners-panel)
