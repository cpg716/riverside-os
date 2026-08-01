# Deposit Operations — Riverside OS

Deposits are the foundational financial mechanism in Riverside OS for all deferred-fulfillment sales. Every time a customer commits to a purchase but does not take home the merchandise that same day, a deposit captures the funds as a **liability** — not revenue — preserving tax and commission accuracy until physical pickup.

This document covers every deposit form the system supports, how the POS register processes them, how they flow through QBO accounting, and the edge cases staff should understand.

---

## Table of Contents

1. [Core Concept: Deposits Are Liabilities](#core-concept-deposits-are-liabilities)
2. [Deposit Types](#deposit-types)
3. [POS Register: How to Take a Deposit](#pos-register-how-to-take-a-deposit)
4. [Split Deposit (Wedding Group Pay)](#split-deposit-wedding-group-pay)
5. [Open Deposits (Pre-Paid Member Credits)](#open-deposits-pre-paid-member-credits)
6. [Deposit-Only Completion (No Tenders)](#deposit-only-completion-no-tenders)
7. [Mixed Carts (Takeaway + Deferred Items)](#mixed-carts-takeaway--deferred-items)
8. [Interim Payments on Open Transactions](#interim-payments-on-open-transactions)
9. [Transaction Release at Fulfillment](#transaction-release-at-fulfillment)
10. [Deposit Forfeiture](#deposit-forfeiture)
11. [QBO Journal Accounting](#qbo-journal-accounting)
12. [Key Source Files](#key-source-files)

---

## Core Concept: Deposits Are Liabilities

When a customer pays a deposit, Riverside OS records the money as **`liability_deposit`** — unearned revenue. The store has the cash, but it has not yet delivered the goods. This distinction matters for:

- **Sales Tax**: NYS tax is due when the customer takes possession, not when they pay. Recognizing deposits as revenue prematurely would create incorrect tax filings.
- **Commissions**: Staff commissions are earned on **fulfilled** sales. A deposit does not trigger a payout.
- **Reporting**: Deposits appear in "Booked Sales" metrics for volume tracking but are **excluded** from revenue, tax, and commission reports until fulfillment.

See [`BOOKED_VS_FULFILLED.md`](BOOKED_VS_FULFILLED.md) for the full recognition model.

---

## Deposit Types

| Type | Transaction Context | When Used | Minimum |
|------|--------------|-----------|---------|
| **Layaway Deposit** | In-stock items held on a layaway shelf | Customer reserves floor merchandise for future pickup | 25% of sale total (admin override allowed) |
| **Order Deposit** | Items not yet in stock; must be procured | Customer commits to purchasing items the store will order from a vendor | Store policy (typically 50%) |
| **Wedding Transaction Deposit** | Special order tied to a wedding party + event date | Groom, groomsmen, or sponsor commits to formalwear orders | Store policy |
| **Split Deposit** | Wedding group pay across multiple party members | One payer covers deposits for several members in a single transaction | Per-member amount entered at register |
| **Open Deposit** | Credit held on a customer account (not store credit) | Group pay disbursement targets a member with no open transaction yet | Exact disbursement amount |

---

## POS Register: How to Take a Deposit

### Step-by-Step

1. **Build the cart** with the items the customer is ordering.
2. **Select the mode** from the toolbar: **Layaway**, **Order**, or **Wedding**.
3. **Attach a customer** (required for all deferred-fulfillment transactions).
4. Tap **Pay** / **Complete Sale** to open the **Payment Ledger** drawer.
5. On the keypad, type the amount the customer will pay today (e.g., `100` for $100.00).
6. Apply the customer's tender normally, or tap **Apply deposit** first when you want the ledger to set a specific deposit target before taking the tender.
7. Riverside treats any money paid toward an Order, Layaway, Custom, or Wedding transaction before pickup/fulfillment as a deposit liability even when **Apply deposit** was not tapped.
8. If the cart also has takeaway merchandise, cover the takeaway amount with real tender first; only the remaining paid amount on deferred items is treated as deposit.
9. When the balance reaches `$0.00` for the amount being collected today, the green **Complete Sale** button activates.
   - **Checks**: When selecting the **CHECK** tab, you MUST enter the **Check #** in the provided field before applying the payment to ensure accurate transaction tracking.
10. Finalize and print the receipt.

### Ledger Breakdown (Financial Truth)

The Payment Ledger drawer (NexoCheckoutDrawer) provides a hyper-accurate "Revenue Protocol" breakdown:
- **Net Retail Subtotal**: The sum of all item retail prices (excluding tax/shipping).
- **Shipping & Logistics**: Broken out explicitly for audit clarity.
- **State Tax (NYS) / Local Tax (Erie)**: Displayed as separate shards to ensure authority compliance.
- **Grand Total**: The comprehensive sum of the entire transaction.

### What Happens Behind the Scenes

- Explicit deposit targets are sent to the server as `applied_deposit_amount`; if staff only apply a normal payment, the server calculates the deposit portion from the deferred items and open balance.
- The server records the tender (e.g., credit card $100) and tags the deferred portion with deposit metadata.
- The transaction is created with status `booked` / `order_placed`.
- The $100 goes to `liability_deposit` in the ledger — **not** revenue.
- The remaining balance (e.g., $115.33 on a $215.33 sale) stays as the customer's open balance due on the transaction.

---

## Wedding Deposit Disbursement

For weddings, a single payer (often the groom or sponsor) can cover deposits for multiple party members in one transaction.

### How It Works

1. Select the paying customer and choose **Wedding Deposit** from the Cart toolbar.
2. Choose the workflow first: **Deposit Only** proceeds directly to payer Payment, while **Collect & Build Orders** builds every funded member's item draft before payer Payment.
3. Choose an existing party or start one with Party Name and Wedding Date. The payer must be linked to the party with a role before Payment.
4. Link existing customer accounts or create customers and assign member roles inline.
5. Select each beneficiary and amount, then explicitly choose `held_for_future_order` or `existing_transaction` with one exact target Transaction Record. A selected `$0` member is visibly excluded and does not block other funded members; enter an amount to include that member.
6. Review the chosen workflow, payer, party, funded members, destinations, amounts, total, and deposit salesperson before continuing.
7. In **Collect & Build Orders**, choose **Start Building Member Orders**. Riverside preserves any merchandise already staged for the payer and its salesperson attribution, then selects each funded member in sequence before showing payer Payment. The deposit salesperson is captured separately. Employee-price payer merchandise is permitted in the combined checkout, remains noncommissionable, and does not inherit the deposit salesperson. Add items from the Wedding Checklist or product search, mark deferred lines **Order (Wedding)**, visibly confirm that member's salesperson, and choose **Save Member Order & Next**. Each save is a nonfinancial draft only: it creates no Transaction Record, deposit, payment allocation, booked activity, or receipt.
8. After every funded member draft is saved, Riverside returns to the payer, restores the payer's merchandise, and shows **Collect & Build · Final Review**. Choose **Final Payment** once. The payer Transaction and receipt include the payer's merchandise while separately reporting the party-member deposit allocations. Before the first tender, `/api/weddings/deposit-workflows/preflight` rechecks membership, payer ownership, open target status, and current balance. Checkout revalidates the same financial facts under database locks.
9. Only an approved tender followed by successful atomic checkout creates the payer Transaction, payment allocations, held credits, workflow audit records, and booked activity. A declined card creates none of those records; the reviewed allocations and member drafts remain staged for retry or another tender, while the declined provider attempt remains in Payments Health.
10. After the approved payer receipt, **Continue Wedding Orders** loads the first reviewed member draft and automatically attaches its exact source-tracked held deposit. Only that member's successful **Complete Sale / Record Sale** atomic checkout creates the member Transaction Record and redeems the held source; it does not collect a second payer tender, and a failed checkout rolls the member writes back.
11. After each member receipt, **Continue Wedding Orders** loads the next reviewed draft without a posted Transaction Record. When no unposted funded member remains, Riverside shows the payer-centered **Orders & Receipts** dashboard. Staff may also resume later through the original payer's **Wedding Deposit → Orders & Receipts** entry and view or print payer/member receipts there.
12. Removing or changing the selected Customer, or explicitly clearing the active sale, clears the linked Wedding member banner and all unposted Collect & Build context. Stale Wedding context never carries into another Customer's Cart.

There is no batch-refund operation. Refunds are handled one member allocation at a time from that member's Customer account and Transaction Record. For an original-card refund, Riverside follows the direct allocation or source-tracked held-deposit redemption back to the exact original Helcim payment. The member Transaction remains the refund context, but the money returns to the original wedding deposit payer's card—not to the member. Both Customer histories record the event, and the refund receipt identifies the original payer as the recipient.

Funded wedding deposits—and member Transaction Records that received a direct allocation—cannot be cancelled or same-day voided through the ordinary Transaction actions. Riverside blocks those paths without changing any ledger record because funds may already be posted, redeemed, returned, or fulfilled. Use the member's normal itemized return/refund workflow for a posted deposit. Cancelling a member Transaction that used a still-held source returns that credit to its exact held source; it does not send money to a card.

In shared **Orders** views, Wedding orders should still show their linked party and member context so staff know the balance belongs to the wedding workflow and not a generic customer order.
Even when a Wedding order shows a deposit on ledger or a zero balance, pickup release should still stay with the linked member workflow until receiving and readiness are confirmed.

### Backend Handling

- The checkout payload includes `wedding_disbursements[]`, each with `wedding_member_id`, `amount`, `destination_kind`, and an exact `target_transaction_id` when posting directly.

- `wedding_deposit_workflows` anchors the batch to the payer Transaction, customer, party, register session, operator, and salesperson. `wedding_deposit_workflow_allocations` records each beneficiary and declared destination without replacing the authoritative payment and deposit ledgers.
- For direct posting, the server creates **`payment_allocation`** rows linking the payer's tender to the exact beneficiary Transaction Record.
- If a disbursement targets a member who does **not** yet have an open transaction, the funds are credited to the member's **open deposit account** (see below).
- Held credits are source-tracked through `customer_open_deposit_source_events`, so redemption and cancellation restoration remain tied to the exact payer batch instead of an undifferentiated account balance.
- Held-credit redemption also records the exact originating `payment_transactions` rows. A later member refund can therefore use the proper Helcim transaction ID and original payer identity without asking staff to enter either value.
- Disbursement amounts are validated: they must be positive, cannot exceed an exact target's live balance, and their sum cannot exceed the amount collected.
- The payer's own Transaction total remains lines plus shipping. Daily Sales and Customer History report wedding contributions separately so the full tender is auditable without treating member deposits as payer merchandise revenue.
- Payer receipts list every beneficiary and destination. Member receipts identify the payer and party for both direct allocations and later held-credit redemption.
- Individual refund receipts state that the refund went to the original wedding deposit payer. The refund payment allocation stays attached to the member Transaction for item, tax, reporting, and audit truth.

---

## Open Deposits (Pre-Paid Member Credits)

When a group pay disbursement targets a wedding member who has no open order row to allocate against, the system creates an **open deposit** on that member's customer record.

- Stored in: `customer_open_deposit_accounts` / `customer_open_deposit_ledger` (migration **83**).
- **Not** the same as store credit — open deposits are earmarked for a specific future purchase.
- When staff select that customer in the Register, Riverside immediately shows a **Wedding deposit available** notice with the held balance and the most recent payer name when available.
- The **Pay** screen keeps the held balance visible and provides **Apply $X**. The amount is capped to the selected member's current sale balance.
- The held deposit can pay the selected member's in-stock takeaway merchandise. It cannot pay another party disbursement or an existing-order allocation staged in the same checkout.
- Applying the balance creates an `open_deposit` payment line and an atomic negative `checkout_redemption` ledger entry tied to the new Transaction Record. A failed checkout rolls both back, and the locked account balance prevents reuse or overspending.
- If that Transaction Record is cancelled without forfeiture or voided, Riverside atomically restores the held amount to the member's open-deposit account, records a restoration ledger entry, and excludes it from any cash-refund queue.
- The server excludes a new `deposit_ledger` commitment from takeaway coverage. A redeemed `open_deposit` is held money and counts toward the selected customer's takeaway coverage.
- QBO keeps the redeemed amount in **Deposit liability** while the sale is unfulfilled. On fulfillment, the held amount is included in the deposit release that debits the liability and credits recognized revenue.

---

## Deposit-Only Completion (No Tenders)

In certain scenarios, a cashier may record a deposit commitment **without** collecting any money at the register today. This is the "deposit-only" path:

### When It's Allowed

- The cart contains **only** order / wedding order lines (no takeaway items).
- `allowDepositOnlyComplete` is `true` (set automatically by Cart.tsx when these conditions are met).
- The cashier enters a deposit amount via **Apply deposit** but does **not** apply any cash/card tenders.

### How It Works

- The server receives a synthetic `deposit_ledger` payment split with the committed amount.
- No real money changes hands at the register — the deposit is a recorded commitment.
- The transaction is created with the deposit on the ledger, and the customer's balance reflects the full amount still owed.

### When It's **Not** Allowed

- If the cart contains any **takeaway** items (`takeawayDueCents > 0`), real tenders must cover at least the takeaway portion. The customer cannot walk out with merchandise on a ledger-only deposit.

---

## Mixed Carts (Takeaway + Deferred Items)

A single cart can contain both immediate-pickup (takeaway) items and deferred-fulfillment (order) items. The deposit logic handles this with a split calculation:

| Component | Paid by | Example |
|-----------|---------|---------|
| Takeaway items + their tax | Real tenders (card/cash) or the selected customer's held wedding deposit | $50 sweater taken home today |
| Deposit on deferred items | Real tenders or deposit ledger | $100 deposit on a $200 order suit |

The **Balance remaining** in the payment ledger reflects: `deposit amount + takeaway total - tenders applied`.

The cashier must apply tender or the selected customer's held wedding deposit to cover the takeaway goods, plus any requested new deposit. The deposit-only (no-tender) path is blocked when takeaway items are in the cart.

---

## Interim Payments on Open Transactions

After the initial deposit, customers return to make additional payments toward their balance:

1. Navigate to **Customers** in the Back Office or POS.
2. Find the customer → open their **Transactions** tab.
3. Select the open transaction → tap **Make Payment**.
4. Enter the payment amount and tender it.
5. Each interim payment is also recorded as `liability_deposit` — revenue is still deferred.
6. When the balance reaches `$0.00`, the transaction is ready for fulfillment / pickup.

---

## Transaction Release at Fulfillment

When the customer picks up their merchandise, the deposit liability is **released** (converted to revenue):

### Trigger
- The cashier completes the final payment (if any balance remains) and toggles **Pickup Confirmed** in the checkout drawer.
- The transaction status transitions to `fulfilled`.

### Accounting (QBO Journal)
- **Debit**: `liability_deposit` (reduces the liability on the balance sheet).
- **Credit**: `revenue_category` (recognizes the sale as income).
- **Credit**: `tax_payable` (NYS sales tax is now due).
- Staff commissions are calculated and recorded based on this fulfillment date.

The QBO Daily Staging Journal uses `applied_deposit_amount` metadata from the payment splits to compute the exact release amount per category.

---

## Transaction Forfeiture

If a customer abandons a layaway or cancels a transaction:

1. A manager cancels the transaction with reason **Forfeited**.
2. Inventory reservations are released (`on_layaway` or `reserved` stock decremented).
3. The deposit liability is reclassified:
   - **Debit**: `liability_deposit` (remove the liability).
   - **Credit**: `income_forfeited_deposit` (recognize the forfeited deposit as income).
4. **No refund** is issued to the customer.
5. Both QBO mappings (`liability_deposit` and `income_forfeited_deposit`) must be configured in **Settings → QBO Bridge** for the journal entry to post correctly.

---

## QBO Journal Accounting

Riverside OS generates a daily balanced journal by tracking payments against fulfillment status.

**Taking a $100 deposit (New Inflow):**
| Account | Debit | Credit |
|---------|-------|--------|
| Cash / Card Clearing | $100.00 | |
| `liability_deposit` | | $100.00 |

Direct layaway cash/card deposits follow this same new-inflow path on the payment date. They are visible in QBO staging as deposit liability and drilldown evidence immediately, while merchandise revenue, tax, COGS, and inventory relief remain deferred until pickup/fulfillment.

**Fulfillment (releasing $250 sale with $100 prior deposit + $150 final payment):**
| Account | Debit | Credit |
|---------|-------|--------|
| Cash / Card Clearing | $150.00 | |
| `liability_deposit` | $100.00 | |
| Revenue — Category | | $231.67 |
| Tax Payable — State | | $9.20 |
| Tax Payable — Local | | $9.13 |

**Forfeiture of $100 deposit:**
| Account | Debit | Credit |
|---------|-------|--------|
| `liability_deposit` | $100.00 | |
| `income_forfeited_deposit` | | $100.00 |

---

## Key Source Files

| File | Role |
|------|------|
| `client/src/components/pos/NexoCheckoutDrawer.tsx` | Payment ledger UI: keypad, Apply deposit, Apply payment, balance calculation, deposit-only completion, Revenue Protocol summary |
| `client/src/components/pos/Cart.tsx` | Cart orchestration: `executeCheckout`, `allowCheckoutDepositKeypad`, disbursement members, open deposit prompt |
| `server/src/logic/transaction_checkout.rs` | Backend checkout: payment split parsing, `applied_deposit_amount` validation, `deposit_ledger` / `open_deposit` handling, wedding disbursement allocation |
| `server/src/logic/qbo_journal.rs` | QBO journal: `liability_deposit` debit on release, `income_forfeited_deposit` on forfeiture, category-level release aggregation |
| `docs/BOOKED_VS_FULFILLED.md` | Revenue recognition model (booked vs fulfilled dates) |
| `docs/LAYAWAY_OPERATIONS.md` | Layaway-specific lifecycle and inventory impact |
| `docs/TRANSACTIONS_AND_WEDDING_ORDERS.md` | Transaction/fulfillment order lifecycle and inventory impact |
| `docs/WEDDING_GROUP_PAY_AND_RETURNS.md` | Group pay disbursement, open deposits, return/refund on member transactions |

---

*Last updated: 2026-07-31*
