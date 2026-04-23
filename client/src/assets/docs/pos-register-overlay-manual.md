---
id: pos-register-overlay
title: "Register Overlay (pos)"
order: 1073
summary: "Use this screen to open or attach the Windows register terminal to the correct lane before selling."
source: client/src/components/pos/RegisterOverlay.tsx
last_scanned: 2026-04-22
tags: pos-register-overlay, pos, register, windows
---

# Register Overlay (pos)

<!-- help:component-source -->
_Linked component: `client/src/components/pos/RegisterOverlay.tsx`._
<!-- /help:component-source -->

## What this is

This is the **Register Access** screen shown before the POS cart can be used. It verifies the staff member, opens the correct lane, explains when **Register #1** must already be open, and now shows whether the station is ready for checkout work.

## How to use it

1. Choose your name and enter your **4-digit Access PIN**.
2. Review the **Station Readiness** panel.
3. Confirm the Riverside API is reachable and the receipt printer is responding for this station.
4. Pick the correct register lane for this terminal.
5. If you are at the main cash drawer, open **Register #1** and enter the opening float.
6. If you are opening another lane, wait until **Register #1** is already active, then continue.

## Tips

- Register #1 is the main drawer and the only lane that performs the shared Z-close.
- If the readiness panel shows the station is not ready, fix the server URL, network path, or printer settings before opening the terminal for customers.
- Register #2 or #3 should not be opened first. They attach to the till group created by Register #1.
- Product search auto-focuses after the register opens. If a scan lands in the wrong place later, use **Focus /** in the cart, or press **/** on a keyboard station, to reclaim the search field.
- This screen is for the local Windows register workflow. It is not the same as **Shop Host** and it is not the same as **Remote Access** over Tailscale.

## Screenshots

Use governed screenshots from `../images/help/pos-register-overlay/` when this manual is refreshed so the station-readiness examples stay aligned with the live UI.

![Example](../images/help/pos-register-overlay/example.png)
