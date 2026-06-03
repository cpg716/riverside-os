# Audit Report: POS Payments & Ledger Subsystem (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-08
**Version Audited:** v0.85.5 (commit `cac08918`)
**Auditor:** Devin (AI assistant)
**Scope:** End-to-end trace of `execute_checkout` → payment split resolution → tender persistence → idempotency guard → tax validation → inventory adjustment

---

## 1. Executive Summary

The Payments subsystem remains **robust and production-hardened** since the April audit. The v0.85.0 release has added significant new capabilities (processing/layaway flow, combo SPIFF commission rewards, customer profile discounts, shipping checkout flow, refund checkouts) while maintaining strict financial integrity. The core split resolution engine, idempotency guard, and atomic transaction model are all sound.

**Overall Status:** Production Ready — 2 minor observations, 0 blockers.

---

## 2. Changes Since Last Audit (April 2026)

### 2.1 New Capabilities Identified
- **Processing/Layaway flow** (`is_processing` flag) — two-phase checkout where the first pass creates a `processing` order with `amount_paid = 0`, and a second pass completes payment. Idempotency is correctly handled for both phases.
- **Refund checkout** — negative `total_price` and `amount_paid` for customer refunds. Only `cash` and `card_credit` tenders are allowed as negative splits. Wedding disbursements and order payments are blocked on refund checkouts.
- **Customer profile discount** — automatic percentage discount from the customer record, validated server-side against `profile_discount_percent`. Cannot combine with sale event discounts. Excludes RMS, gift card, and alteration lines.
- **Discount event validation** — supports variant-scoped, category-scoped, and vendor-scoped sale events with time-window enforcement and server-side price verification.
- **Shipping checkout flow** — validates rate quote freshness, includes shipping amount in `sum_expected`, creates `store_shipping_rate_quote` records with expiry checks.
- **Combo SPIFF commission rewards** — `evaluate_combo_incentives` detects multi-product combo purchases and inserts reward commission lines with `Decimal` precision.
- **Takeaway minimum tender validation** — ensures takeaway merchandise is fully paid with cash-equivalent tenders (deposit-like tenders alone cannot satisfy takeaway items).

### 2.2 Idempotency Guard — Enhanced
The idempotency mechanism now operates at two levels:
1. **Pre-insert check** (line 2489): queries `transactions WHERE checkout_client_id = $1` inside the DB transaction, returns `Idempotent` or transitions `processing` → completed.
2. **Unique constraint race** (line 2762): catches `transactions_checkout_client_id_uidx` violation, rolls back, and returns the existing transaction. This handles the narrow race window between pre-check and INSERT.

**Assessment:** This two-layer approach is the gold standard for financial idempotency. No issues found.

### 2.3 Tax Validation — Sound
- Server recalculates `nys_state_tax_usd` and `erie_local_tax_usd` per line using the variant's `TaxCategory` and the charged `unit_price`.
- Tax values from the client are compared within a `$0.02` tolerance (`CHECKOUT_MONEY_TOLERANCE`).
- Tax-exempt checkout requires a non-empty `tax_exempt_reason`.
- RMS payment, gift card load, and alteration service lines are validated to have zero tax.
- Rounding uses `MidpointAwayFromZero` (standard for USD).

**Assessment:** Correctly implements NYS Publication 718-C for Erie County. No issues found.

---

## 3. Architecture Trace

