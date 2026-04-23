---
id: pos-register-dashboard
title: "Register Dashboard (pos)"
order: 1070
summary: "Use the register dashboard as the Windows station home screen after the till is open."
source: client/src/components/pos/RegisterDashboard.tsx
last_scanned: 2026-04-22
tags: pos-register-dashboard, pos, register, windows
---

# Register Dashboard (pos)

<!-- help:component-source -->
_Linked component: `client/src/components/pos/RegisterDashboard.tsx`._
<!-- /help:component-source -->

## What this is

This is the default home screen many Windows register stations land on after the till opens. It gives staff a quick shift overview and a safe starting point before they jump into the live cart.

## How to use it

1. Open the register and finish the readiness check on the Register Access screen first.
2. Review the dashboard cards for shift context, then switch to **Register** when you are ready to sell.
3. Use the dashboard when you need to pause between customers without leaving the POS shell.

## Tips

- This screen is post-open only. API and receipt-printer readiness are checked earlier on the Register Access screen.
- If the previous sale had a receipt-printing problem, finish recovery in the Receipt Summary screen before returning fully to dashboard rhythm.
- If scanner input stops landing in product search after you return to the cart, use **Focus /** in the cart, or press **/** on a keyboard station, before scanning again.

## Screenshots

Use governed screenshots from `../images/help/pos-register-dashboard/` when this manual is refreshed so the dashboard examples match the live station view.

![Example](../images/help/pos-register-dashboard/example.png)
