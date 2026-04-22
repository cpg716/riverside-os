---
id: pos-sidebar
title: "POS Sidebar"
order: 1062
summary: "Use the POS rail to move between register-native workflows like Register, Customers, RMS Charge, Shipping, and Layaways without inheriting the broader Back Office subsection tree."
source: client/src/components/pos/PosSidebar.tsx
last_scanned: 2026-04-22
tags: pos-sidebar, pos, navigation, register
---

# POS Sidebar

<!-- help:component-source -->
_Linked component: `client/src/components/pos/PosSidebar.tsx`._
<!-- /help:component-source -->

## What this is

This is the left rail inside the POS shell. It is a POS-native navigation surface, not a copy of the broader Back Office sidebar.

The POS rail should route cashiers into register-focused workflows directly:

- `Customers` only exposes:
  - `All`
  - `Add`
  - `Duplicate Review`
- `Inventory` opens the POS inventory list only
- `RMS Charge` is its own standalone POS section
- workflows like `Layaways` and `Shipping` stay as their own top-level POS sections instead of nesting under Customers

## How to use it

1. Use `Register` for the live cart and checkout flow.
2. Use `Customers` for customer browse, customer creation, and duplicate review only.
3. Use `RMS Charge` when you need the slim POS RMS Charge workspace.
4. Use `Inventory`, `Shipping`, and `Layaways` as separate operational sections when those workflows are needed.

## Tips

- If you are looking for RMS financing support tools, do not expect them under `Customers` in POS anymore. Open `RMS Charge` directly from the rail.
- If you are looking for inventory administration tools like receiving, vendors, or purchase orders, those stay outside the POS inventory list surface.

## Screenshots

Add PNGs under `../images/help/pos-sidebar/` and embed them, for example:

![Example](../images/help/pos-sidebar/example.png)
