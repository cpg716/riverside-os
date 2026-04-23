---
id: inventory-product-hub-drawer
title: "Product Hub Drawer (inventory)"
order: 1021
summary: "Draft maintainer scaffold for client/src/components/inventory/ProductHubDrawer.tsx. Promote to approved after SOP review and screenshot capture."
source: client/src/components/inventory/ProductHubDrawer.tsx
last_scanned: 2026-04-23
tags: inventory-product-hub-drawer, component, auto-scaffold
status: draft
---

# Product Hub Drawer (inventory)

<!-- help:component-source -->
_Linked component: `client/src/components/inventory/ProductHubDrawer.tsx`._
<!-- /help:component-source -->

## What this is

Use Product Hub when staff need the authoritative SKU view for inventory, recent movement, and purchase-order context.

## What the inventory truth panel means

- `On hand`
  Physical units Riverside currently counts in stock.
- `Reserved in store`
  Units already committed to open order, wedding, or other pickup work.
- `Available now`
  The live sellable quantity after Riverside subtracts reserved units from on-hand stock.
- `On order`
  Incoming purchase-order units only. These are not available to sell until the receipt posts.

The Product Hub panel is a visibility surface. It uses current server-computed values instead of asking staff to calculate availability themselves.

## How to use it

1. Open the product from Inventory.
2. Review `On hand`, `Reserved in store`, and `Available now` before promising stock.
3. Check `On order` only as incoming pipeline, not as current sellable stock.
4. Use recent inventory events when you need to confirm why the number changed.

## Rule reminders

- Reserved units are already promised and should not be treated as walk-in availability.
- Available quantity follows the current server rule, not a manual floor estimate.
- Incoming PO units only count after receiving posts the inventory movement.
