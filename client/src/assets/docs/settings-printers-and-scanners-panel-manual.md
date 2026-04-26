---
id: settings-printers-and-scanners-panel
title: "Printers And Scanners Panel (settings)"
order: 1109
summary: "Configure workstation receipt, tag, report printer targets and verify scanner input."
source: client/src/components/settings/PrintersAndScannersPanel.tsx
last_scanned: 2026-04-26
tags: settings-printers-and-scanners-panel, settings, printers, scanners, hardware
status: approved
---

# Printers And Scanners Panel (settings)

<!-- help:component-source -->
_Linked component: `client/src/components/settings/PrintersAndScannersPanel.tsx`._
<!-- /help:component-source -->

## What this is

This panel stores the current workstation's hardware targets. Back Office and POS use the same local settings, but POS opens a Register Hardware view with lane-focused readiness and test actions.

## When to use it

Use this panel when opening a new lane, replacing a printer, checking scanner input, or troubleshooting receipt delivery after a completed sale.

## How to use it

1. Open **Settings → Printers & Scanners**.
2. Enter the receipt printer IP and port for the Epson TM-m30III receipt station.
3. Leave **Open cash drawer on cash/check** enabled for Register #1 when the drawer is attached to the Epson receipt printer.
4. Enter the tag printer IP for the Zebra 2844 clothing tag station on the host PC.
5. Enter the reports printer target when the workstation uses a dedicated reports bridge.
6. In POS, use **Print test** to send a short Epson test receipt and **Open drawer** to test the attached cash drawer.
7. Use **Check connection** for the receipt printer in the Riverside desktop app.
8. Focus the scanner test field and scan a barcode to confirm HID keyboard input is reaching ROS.

## Tips

- Receipt printing uses Epson ESC/POS for the TM-m30III path.
- The cash drawer opens only on CASH and CHECK sales from the Register #1 desktop app.
- The POS Register Hardware view shows the active receipt address, cash drawer state, and Zebra tag target at the top of the page.
- Item tags use the Zebra 2844/ZPL station on the host PC.
- Browser/PWA mode can save the same settings, but live receipt-printer readiness checks run in the desktop app.
- USB scanner hardware on PC and Bluetooth scanner hardware on iPad/phone should be configured as HID keyboard input with an Enter suffix.

## What happens next

The workstation immediately uses the saved local printer targets for receipt, tag, and report actions.

## Related workflows

- Receipt Settings controls Epson receipt content.
- POS sale completion uses the receipt printer target.
- Inventory tag printing uses the tag station target.

## Screenshots

Use governed screenshots from `../images/help/settings-printers-and-scanners-panel/` when this manual is refreshed.

![Example](../images/help/settings-printers-and-scanners-panel/example.png)
