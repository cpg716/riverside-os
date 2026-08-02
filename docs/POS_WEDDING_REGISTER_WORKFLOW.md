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
3. For an active membership, Register asks **Part of the Wedding Order?** before activating wedding fulfillment.
   - **Yes — Build Wedding Order** activates the exact party/member and opens the reusable Wedding Builder checklist and variation workflow.
   - **No — Regular Sale** leaves the cart outside wedding fulfillment and makes no financial or wedding write. **Start Wedding Order** remains available if staff dismissed the question by mistake.
4. After staff accept, the Register rail shows the active member's **Wedding Checklist** card. Party-level parent products come from Wedding Manager; staff choose the exact sellable variation for this member instead of adding a representative variation silently.
5. Each linked sellable wedding item can be added as:
   - **Take now**: item is sold as normal takeaway when stock is available.
   - **Order**: item is added as a `wedding_order` fulfillment line.
   - **Measure**: item is added as a `wedding_order` line with `needs_measurements`.
6. While the member context is active, additional products found by search or scan default to `wedding_order`; staff may still make an explicit **Take now** choice or add alterations.
7. Non-inventory checklist items are visible as checklist-only notes. Staff must open the wedding party if those should become sellable product lines.

The cart uses the existing wedding member link (`activeWeddingMember`) so checkout writes the Transaction Record with `wedding_member_id` and continues to feed Wedding Manager readiness.

Changing or removing the selected Customer immediately closes any Wedding prompt or variation panel and clears the active member, held-deposit application, checklist, and unposted Wedding context. A prior member's party or item selection must never carry into another Customer's cart.

## Variation Selection Navigation

When a sellable parent product has multiple variations, the shared side panel keeps **Item to Build** and every completed choice visible. Staff can use **Back** at each option and on pricing review, or select a completed choice to edit from that point. Back at the first step returns to the Wedding Builder or Cart without adding or changing the item. A variant is applied only after the staff member confirms the final selection and price.

## Held Deposit And Financial Boundary

If the selected member has a wedding deposit funded by another party member, the prompt identifies the available exact source amount and contributing payer. Displaying or accepting the prompt does not redeem it. Staff explicitly choose the held-deposit amount from **Pay**.

The prompt, checklist, variation panel, and parked draft are nonfinancial entry surfaces. Only successful server-validated checkout may create the member Transaction Record, Wedding Fulfillment Order, payment allocation or open-deposit redemption, tax records, salesperson attribution, reporting activity, provider evidence, and receipt. A declined payment or abandoned prompt creates none of those financial records.

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
- Make the first choice explicit: **Yes — Build Wedding Order** or **No — Regular Sale**.
- Do not expose internal table names to staff.
- Do not imply that checklist-only items can be charged until they are linked to a product variation.
- Show stock availability before offering take-now behavior.
- Never imply that a displayed held deposit was applied before staff select it in **Pay** and checkout succeeds.
- Keep the escape path obvious: **Open** the wedding party for full Wedding Manager review.

## Related Docs

- [Transactions and Fulfillment Orders](TRANSACTIONS_AND_WEDDING_ORDERS.md)
- [Wedding + Counterpoint Cutover Linking](WEDDING_COUNTERPOINT_CUTOVER_LINKING.md)
- [POS Register staff guide](staff/pos-register-cart.md)
- [POS Weddings staff guide](staff/pos-weddings.md)
- [Weddings Back Office staff guide](staff/weddings-back-office.md)
