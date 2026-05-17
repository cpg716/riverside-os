# POS void transactions

**Audience:** Managers, leads, and trained cashiers.

**Where in ROS:** POS mode -> **Reports** -> **Daily Sales** -> Activity row -> **Void**.

**Related permissions:** Cashier must be working from an open register session. The action requires **Manager Access** and the refund-processing permission for the signed-in staff context.

---

## What a void means

A completed-sale void is not a delete. ROS keeps the original Transaction Record, receipt references, payments, timestamps, cashier, customer history, and audit feed. The void adds a permanent record that explains who approved it, why it happened, what tender reversal is owed, and whether inventory was restocked.

Use a completed-sale void only when the original sale should no longer count as a sale and the reversal needs to stay traceable for register close, reporting, QBO, RMS, and customer history.

## Before approving

Manager confirms:

1. The transaction is the correct customer, date, amount, and receipt.
2. The reason is specific enough for later review.
3. The tender reversal is clear: cash, card, split tender, gift card, store credit, or no refund due.
4. Any card outcome is known. Do not retry or void around an uncertain provider result.
5. Inventory impact is understood. Takeaway fulfilled items may restock; order-style fulfillment does not silently put stock back.
6. Wedding, deposit, RMS Charge, or open balance context is understood before proceeding.

## Void a completed sale

1. POS -> **Reports**.
2. In **Daily Sales**, find the completed transaction in Activity.
3. Confirm customer, amount, tender, and timestamp.
4. Tap **Void**.
5. Read the impact list in the modal.
6. Enter a clear reason.
7. Manager selects their identity and enters their **Access PIN**.
8. Confirm the completion message:
   - **Refund workflow opened** means money still needs to be returned through the refund process.
   - **No refund balance remains** means the transaction was already unpaid or fully refunded.

## After the void

Do not treat the void as finished until the reversal state is resolved.

- Cash refunds are paid from the drawer through the refund flow.
- Card refunds use the Helcim refund path when original provider evidence exists.
- Gift-card refunds credit the selected gift card.
- Store-credit refunds credit the customer's store credit ledger.
- Split tenders keep the tender breakdown visible for reconciliation.
- Loyalty accrual is reversed when applicable.

## Reconciliation review

At close or daily review, manager checks:

- void reason and manager approver
- refund queue status
- refund tender evidence
- restock impact
- customer-facing receipt/history expectations
- QBO staging warnings or revision rows
- RMS/R2S follow-up if the transaction touched RMS Charge

## When to stop and escalate

- Card or Helcim status is unclear.
- Customer wants a different refund tender than store policy allows.
- The transaction includes wedding group payments, deposits, RMS Charge, or partially fulfilled items and the correct reversal is not obvious.
- The void modal or refund processor fails.
- The transaction already has confusing refund history.

---

## See also

- [pos-reports.md](pos-reports.md)
- [pos-register-cart.md](pos-register-cart.md)
- [abstracts/returns-refunds-exchanges.md](abstracts/returns-refunds-exchanges.md)
- [qbo-bridge.md](qbo-bridge.md)
- [../TRANSACTION_RETURNS_EXCHANGES.md](../TRANSACTION_RETURNS_EXCHANGES.md)

**Last reviewed:** 2026-05-17
