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

## What this is

This panel stores the current workstation's hardware targets. Back Office and POS use the same local settings, but POS opens a Register Hardware view with lane-focused readiness and test actions.

## When to use it

Use this panel when opening a new lane, replacing a printer, checking scanner input, or troubleshooting receipt delivery after a completed sale.

## How to use it

1. Open **Settings → Printers & Scanners**.
2. For the Epson TM-m30III receipt station, choose an installed printer from the desktop printer dropdown or enter the printer IP and port for network mode.
3. Leave **Open cash drawer on cash/check** enabled for Register #1 when the drawer is attached to the Epson receipt printer.
4. For the Zebra 2844 clothing tag station, choose the installed Zebra printer or enter the tag printer IP for network ZPL mode.
5. Enter the reports printer target when the workstation uses a dedicated reports bridge.
6. In POS, use **Print test** to send a short Epson test receipt.
7. Use **Open drawer** only when you need a manual drawer open. Enter a reason and the acting staff member's **Access PIN** so the event is recorded for the Z-report.
8. Use **Check connection** for the receipt printer in the Riverside desktop app.
9. Focus the scanner test field and scan a barcode to confirm HID keyboard input is reaching ROS.

## Tips

- Receipt printing uses Epson ESC/POS for the TM-m30III path.
- The cash drawer opens automatically only on CASH and CHECK sales from Register #1.
- Manual drawer opens require an Access PIN, a reason, and are listed on the Z-report.
- The POS Register Hardware view shows the active receipt address, cash drawer state, and Zebra tag target at the top of the page.
- Item tags print directly to the configured Zebra 2844/ZPL station when the station can be reached; ROS opens tag preview only when direct dispatch is unavailable.
- Browser/PWA mode can save the same settings and can use server-side network printing when the API host can reach the printer. Installed-printer dropdowns and live local readiness checks run in the desktop app.
- USB scanner hardware on PC and Bluetooth scanner hardware on iPad/phone should be configured as HID keyboard input with an Enter suffix.

## What happens next

The workstation immediately uses the saved local printer targets for receipt, tag, and report actions.

## Related workflows

- Receipt Settings controls Epson receipt content.
- POS sale completion uses the receipt printer target.
- Inventory tag printing uses the tag station target.

## Screenshots

Use governed screenshots from `../images/help/settings-printers-and-scanners-panel/` when this manual is refreshed.