### 3.1 Request → Validation → Atomic Commit
```
API handler (transactions.rs:5396)
  → require_pos_register_session_for_checkout()
  → execute_checkout(pool, http, global_employee_markup, payload)
      → validate cart non-empty
      → resolve_effective_customer_id (customer couples)
      → validate_order_payment_shape
      → validate_checkout_item_quantity (allows negative for returns)
      → validate_checkout_alteration_intakes
      → verify all staff IDs active
      → expand_bundle_checkout_items (parent SKU → components)
      → normalize product_id by variant
      → classify RMS payment collections
      → validate gift card load codes (unique, qty=1)
      → validate customer profile discounts
      → enforce role-based max discount %
      → validate discount events (scope, dates, price match)
      → resolve_payment_splits → Vec<ResolvedPaymentSplit>
      → resolve_checkout_booked_at (backdating)
      → validate store_credit / open_deposit require customer_id
      → validate Helcim payment splits (no duplicate provider IDs)
      → validate_checkout_lines_and_sum (server-calculated total)
      → compare client total_price vs server sum (±$0.02)
      → validate wedding disbursements, order payments, balance_due
      → validate takeaway minimum tender
      → pool.begin() → DB TRANSACTION
          → idempotency pre-check
          → register session FOR UPDATE lock
          → validate order payment targets
          → INSERT transactions
          → INSERT transaction_lines (per item)
          → inventory deductions (takeaway stock)
          → layaway stock reservations
          → gift card load/redemption
          → store credit deduction
          → open deposit credit/redemption
          → payment_transactions INSERT (per split)
          → order payment recalc
          → commission snapshots
          → wedding disbursements
          → weather snapshot
      → tx.commit()
  → post-commit: staff access logs, loyalty accrual, Meilisearch upsert, webhook dispatch
```

### 3.2 Split Resolution Engine
`resolve_payment_splits` (line 1310) normalizes the client payment array:
- Validates each method name (1–50 chars)
- Gift card sub_types restricted to `paid_liability | loyalty_giveaway | donated_giveaway | promo_gift_card`
- Zero-amount splits rejected
- Negative splits only for refund checkouts with cash or card_credit
- `applied_deposit_amount` validated (non-negative, ≤ split amount)
- Gift card code required for gift_card method
- RMS metadata normalized via `pos_rms_charge::normalized_rms_metadata`
- Sum of splits must match `amount_paid` within tolerance

**Assessment:** Comprehensive validation. No path to split-sum mismatch.

---

## 4. Findings

### 4.1 Observation: Repeated `fetch_variant_by_ids` Calls (Performance)
**Severity:** Low (Performance)
**Location:** `transaction_checkout.rs` lines 1816–1870, 1869–1930, 1994–2018, 2079–2093

The same variant is resolved via `inventory::fetch_variant_by_ids` up to 4 times during pre-transaction validation (RMS classification, gift card detection, discount validation, discount event check). Each call is an independent database query.

**Impact:** On a 10-item cart, this could be 40 individual DB round-trips during validation alone — before the transaction even begins.

**Recommendation:** Build a `HashMap<(Uuid, Uuid), ResolvedVariant>` cache at the start of validation and reuse resolved variants. This would reduce validation queries from O(4N) to O(N).

### 4.2 Observation: `amount_paid` Tolerance for Split Sum Validation
**Severity:** Informational
**Location:** `resolve_payment_splits` line ~1462 (split sum vs amount_paid check)

The split sum is compared to `amount_paid` with a `$0.02` tolerance. For a sale with many small splits (e.g., 5 gift cards), the accumulated rounding from `round_dp(2)` on each split could theoretically reach `$0.10`. In practice, this is unlikely with the current tender types but worth monitoring as new payment methods are added.

---

## 5. Strengths Confirmed

1. **Two-layer idempotency** (pre-check + unique constraint fallback) — best practice for financial systems.
2. **Atomic commit** — all mutations (transaction, lines, inventory, payments, commissions) in a single DB transaction with explicit `tx.commit()`.
3. **Server-side price verification** — client-sent prices are re-validated against catalog data; discounts verified against configured limits.
4. **Negative stock allowed** — checkout is never blocked by inventory shortage, with explicit warnings surfaced to the operator.
5. **FOR UPDATE locks** on register session and order payment targets — prevents double-spend and concurrent modification.
6. **Decimal math throughout** — `rust_decimal::Decimal` used exclusively; no floating-point in any financial path.

---

## 6. Conclusion

The Payments subsystem has matured significantly since April. The addition of processing/layaway, refund checkout, customer discounts, and combo SPIFF rewards demonstrates active feature development without compromising financial integrity. The core architecture is sound and production-ready.

**Status: PRODUCTION READY**
