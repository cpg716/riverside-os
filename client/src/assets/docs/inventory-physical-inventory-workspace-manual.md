---
id: inventory-physical-inventory-workspace
title: "Physical Inventory Workspace (inventory)"
order: 1020
summary: "Run full-store or category counts, surface missed in-scope SKUs during review, and publish reconciled stock with audit history."
source: client/src/components/inventory/PhysicalInventoryWorkspace.tsx
last_scanned: 2026-04-21
tags: inventory-physical-inventory-workspace, inventory, physical-count, reconciliation
---

# Physical Inventory Workspace (inventory)

<!-- help:component-source -->
_Linked component: `client/src/components/inventory/PhysicalInventoryWorkspace.tsx`._
<!-- /help:component-source -->

## What this is

Use **Physical count** to run a full-store or category-limited count, review variances, and publish reconciled stock with an audit trail.

## How to use it

1. Start a new session and choose either **Full store** or selected categories.
2. Scan or search SKUs while the session is open.
3. Move the session into **Review** when counting is complete for the chosen scope.
4. Review all variance rows, including anything in scope that was **not counted**.
5. Publish only after the missing or zero-count rows make sense for the store floor.

## Review and publish behavior

- Review is built from the full in-scope snapshot, not only from scanned SKUs.
- If an in-scope SKU was missed during counting, it still appears in review as a variance row.
- Full-count review now surfaces **missing variants** before publish instead of silently leaving them untouched.
- Publish applies the reviewed reconciliation to live stock and records the inventory transaction history atomically.

## Tips

- Treat a large block of **not counted** rows as a scope problem first, not as automatic shrink.
- Use review notes for damaged, misplaced, or pending floor-check explanations before publishing.
