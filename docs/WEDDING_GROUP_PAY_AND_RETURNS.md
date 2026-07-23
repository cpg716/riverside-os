# Wedding group pay and returns — operational notes

**Audience:** floor managers reconciling **one payer** covering multiple **member transactions** (disbursements) when a **line return** or **refund** happens.

## How group pay is stored

Checkout can attach **`wedding_disbursements`**: the register payment is allocated from the payer’s transaction to beneficiary transactions via **`payment_allocation`** rows. Each member transaction has its own **`transactions`** row and **`transaction_lines`**.

**POS:** From the **payment ledger**, **Split deposit (wedding party)** opens **`WeddingLookupDrawer`** in **group pay** mode after you pick a party (same flow as **Wedding** → party → **Enter Group Pay**). Use it when splitting deposits or payouts across members before **Complete Sale**.

### Open deposit when a member has no open transaction

If a disbursement targets a **wedding member** who does **not** yet have an **open** transaction row for allocation, checkout **credits** that member’s **customer** with an **open deposit** (see **`customer_open_deposit_accounts`** / **`customer_open_deposit_ledger`**, migration **83**). It is not store credit. Selecting that customer in the Register shows the balance and most recent payer; the cashier can then use **Apply $X** on **Pay** for that member's current sale, including in-stock takeaway merchandise. Riverside still blocks the held balance from funding another member's disbursement or an existing-order allocation staged in the same checkout. Redemption and the sale commit atomically, while QBO retains the value in deposit liability until fulfillment releases it to revenue.

## Return the line on the correct transaction

**Line returns** (`POST /api/transactions/{id}/returns`) apply to **`transaction_lines` on that `transaction_id` only.** If the wrong member transaction is selected, return quantity and restock flags will not match the physical item or the customer’s balance story.

- In **Back Office → Transactions**, open the transaction that actually owns the line (member transaction), not only the payer’s receipt context.
- After returns, **`recalc_transaction_totals`** runs per transaction; verify **balance due** on each linked member transaction if something looks off.

## Refunds

Refunds are processed against the **target transaction** with **`payment_allocations`** to that transaction. Complex cross-member refund routing is not automated: use **Transactions** + **refund queue** with the transaction that received the allocation you intend to reverse.

## Related

- Disbursement rules: **`AGENTS.md`** (Wedding Group Payments).
- POS exchange flow: **`client/src/components/pos/PosExchangeWizard.tsx`** (wizard copy references this scenario).
