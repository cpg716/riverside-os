---
id: pos-product-snapshot-drawer
title: "Product Snapshot Drawer (POS)"
order: 1066
summary: "Quick-access SKU details, stock levels, and price adjustment controls within the POS."
source: client/src/components/pos/ProductConfirmDrawer.tsx
last_scanned: 2026-04-17
tags: pos, inventory, stock, price-override
---

# Product Snapshot Drawer (POS)

<!-- help:component-source -->
_Linked component: `client/src/components/pos/ProductConfirmDrawer.tsx`._
<!-- /help:component-source -->

## What this is

The Product Snapshot Drawer (formerly Intelligence) allows cashiers to quickly verify stock levels and metadata for a specific SKU. It includes integrated price adjustment controls for rapid checkout.

## How to use it

1. Scan a product or select one from the lookup hub.
2. Review **Stock on Hand** and **Available Stock** in real-time.
3. Check **Quantity on Order** for incoming replenishment.
4. Use the integrated numpad to apply price overrides or discounts before adding the item to the sale.

## Tips

- The snapshot provides a 3-month sales history summary to help with upsell decisions.
- Pricing overrides captured here follow the store's manager approval thresholds.
