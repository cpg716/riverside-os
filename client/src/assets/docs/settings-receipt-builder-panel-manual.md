---
id: settings-receipt-builder-panel
title: "Receipt Settings Panel (settings)"
order: 1097
summary: "Adjust standard Epson receipt content for receipt printing and delivery."
source: client/src/components/settings/ReceiptBuilderPanel.tsx
last_scanned: 2026-04-26
tags: settings-receipt-builder-panel, settings, receipt, printing
status: approved
---

# Receipt Settings Panel (settings)

<!-- help:component-source -->
_Linked component: `client/src/components/settings/ReceiptBuilderPanel.tsx`._
<!-- /help:component-source -->

## What this is

Receipt Settings controls what appears on customer receipts. The production path is **Standard Epson**, which uses ReceiptLine markdown for the editable template and prints ESC/POS receipts on Epson TM-m30III-compatible printers.

## When to use it

Use this panel when changing the receipt logo, store name, header lines, footer lines, or receipt sections used for receipt output.

## How to use it

1. Open **Settings → Receipt Settings**.
2. Use **Receipt Logo** to show or hide the Riverside logo at the top of printed receipts.
3. Edit the store identifier.
4. Add one header line per row for address, phone, service notes, or pickup instructions.
5. Add one footer line per row for thanks, return policy, or store messaging.
6. Turn receipt sections on or off.
7. Review or edit the ReceiptLine template when the store needs a deeper layout change.
8. Use the preview to review the standard receipt shape.
9. Click **Apply** to save the standard receipt settings.

## Tips

- Use **Printers & Scanners** to set the workstation receipt printer IP.
- Epson ESC/POS is the active production receipt path.
- The preview reflects the ReceiptLine template, header lines, footer lines, and section toggles before saving.
- The receipt logo is controlled by the `{{LOGO_IMAGE}}` token and is resized for 80mm Epson thermal output.
- Keep financial tokens such as `{{ITEM_LINES}}`, `{{TOTAL_LINE}}`, `{{PAID_LINE}}`, and `{{TENDER_LINE}}` in the template.
- The old HTML designer is not part of normal receipt setup.

## What happens next

New receipt settings apply to future receipt previews, printed receipts, text receipts, and email receipts.

## Related workflows

- Printers & Scanners controls the workstation printer IP and scanner test.
- POS sale completion uses these receipt settings after checkout.
- Podium receipt delivery uses the same standard receipt content when no legacy HTML template exists.

## Screenshots

Use governed screenshots from `../images/help/settings-receipt-builder-panel/` when this manual is refreshed.

![Example](../images/help/settings-receipt-builder-panel/example.png)
