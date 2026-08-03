# Wedding group pay and returns — operational notes

**Audience:** Register staff and floor managers taking, applying, reprinting, or refunding deposits where **one payer** covers multiple wedding-party members.

## How group pay is stored

Checkout can attach **`wedding_disbursements`**. The payer's tender is recorded once, while each beneficiary amount is either allocated to one exact member Transaction Record through **`payment_allocations`** or held on that member's open-deposit account for a future order. Each member Transaction Record retains its own **`transactions`** and **`transaction_lines`** evidence.

**POS:** Select the payer, then choose **Wedding Deposit** from the Cart toolbar. The guided workspace can select or start a party, link or create customers, assign roles, choose each beneficiary and destination, and review the full allocation before Payment. For equal deposits, enter the per-member amount once and select only the intended beneficiaries; unselected members receive nothing. **Collect & Build Orders** prepares exact member variations, optional alterations, per-member tax treatment, and all-or-individual salesperson attribution as drafts before payer Payment. After approval, one **Create All Member Transactions** action runs each member through the normal atomic checkout path against that member's exact funded source. **Orders & Receipts** on the original payer resumes Deposit Only or parked Builder work and provides individual payer/member receipt reprints.

Party setup selects sellable ROS parent products and marks each as **All**, **Groom Only**, **Groomsmen Only**, **Any**, or role-specific **Other**. Register evaluates those current rules for the selected member before opening the exact variation and pricing panel. **Any** is an optional choice; the other matching rules are expected member items.

Before the first tender, Riverside preflights the payer, party membership, destinations, target balances, and salesperson. Checkout repeats those checks under database locks. A decline creates no payer Transaction Record, allocation, held deposit, booked activity, or receipt. The reviewed Cart allocation remains staged for retry or another tender, while the declined provider attempt remains audit evidence and is not customer money.

### Open deposit when a member has no open transaction

If a disbursement targets a **wedding member** who does **not** yet have an open Transaction Record for allocation, checkout credits that member's **customer** with an open deposit (see **`customer_open_deposit_accounts`** / **`customer_open_deposit_ledger`**, migration **83**). It is not store credit. Selecting that customer in the Register shows the balance and most recent payer; the cashier can then use **Apply $X** on **Pay** for that member's current sale, including in-stock takeaway merchandise. Riverside still blocks the held balance from funding another member's disbursement or an existing-order allocation staged in the same checkout.

The held credit and each redemption retain their exact source workflow, allocation, payer, and originating payment rows. Redemption and the sale commit atomically, while QBO retains the value in deposit liability until fulfillment releases it to revenue. Cancelling a member Transaction Record that used a held source restores the unused value to that same source; it does not send money to a card.

Wedding Hub reports remaining source-tracked funds as **Deposit**, separately from **Applied Payments**. It reports **Paid** only when the linked member Transaction has no current balance due; a held deposit alone never makes the member Paid.

When that member is selected directly in Register, **Part of the Wedding Order?** identifies the party and may disclose the available held source and contributing payer. **Yes — Build Wedding Order** reuses the same parent-item/exact-variation flow as Deposit & Build. It does not redeem the held credit; staff still apply the exact source explicitly in **Pay**. **No — Regular Sale** creates no Wedding or financial write. Changing/removing the Customer clears all unposted Wedding context.

### Wedding Builder variation navigation

When staff choose a parent product, the shared variation panel keeps **Item to Build** and all completed choices visible. **Back** returns one step and remains available on pricing review; selecting a completed choice edits from that point. At the first step, Back returns to Wedding Builder without adding or changing the member item. These controls edit only the nonfinancial draft until the normal server-validated checkout succeeds.

## Return the line on the correct transaction

**Line returns** apply to **`transaction_lines` on that `transaction_id` only.** If the wrong member Transaction Record is selected, return quantity, tax, restock, reporting, and balance evidence will not match the physical item or the customer's account.

- Open the member's Customer account and the Transaction Record that owns the returned line; do not start from only the payer receipt.
- Use the normal itemized return/refund workflow for that one member Transaction Record.
- Verify the member, returned merchandise, tax, refund amount, and named refund recipient before provider dispatch.

## Refunds

There is no batch refund. Process one member allocation at a time from that member's Customer account and Transaction Record.

For **Original Card**, Riverside follows the direct allocation or the source-tracked held-deposit redemption to the exact originating Helcim payment. Staff do not enter or select a Helcim transaction ID. The member Transaction Record remains the refund context for merchandise, tax, reporting, and audit truth, but Helcim returns the money to the **original wedding deposit payer's card**, not to the member. The confirmation and refund receipt name that payer as the recipient, and both the payer and member Customer histories retain the event.

Riverside tracks refundable capacity by member allocation as well as by provider payment. Refunding one member cannot consume another member's share of the same original card charge. Ordinary **Cancel** and same-day **Void** remain blocked for funded wedding deposits and direct member allocations; these actions do not silently move or refund money.

## Related

- Deposit lifecycle and ledger detail: **`docs/DEPOSIT_OPERATIONS.md`**.
- Provider refund safety: **`docs/HELCIM.md`**.
- Staff workflow: **Wedding Manager** and **Register Checkout** in in-app Help.
