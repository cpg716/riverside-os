---
id: inventory-universal-importer
title: "Universal Importer (inventory)"
order: 1025
summary: "Catalog-only CSV mapper for vendor manifests; Counterpoint sync owns pre-launch inventory quantities."
source: client/src/components/inventory/UniversalImporter.tsx
last_scanned: 2026-04-20
tags: inventory-universal-importer, inventory, import, counterpoint
---

# Universal Importer (inventory)

<!-- help:component-source -->
_Linked component: `client/src/components/inventory/UniversalImporter.tsx`._
<!-- /help:component-source -->

## What this is

Use **Inventory → Import** for **catalog-only CSV mapping** when you need to add or clean up products, variants, categories, vendor links, retail, or cost from a spreadsheet.

This screen does **not** replace live **on-hand** stock.

## When to use Counterpoint instead

Use **Settings → Counterpoint** for the **pre-launch inventory load** and any authoritative inventory sync from Counterpoint.

Use **Receiving** or **Physical Inventory** for operational stock changes after launch.

## How to use it

1. Open **Inventory → Import**.
2. Choose **Catalog CSV**.
3. Upload the vendor or source CSV.
4. Map the required fields: **product identity**, **SKU**, **product name**, **retail price**, **unit cost**, **brand**, and either **category** or a global fallback category.
5. Review the mapping summary.
6. Confirm the file is only meant to update catalog structure, then run **Commit catalog changes**.

## Tips

- **SKU** is the variant identity. Duplicate SKUs in the source file will overwrite catalog fields for that SKU, but they will **not** change live stock.
- If the source file includes stock columns, leave them out of the mapping. This importer rejects stock-on-hand imports on purpose.
- If you are preparing a store launch, finish Counterpoint sync first so opening on-hand quantities come from the authoritative source.
