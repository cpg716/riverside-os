---
id: pos-sale-cashier-sign-in-overlay
title: "Pos Sale Cashier Sign In Overlay (pos)"
order: 1060
summary: "Draft maintainer scaffold for client/src/components/pos/PosSaleCashierSignInOverlay.tsx. Promote to approved after SOP review and screenshot capture."
source: client/src/components/pos/PosSaleCashierSignInOverlay.tsx
last_scanned: 2026-04-23
tags: pos-sale-cashier-sign-in-overlay, component, auto-scaffold
status: draft
---

# Pos Sale Cashier Sign In Overlay (pos)

<!-- help:component-source -->
_Linked component: `client/src/components/pos/PosSaleCashierSignInOverlay.tsx`._
<!-- /help:component-source -->

# POS Sale Cashier Sign-In

This screen appears when starting a new sale or when the current cashier session has expired. It ensures that every transaction is attributed to the correct staff member for commission and audit purposes.

## How to use it

1. **Find Your Avatar**: Scroll through the grid of staff members. Tapping an avatar or name selects that staff member as the primary cashier for the upcoming sale.
2. **Key in PIN**: Enter your 4-digit PIN using the large numeric keypad.
3. **Continue**: Tap **Continue** to unlock the POS cart and start adds items.

## Behavior
- **Station Lock**: If a manager has set a "Primary Staff" for the register session, that name will be highlighted by default.
- **Auto-Dismiss**: Once verified, the overlay disappears and the cashier's name is displayed in the Register status bar.

## Troubleshooting
- **"Invalid PIN"**: Double-check that your name is selected on the grid before typing. PINs are unique to the staff member.
- **Missing Name**: If you just joined the team and don't see your name, ask an administrator to check your "Active" status in the Team workspace.

