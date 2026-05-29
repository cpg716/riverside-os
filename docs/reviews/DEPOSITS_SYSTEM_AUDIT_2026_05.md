# Audit Report: Deposits & Liability Ledger Subsystem (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-08
**Version Audited:** v0.85.0
**Auditor:** Devin (AI assistant)
**Scope:** Customer open deposits (party split credits), store credit accounts, gift card liability (load/redeem/credit), fund management integrity, double-entry accounting patterns

---

## 1. Executive Summary

The Deposits subsystem encompasses three distinct liability ledgers — **Open Deposits** (wedding party funds), **Store Credit** (refund/adjustment credits), and **Gift Cards** (paid, loyalty, donated, promo). All three follow a consistent architectural pattern: account upsert → FOR UPDATE lock → balance check → atomic update + ledger INSERT. The implementation is sound and production-ready with proper concurrency control.

**Overall Status:** Production Ready — 0 blockers, 0 significant issues.

---

## 2. Open Deposit Accounts (`customer_open_deposit.rs`)

### 2.1 Purpose
Open deposits hold funds credited to a customer via wedding party group disbursements. When a payer pays for a party member who doesn't yet have an open order, the funds are held in an open deposit account until the member makes a purchase.

### 2.2 Schema
- `customer_open_deposit_accounts` — one row per customer, with `balance` (Decimal) and `updated_at`
- `customer_open_deposit_ledger` — individual entries with `amount`, `balance_after`, `reason`, `transaction_id`, `payer_customer_id`, `payer_display_name`, `wedding_party_id`

### 2.3 Operations

**Credit (Party Split):**
```
credit_party_split(tx, beneficiary_customer_id, amount, payer_id, payer_name, party_id, source_txn_id)
  → skip if amount ≤ 0
  → ensure_account (INSERT ON CONFLICT DO NOTHING + SELECT FOR UPDATE)
  → SELECT balance FOR UPDATE
  → new_bal = balance + amount
  → UPDATE balance
  → INSERT ledger (reason: 'party_split_deposit')
```

**Redemption (Checkout):**
```
apply_checkout_redemption(tx, customer_id, amount, transaction_id)
  → skip if amount ≤ 0
  → ensure_account
  → SELECT balance FOR UPDATE
  → if balance < amount → InsufficientBalance error
  → new_bal = balance - amount
  → UPDATE balance
  → INSERT ledger (amount: -amount, reason: 'checkout_redemption')
```

### 2.4 Strengths
- **FOR UPDATE lock** prevents concurrent balance modifications
- **Account auto-creation** via `INSERT ON CONFLICT DO NOTHING` — no race condition on account creation
- **Ledger amount sign convention** — credits are positive, redemptions are stored as negative in the ledger, maintaining a clear audit trail
- **`balance_after` on every ledger entry** — enables point-in-time balance reconstruction
- **Payer attribution** — the ledger records who paid and from which party, enabling full traceability

### 2.5 Integration with Checkout
During checkout, when `open_deposit` appears as a payment method:
1. Checkout validates `customer_id` is present
2. The split amount is passed to `apply_checkout_redemption`
3. The redemption happens within the checkout's DB transaction — if any subsequent step fails, the balance is rolled back

---

## 3. Store Credit Accounts (`store_credit.rs`)

### 3.1 Purpose
Store credit is used for refund credits, manager adjustments, and other non-purchase credits. Separate from open deposits (which are specifically wedding-related) and gift cards (which are transferable instruments).

### 3.2 Operations

**Checkout Redemption:**
```
apply_checkout_redemption(tx, customer_id, amount, transaction_id)
  → identical pattern to open deposit: ensure_account → lock → check → update → ledger
  → reason: 'checkout_redemption'
```

**Refund Credit:**
```
credit_refund_in_tx(tx, customer_id, amount, transaction_id, reason)
  → validates reason is non-empty
  → ensure_account → lock → new_bal = balance + amount → update → ledger
  → returns new balance (for caller confirmation)
```

**Manual Adjustment:**
```
adjust_balance(pool, customer_id, amount, reason)
  → validates reason non-empty
  → starts own DB transaction
  → ensure_account → lock → new_bal = balance + amount
  → if new_bal < 0 → InsufficientBalance
  → update → ledger → commit
  → returns new balance
```

