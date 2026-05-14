# POS Wedding Register Workflow

This document describes how the Register uses Wedding Manager truth when a customer who belongs to an active wedding party is attached to the POS cart.

## Goal

When a wedding member comes to the counter, staff should not have to remember the party checklist from a separate screen. Register should show the member's current wedding context, the items they still need to purchase, and whether each item should be taken now, ordered, or held for measurements.

## Source Of Truth

- Wedding Manager owns the party, member, event date, member role, measurement state, and party checklist.
- ROS catalog/product variants own sellable items that can be added to the cart.
- POS checkout owns the financial Transaction Record.
- `transaction_lines.order_lifecycle_status` owns the operational item state after checkout.

Register is a guided entry point. It must not invent wedding items that Wedding Manager has not defined, and it must not silently convert a placeholder suit into NTBO before the exact product variation is selected.

## Register Behavior

When staff attach a customer in POS Register:

1. POS requests `GET /api/weddings/customers/{customer_id}/purchase-context`.
2. If the customer belongs to current or unresolved wedding parties, the customer strip shows wedding membership badges.
3. The Register rail shows a **Wedding Checklist** card.
4. Each linked sellable wedding item can be added as:
   - **Take now**: item is sold as normal takeaway when stock is available.
   - **Order**: item is added as a `wedding_order` fulfillment line.
   - **Measure**: item is added as a `wedding_order` line with `needs_measurements`.
5. Non-inventory checklist items are visible as checklist-only notes. Staff must open the wedding party if those should become sellable product lines.

The cart uses the existing wedding member link (`activeWeddingMember`) so checkout writes the Transaction Record with `wedding_member_id` and continues to feed Wedding Manager readiness.

## Measurement Gate

Wedding placeholder suits are common when the party is started before measurements are complete.

Rules:

- A placeholder or uncertain item should be **Needs Measurements**.
- Staff may update/edit the line later when the exact product variation is known.
- The item should not become **NTBO** until the exact variation is selected.
- If the final item is a different product, staff should delete the placeholder line and add the correct product.

This keeps Order Stock and PO creation from buying the wrong size or style.

## In-Store Vs Ordered

Some wedding items are physically available in store.

- If the customer wants to take the item now, staff use **Take now**.
- If the item must be procured or held for later party fulfillment, staff use **Order**.
- If measurements are still needed, staff use **Measure** even when the party's base suit is known.

Payment proceeds like any other POS sale. The difference is that wedding-linked lines remain visible to Wedding Manager and the shared Orders lifecycle.

## Checklist-Only Items

Wedding Manager may include non-inventory items such as notes, manual package tasks, or party-specific checklist entries.

Register shows these so staff know the item exists, but it does not auto-add them to cart because there is no catalog product, price, cost, tax category, or stock source. If a checklist item should be sold, the wedding party should be updated with the exact ROS product variation first.

## API Contract

`GET /api/weddings/customers/{customer_id}/purchase-context`

Auth: Back Office staff with `weddings.view` or an open POS register session.

Response shape:

- `memberships[]`
  - wedding member and party identifiers
  - party name, event date, role, status
  - measurement and suit ordered flags
  - linked sellable `purchase_items[]`
  - checklist-only `checklist_items[]`

Sellable purchase items flatten the same cart-ready product fields used by POS SKU resolution and include:

- `source`
- `already_tracked`

`already_tracked` tells Register not to duplicate an item that already exists on a wedding-linked Transaction Record.

## Staff UX Rules

- Use plain terms: **Wedding Checklist**, **Take now**, **Order**, **Measure**.
- Do not expose internal table names to staff.
- Do not imply that checklist-only items can be charged until they are linked to a product variation.
- Show stock availability before offering take-now behavior.
- Keep the escape path obvious: **Open** the wedding party for full Wedding Manager review.

## Related Docs

- [Transactions and Fulfillment Orders](TRANSACTIONS_AND_WEDDING_ORDERS.md)
- [Wedding + Counterpoint Cutover Linking](WEDDING_COUNTERPOINT_CUTOVER_LINKING.md)
- [POS Register staff guide](staff/pos-register-cart.md)
- [POS Weddings staff guide](staff/pos-weddings.md)
- [Weddings Back Office staff guide](staff/weddings-back-office.md)
