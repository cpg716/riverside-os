---
id: inventory-variations-workspace
title: "Variations Workspace (inventory)"
order: 1029
summary: "Variation matrix and list workspace for pricing, stock controls, and selected retail price-tag printing."
source: client/src/components/inventory/VariationsWorkspace.tsx
last_scanned: 2026-04-23
tags: inventory-variations-workspace, inventory, variations, retail-price-tags
status: approved
---

# Variations Workspace (inventory)

<!-- help:component-source -->
_Linked component: `client/src/components/inventory/VariationsWorkspace.tsx`._
<!-- /help:component-source -->

## What this is

Use **Variations Workspace** inside Product Hub when you need a matrix-level view of one product’s sizes, colors, or other variation axes and want to act on all or part of that matrix.

## When to use it

Use this workspace when you need to:

1. Review all variations for a single product in grid or list form.
2. Select a subset of variations for a bulk action.
3. Print retail price tags for all variations or only the selected ones.
4. Review pricing, low-stock, and web state at the variation level.

## Before you start

- Open the correct product in **Product Hub** first.
- Decide whether you want a full variation batch or only a selected subset.
- Confirm the product’s effective retail pricing is correct before printing tags.

## Steps

1. Open the **Variations** tab inside Product Hub.
2. Switch between grid and list view depending on whether matrix layout or row-level detail is easier for the task.
3. If you only need some variations, select those rows first.
4. Use `Print selected tags` when you have an active selection, or `Print all tags` when you want the full variation set.
5. Review the shared retail price-tag dialog and adjust quantities for each variation.
6. Confirm the print batch when the dialog matches the physical tags you need.

## What to watch for

- The print button changes meaning based on selection. Check whether it says `Print selected tags` or `Print all tags` before confirming.
- A quantity of `0` skips a variation even if it was selected.
- Printing from this workspace uses the same Zebra LP2844 retail price-tag path as Inventory List and Receive Stock.
- If a variation’s price or label looks wrong, correct the product data before printing floor tags.

## What happens next

- Riverside sends the approved tag batch to the direct print station when available, or opens print preview as a fallback.
- Printed variations are marked as shelf-labeled.
- You remain in Product Hub so you can keep reviewing stock, pricing, or the next variation subset.

## Related workflows

- Use **Product Hub Drawer** for the broader product overview and General-tab tag action.
- Use **Inventory Control Board** for the fastest browse-to-print workflow.
- Use **Receive Stock** when received quantities should prefill the print batch.
