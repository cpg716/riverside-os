# POS void transactions

**Audience:** Managers, leads, and trained cashiers.

**Where in ROS:** POS mode -> **Reports** -> **Daily Sales** -> Activity row -> **Void**.

**Related permissions:** Cashier must be working from an open register session. The action requires **Manager Access** and the refund-processing permission for the signed-in staff context.

---

## What a void means

A completed-sale void is not a delete. ROS keeps the original Transaction Record, receipt references, payments, timestamps, cashier, customer history, and audit feed. The void adds a permanent record that explains who approved it, why it happened, what tender reversal is owed, and whether inventory was restocked.

Use a completed-sale void only when the original sale should no longer count as a sale and the reversal needs to stay traceable for register close, reporting, QBO, RMS, and customer history.

## Voids vs. Refunds: The Settlement Boundary

Voids and refunds handle transaction reversals differently based on whether the payment has settled:

* **Voids (Unsettled Transactions)**: A void cancels a transaction before it settles. This is only possible **before the daily Helcim card batch closeout** (end of business day). Voiding cancels the temporary bank hold, and the transaction is removed from the customer's pending card statement without money moving.
* **Refunds (Settled Transactions)**: Once the daily batch is closed and sent for settlement, a void is technically impossible. The system disables the "Void" option and forces a **Refund** workflow. Refunds issue a credit back to the settled charge, which takes 2–3 business days to post to the card holder.

## Digital Ledger Flow (Reversal Steps)

When you click **Void** on the POS UI, the system executes these three phases:

1. **Payment Reversal (Helcim API)**: Sends a 'Void' command to Helcim to release the hold on card transactions.
2. **Local Ledger Reversal**: Updates the transaction status to `'voided'` and zeroes out net sales.
3. **Audit History & Customer Profile**: A permanent audit log of the void (identifying the manager who authorized it and the reason) is written and displayed on the **Customer's Profile Timeline**.
4. **Inventory Reintegration**: Takeaway items are automatically returned to Stock on Hand (SOH).

## Register & Tender Management

To ensure financial auditability, initiating a void automatically opens the **Register Overlay** to manage the tender reversal (Credit Card release, Cash out, or Check cancellation). This guarantees that drawer totals and register sessions reconcile perfectly at the end of the day.

## Before approving

Manager confirms:

1. **Unsettled Status**: The transaction is from the current day and the card batch has not yet settled (otherwise, use Refund).
2. **Identity & Authorization**: Manager enters their Access PIN to authenticate the override.
3. **Specific Reason**: A clear, descriptive reason is entered for the audit trail.
4. **Drawer Integration**: Confirm the Register Drawer is open to record cash/check tender adjustments.

## Void a completed sale

1. Go to POS -> **Reports**.
2. Under **Daily Sales**, find the completed transaction in the Activity listing.
3. Verify that the transaction is unsettled (the **Void** button will be active).
4. Tap **Void**. This will launch the Register Overlay.
5. Enter a detailed reason for the void.
6. Verify the manager identity and enter your **Access PIN**.
7. Complete the tender adjustments in the Register overlay.
8. Verify that the void event shows up on the customer's activity timeline.

---

## See also

- [pos-reports.md](pos-reports.md)
- [pos-register-cart.md](pos-register-cart.md)
- [abstracts/returns-refunds-exchanges.md](abstracts/returns-refunds-exchanges.md)
- [qbo-bridge.md](qbo-bridge.md)
- [../TRANSACTION_RETURNS_EXCHANGES.md](../TRANSACTION_RETURNS_EXCHANGES.md)

**Last reviewed:** 2026-06-03
