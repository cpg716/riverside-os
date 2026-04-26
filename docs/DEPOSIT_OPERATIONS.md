# Deposit Operations — Riverside OS

**Status:** Canonical deposit, open-deposit, release, and forfeiture reference. For the full transactions doc map, start at [`TRANSACTIONS.md`](TRANSACTIONS.md).

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
| **Split Deposit** | Wedding group pay across multiple party members | One payer covers deposits for several members in a single transaction | Per-member balance from the party |
| **Open Deposit** | Credit held on a customer account (not store credit) | Group pay disbursement targets a member with no open transaction yet | Exact disbursement amount |

---

## POS Register: How to Take a Deposit

### Step-by-Step

1. **Build the cart** with the items the customer is ordering.
2. **Select the mode** from the toolbar: **Layaway**, **Order**, or **Wedding**.
3. **Attach a customer** (required for all deferred-fulfillment transactions).
4. Tap **Pay** / **Complete Sale** to open the **Payment Ledger** drawer.
5. On the keypad, type the amount the customer will pay today (e.g., `100` for $100.00).
6. Tap the amber **Apply deposit** button (below the green **Apply payment** button).
7. The **Balance remaining** display instantly recalculates to show the deposit amount as the target to pay today — **not** the full sale total.
8. Now use the keypad again and tap **Apply payment** via the customer's chosen tender (credit card, cash, etc.) to fulfill the deposit amount.
   - **Checks**: When selecting the **CHECK** tab, you MUST enter the **Check #** in the provided field before applying the payment to ensure accurate transaction tracking.
9. When the balance reaches `$0.00`, the green **Complete Sale** button activates.
10. Finalize and print the receipt.

### Ledger Breakdown (Financial Truth)

The Payment Ledger drawer (NexoCheckoutDrawer) provides a hyper-accurate "Revenue Protocol" breakdown:
- **Net Retail Subtotal**: The sum of all item retail prices (excluding tax/shipping).
- **Shipping & Logistics**: Broken out explicitly for audit clarity.
- **State Tax (NYS) / Local Tax (Erie)**: Displayed as separate shards to ensure authority compliance.
- **Grand Total**: The comprehensive sum of the entire transaction.

### What Happens Behind the Scenes

- The deposit amount is sent to the server as `applied_deposit_amount` on the first payment split.
- The server records the tender (e.g., credit card $100) and tags it with the deposit metadata.
- The transaction is created with status `booked` / `order_placed`.
- The $100 goes to `liability_deposit` in the ledger — **not** revenue.
- The remaining balance (e.g., $115.33 on a $215.33 sale) stays as the customer's open balance due on the transaction.

---

## Split Deposit (Wedding Group Pay)

For weddings, a single payer (often the groom or sponsor) can cover deposits for multiple party members in one transaction.

### How It Works

1. From the **Payment Ledger**, tap the blue **Split deposit (wedding party)** button.
2. This opens the **Wedding Lookup Drawer** in group pay mode.
3. Select the wedding party and choose which members to include.
4. Each member's `balance_due` is added to the cart total as a **disbursement**.
5. Return to the payment ledger — the total now includes all member balances.
6. Apply tenders to cover the combined amount and complete the sale.

In shared **Orders** views, Wedding orders should still show their linked party and member context so staff know the balance belongs to the wedding workflow and not a generic customer order.
Even when a Wedding order shows a deposit on ledger or a zero balance, pickup release should still stay with the linked member workflow until receiving and readiness are confirmed.

### Backend Handling

- The checkout payload includes `wedding_disbursements[]`, each with a `wedding_member_id` and `amount`.

- The server creates **`payment_allocation`** rows linking the payer's tender to each beneficiary member's transaction.
- If a disbursement targets a member who does **not** yet have an open transaction, the funds are credited to the member's **open deposit account** (see below).
- Disbursement amounts are validated: they cannot be negative, and their sum cannot exceed the amount collected.

---

## Open Deposits (Pre-Paid Member Credits)

When a group pay disbursement targets a wedding member who has no open order row to allocate against, the system creates an **open deposit** on that member's customer record.

- Stored in: `customer_open_deposit_accounts` / `customer_open_deposit_ledger` (migration **83**).
- **Not** the same as store credit — open deposits are earmarked for a specific future purchase.
- When the member later comes in and their transaction is created, the cashier is **prompted automatically** at checkout: *"A party member paid a deposit held on this account ($X available). Apply it to this sale?"*
- If accepted, the open deposit is applied as an `open_deposit` tender line, reducing the amount the member owes.
- The server treats `deposit_ledger` and `open_deposit` payment methods as non-real-tender (excluded from `tender_sum_excluding_deposit_like` in checkout validation).

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
| Takeaway items + their tax | Real tenders (card/cash) | $50 sweater taken home today |
| Deposit on deferred items | Real tenders or deposit ledger | $100 deposit on a $200 order suit |

The **Balance remaining** in the payment ledger reflects: `deposit amount + takeaway total - tenders applied`.

The cashier must tender enough to cover both the takeaway goods **and** the requested deposit. The deposit-only (no-tender) path is blocked when takeaway items are in the cart.

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

*Last updated: 2026-04-11*
