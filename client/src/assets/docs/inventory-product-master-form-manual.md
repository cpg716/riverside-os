---
id: inventory-product-master-form
title: "Product Master Form (inventory)"
order: 1022
summary: "Create new catalog templates with validated pricing, matrix axes, and SKU generation."
source: client/src/components/inventory/ProductMasterForm.tsx
last_scanned: 2026-04-20
tags: inventory-product-master-form, inventory, product-master, catalog
---

# Product Master Form (inventory)

<!-- help:component-source -->
_Linked component: `client/src/components/inventory/ProductMasterForm.tsx`._
<!-- /help:component-source -->

## What this is

Use **Add Inventory** to create a new product template and generate its starting SKU matrix.

The form validates core catalog integrity before the product can be saved.

## How to use it

1. Enter the product **name** and choose a valid **category**.
2. Enter **non-negative** benchmark retail and cost values.
3. Build the variation matrix and confirm the generated SKUs.
4. Review the final list before saving.

## Validation rules

- Product **name** is required.
- A valid **category** is required before continuing.
- Base retail, base cost, and generated starting stock must all be **non-negative**.
- Generated SKUs must be present and must not collide with an existing SKU already in ROS.
- Variant axis values must stay aligned with the generated matrix.

## Tips

- If you need to change on-hand quantity after creation, use **Receiving** or **Physical Inventory** instead of the master form.
- If a save fails with an existing SKU message, search that SKU in **Inventory List** before trying again.
