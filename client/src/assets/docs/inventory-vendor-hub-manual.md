---
id: inventory-vendor-hub
title: "Vendor Hub (inventory)"
order: 1027
summary: "Review vendor health, brand links, and merge duplicate suppliers without losing PO history."
source: client/src/components/inventory/VendorHub.tsx
last_scanned: 2026-04-20
tags: inventory-vendor-hub, inventory, vendors, procurement
---

# Vendor Hub (inventory)

<!-- help:component-source -->
_Linked component: `client/src/components/inventory/VendorHub.tsx`._
<!-- /help:component-source -->

## What this is

Use **Vendors** to review supplier health, vendor codes, linked brands, and merge duplicate vendor records into one source of truth.

## How to use it

1. Search and select the vendor you want to review.
2. Check the hub strip for **vendor code**, **account**, **terms**, active PO count, and received spend.
3. Add or remove vendor-specific brands as needed.
4. Use **Merge** only when two vendor records truly represent the same supplier.

## Validation rules

- Vendor names and vendor codes should be unique across ROS.
- Merge requires different source and target vendors.
- Merge moves products, purchase orders, vendor brands, and mapped supplier items onto the target vendor before retiring the source record.

## Tips

- Treat **vendor code** as the integration key for Counterpoint-linked suppliers.
- Merge duplicates before building new POs so receiving and reporting stay attached to one supplier record.
