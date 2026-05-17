---
id: inventory-product-master-form
title: "Add Item (inventory)"
order: 1022
summary: "Create a new item, enter basic pricing, and generate its starting sellable SKUs."
source: client/src/components/inventory/ProductMasterForm.tsx
last_scanned: 2026-04-20
tags: inventory-product-master-form, inventory, product-master, catalog
---

# Add Item (inventory)

## Screenshots

![Inventory control board](../images/help/inventory-control-board/main.png)

![Receive Stock workflow](../images/help/inventory-receiving-bay/main.png)

![Purchase order panel](../images/help/inventory-purchase-order-panel/main.png)

## What this is

Use **New Item** to create a new item and generate its starting sellable SKUs.

Brand is optional. Vendor decisions happen through **Vendors**, **Purchase Orders**, and product details.

## How to use it

1. Enter the product **name** and choose a valid **category**.
2. Add a brand only if that label matters for reports, tags, or the online store.
3. Enter **non-negative** retail and cost values.
4. Build the size / option list and confirm the new SKUs.
5. Review the final list before saving.

## Validation rules

- Product **name** is required.
- A valid **category** is required before continuing.
- Base retail, base cost, and generated starting stock must all be **non-negative**.
- New SKUs must be present and must not collide with an existing SKU already in ROS.
- Size, color, fit, or other option values must stay aligned with the generated SKU list.

## Operational detail

Create the product record only when the category, name, vendor context, and starting SKU pattern are clear. The form should establish catalog identity, not fix live stock after the fact. If the item already exists under a different SKU or vendor spelling, stop and use Inventory search or Product Hub before creating a duplicate.


## Tips

- If you need to change on-hand quantity after creation, use **Receive Stock** or **Physical Inventory** instead of the item form.
- If a save fails with an existing SKU message, search that SKU in **Inventory List** before trying again.

## What happens next

After saving, review the product in Product Hub before staff sell it. Confirm the generated SKUs, category, pricing, vendor context, and tag behavior. If the product needs stock, use receiving or physical inventory so the inventory movement is traceable.


## Related workflows

- [Inventory Control Board](manual:inventory-control-board)
- [Product Hub Drawer](manual:inventory-product-hub-drawer)
