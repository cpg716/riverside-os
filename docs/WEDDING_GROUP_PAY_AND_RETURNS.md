# Wedding Registry: Group Pay and Returns — Operational Notes

**Audience:** Floor staff and managers reconciling cases where **one payer** covers multiple **member transactions** (disbursements) and handling subsequent **returns** or **refunds**.

## How Group Pay is Structured

At checkout, the system can attach **`wedding_disbursements`**. The payment is allocated from the payer’s primary transaction to beneficiary member transactions via **`payment_allocation`** entries. Each member retains their own internal **`transaction`** record for accounting and logistical purposes.

**POS Workflow:** 
1. From the **Payment Ledger** (Checkout Drawer), selecting **Configure Split Payer** opens the **Wedding Registry** in selection mode.
2. Alternatively, from the **Wedding Registry** tab, select a party and tap **Enter Group Pay**.
3. Select the members whose balances are being covered.
4. Their balances are added to the cart as **Disbursements**.
5. Use this workflow when one person is paying for deposits or final balances for several members at once.

### Open Deposit Account (Pre-Paid Credits)

If a disbursement targets a **wedding member** who does **not** yet have an active transaction for allocation, the system credits that member’s account with an **Open Deposit**. 

*   This is **not** store credit; it is a specific prepayment held on their registry account.
*   When that member later starts their own sale, the register will automatically prompt to apply this held deposit.
*   See **`docs/DEPOSIT_OPERATIONS.md`** for more on open deposits.

## Handling Returns on Registry Transactions

**Line Returns** apply strictly to the specific items on a given transaction. To process a return correctly:

1. Identify the specific **Member Transaction** that owns the item (do not use the payer's transaction unless they are the same person).
2. Process the return via the **Returns & Exchanges** workflow.
3. The system will automatically update the individual member's balance and restock the inventory.

## Refunds

Refunds are processed against the transaction where the payment was originally allocated. For complex "sponsored" payments:
*   Use the **Transaction History** to identify the original allocation.
*   Process the refund to the original tender used by the payer.
*   The system will automatically restore the balance due to the beneficiary member's account.

## Related Documentation

- Revenue Recognition: **`docs/REPORTING_BOOKED_AND_RECOGNITION.md`**
- Register Dashboard: **`docs/REGISTER_DASHBOARD.md`**
- Staff Manual: **`docs/staff/pos-wedding-registry.md`**
