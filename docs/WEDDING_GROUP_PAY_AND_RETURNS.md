# Wedding group pay and returns — operational notes

**Audience:** floor managers reconciling **one payer** covering multiple **member orders** (disbursements) when a **line return** or **refund** happens.

## How group pay is stored

Checkout can attach **`wedding_disbursements`**: the register payment is allocated from the payer’s transaction to beneficiary orders via **`payment_allocation`** rows. Each member order has its own **`orders`** row and **`order_items`**.

**POS:** From the **payment ledger**, **Split deposit (wedding party)** opens **`WeddingLookupDrawer`** in **group pay** mode after you pick a party (same flow as **Wedding** → party → **Enter Group Pay**). Use it when splitting deposits or payouts across members before **Complete Sale**.

### Open deposit when a member has no open order

If a disbursement targets a **wedding member** who does **not** yet have an **open** order row for allocation, checkout **credits** that member’s **customer** with an **open deposit** (see **`customer_open_deposit_accounts`** / **`customer_open_deposit_ledger`**, migration **83**). It is not store credit; it is held until a later sale where the cashier applies tender **`open_deposit`** (or the balance is adjusted operationally). See **`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`** (payment ledger / checkout rules).

## Return the line on the correct order

**Line returns** (`POST /api/orders/{id}/returns`) apply to **`order_items` on that `order_id` only.** If the wrong member order is selected, return quantity and restock flags will not match the physical item or the customer’s balance story.

- In **Back Office → Orders**, open the order that actually owns the line (member order), not only the payer’s receipt context.
- After returns, **`recalc_order_totals`** runs per order; verify **balance due** on each linked member order if something looks off.

## Refunds

Refunds are processed against the **target order** with **`payment_allocations`** to that order. Complex cross-member refund routing is not automated: use **Orders** + **refund queue** with the order that received the allocation you intend to reverse.

## Related

- Disbursement rules: **`AGENTS.md`** (Wedding Group Payments).
- POS exchange flow: **`client/src/components/pos/PosExchangeWizard.tsx`** (wizard copy references this scenario).
