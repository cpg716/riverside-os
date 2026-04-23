---
id: layout-pos-shell
title: "Pos Shell (layout)"
order: 1033
summary: "Use the Windows register shell to move between Dashboard, Register, and the mirrored POS workspaces while a till session is open."
source: client/src/components/layout/PosShell.tsx
last_scanned: 2026-04-22
tags: layout-pos-shell, pos, register, windows
---

# Pos Shell (layout)

<!-- help:component-source -->
_Linked component: `client/src/components/layout/PosShell.tsx`._
<!-- /help:component-source -->

## What this is

This is the main **Register desktop shell** used on the Windows Tauri app after staff sign-in. It keeps the POS rail visible and lets you move between **Dashboard**, **Register**, **Tasks**, and the mirrored customer/order/inventory workspaces without leaving the register environment.

## How to use it

1. Sign in through the staff gate, then open **POS**.
2. Use the left POS rail to move between **Dashboard** and **Register** during a live shift.
3. In POS, `Customers` is intentionally narrow: it covers `All`, `Add`, and `Duplicate Review` only.
4. Use `RMS Charge` as its own POS rail section when staff need the slim RMS Charge workspace.
5. Use `Podium Inbox` as its own POS rail section when staff need the shared Podium SMS/email thread list.
6. `Inventory` in POS is the inventory list surface only. Broader inventory admin sections like receiving, vendors, or purchase orders are not part of the POS inventory rail contract.
7. If the till is not open yet, the shell will route you into the register access flow before sales work can continue.
8. Use **Exit POS** only when you need to return to the broader Back Office shell.

## Tips

- On Windows register stations, Riverside now opens in a maximized desktop window so the POS shell has enough room for the cart, drawer, and sidebar.
- Before the cart opens, the Register Access screen now runs a station-readiness check for API reachability and receipt-printer connectivity.
- Core cashier actions in the cart use larger touch targets, and **Park Sale** now uses a Riverside prompt instead of a browser dialog.
- Register #1 is the main cash-drawer lane. Other lanes still depend on Register #1 being open first.
- Standalone POS workflows like `Shipping`, `Layaways`, `RMS Charge`, and `Podium Inbox` should stay top-level in the rail rather than being nested under `Customers` or `Inventory`.
- The POS shell is separate from **Shop Host** and separate from **Remote Access**. A normal register station should not be used to start host mode unless that PC is intentionally acting as the host machine.

## Screenshots

Use governed screenshots from `../images/help/layout-pos-shell/` when this manual is refreshed so the POS shell visuals stay aligned with the live UI.

![Example](../images/help/layout-pos-shell/example.png)