### 3.3 Strengths
- **Reason required** for all credits and adjustments — prevents undocumented balance changes
- **Negative balance guard** on adjustments — store credit cannot go below zero via manual adjustment
- **Separate error variants** — `NotFound`, `InsufficientBalance`, `ReasonRequired` give callers specific failure context
- **`credit_refund_in_tx`** runs within an external transaction — refund credits are atomic with the return processing

---

## 4. Gift Card Liability (`gift_card_ops.rs`)

### 4.1 Purpose
Gift cards are transferable value instruments with four sub-types:
- `paid_liability` — purchased gift cards (customer paid for the value)
- `loyalty_giveaway` — earned through loyalty program
- `donated_giveaway` — donated by the store
- `promo_gift_card` — promotional cards

### 4.2 Operations

**Redemption:**
```
prepare_redemption_in_tx(tx, code, requested_sub_type, amount)
  → validate amount > 0
  → SELECT card WHERE code = $1 AND status = 'active' AND (not expired) FOR UPDATE
  → validate card exists
  → validate sub_type matches (if requested)
  → validate current_balance ≥ amount
  → compute new_balance and new_status ('depleted' if zero)
  → return GiftCardRedemptionPlan (caller applies)
```

**Credit (Refund):**
```
credit_gift_card_in_tx(tx, code, amount, transaction_id, session_id)
  → validate amount > 0
  → normalize code to uppercase
  → SELECT card FOR UPDATE
  → validate card exists and is active/depleted
  → new_balance = current + amount
  → re-activate if depleted
  → UPDATE balance + status
  → INSERT gift_card_ledger
  → return GiftCardCreditPlan
```

### 4.3 Strengths
- **Expiry enforcement** — `expires_at > now()` on SELECT; expired cards cannot be redeemed
- **Sub-type validation** — prevents using a paid card as loyalty or vice versa, maintaining correct liability classification
- **FOR UPDATE lock** — concurrent redemptions are serialized
- **Prepare/apply pattern** — `prepare_redemption_in_tx` returns a plan that the caller (checkout) applies. This separates validation from mutation.
- **Auto-depletion** — cards with zero balance are marked `depleted`; credit operations can reactivate them
- **Code normalization** — uppercase normalization prevents case-sensitivity mismatches

---

## 5. Cross-Cutting Integrity Patterns

### 5.1 Consistent Architecture
All three subsystems follow the same pattern:
1. **Account upsert** — `INSERT ON CONFLICT DO NOTHING` ensures the account exists
2. **FOR UPDATE lock** — prevents concurrent modifications
3. **Balance check** — validates sufficient funds before deduction
4. **Atomic update** — balance update + ledger entry in one transaction
5. **Ledger trail** — every mutation creates a ledger entry with `balance_after`

### 5.2 Decimal-Only Math
All balance calculations use `rust_decimal::Decimal`:
- `new_bal = balance + amount` / `balance - amount`
- No floating-point in any path
- Ledger amounts stored as `Decimal` in PostgreSQL `numeric` columns

### 5.3 Transaction Boundaries
- **Checkout path**: All three ledger operations happen within the checkout's DB transaction (`tx`). If any downstream step fails (payment recording, inventory update, etc.), all balance changes are rolled back.
- **Standalone operations**: `adjust_balance` (store credit) starts its own transaction for admin adjustments.

### 5.4 Validation at Payment Split Resolution
During `resolve_payment_splits`, the checkout engine validates:
- `store_credit` and `open_deposit` methods require `customer_id` on the checkout
- Gift card payments require a `gift_card_code`
- Gift card sub_type must be valid (`paid_liability`, `loyalty_giveaway`, `donated_giveaway`, `promo_gift_card`)

---

## 6. Comparison with April 2026 Audit

The April audit documented the same architectural patterns. Since then:
- **Gift card sub-types expanded** — `promo_gift_card` has been added as a fourth sub-type
- **Gift card credit/reactivation** — the `credit_gift_card_in_tx` function handles refund-back-to-card scenarios, reactivating depleted cards
- **Open deposit attribution** — `payer_customer_id` and `payer_display_name` on ledger entries provide full traceability for wedding party payments

No regressions detected.

---

## 7. Conclusion

The Deposits subsystem correctly implements three liability ledgers with consistent concurrency control, audit trails, and integration with the checkout engine. The separation between open deposits (wedding-specific), store credit (general), and gift cards (transferable instruments) provides clear accounting boundaries. The `FOR UPDATE` locking pattern prevents double-spend across all three subsystems.

**Status: PRODUCTION READY**
