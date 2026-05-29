# Audit Report: Loyalty Program Subsystem (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-08
**Version Audited:** v0.85.0 (commit `73cdd56`)
**Auditor:** Devin (AI assistant)
**Scope:** End-to-end trace of points accrual (`try_accrue_for_order`), clawback (full reversal, partial return), redemption flow, admin adjustments, customer couple resolution, and Podium notification integration.

---

## 1. Executive Summary

The Loyalty Program subsystem remains **robust and production-hardened** since the April audit. The fulfillment-gated accrual engine is well-designed with idempotency guards, and the clawback system handles both full reversals (order cancellation) and proportional returns correctly. The redemption flow has been verified to use issuance-only semantics (loyalty reward → gift card), with proper multi-threshold batch support.

**Overall Status:** Production Ready — 0 blockers, 0 regressions.

---

## 2. Changes Since Last Audit (April 2026)

### 2.1 Redemption Contract — Issuance-Only
The April audit noted "value can be applied directly to the current sale (POS tender)." The current implementation enforces a strict issuance-only contract:
- `apply_to_sale` **must** be `$0.00` — any positive value is rejected with a clear error message
- The full reward amount is loaded onto a loyalty gift card (new or existing)
- This eliminates accounting ambiguity between tender and loyalty credit

### 2.2 Batch Threshold Redemption
`points_to_redeem` now supports multiples of the configured threshold:
- Must be a positive multiple of `loyalty_point_threshold`
- `reward_units = points_to_redeem / threshold`
- `reward_amount = reward_amount_per_threshold × reward_units`
- Enables bulk redemption (e.g., 2x threshold = 2x reward value)

### 2.3 Customer Couple Resolution
Both accrual and redemption resolve through `customer_couple::resolve_effective_customer_id_tx()`, ensuring multi-customer households share a single loyalty balance. The original `customer_id` and `effective_customer_id` are both stored in ledger metadata for auditability.

### 2.4 Podium Integration on Redemption
The redemption endpoint supports optional SMS (`notify_customer_sms`) and email (`notify_customer_email`) notifications via Podium, gated by customer opt-in rules. Notification is fire-and-forget (does not block the redemption transaction).

---

## 3. Architecture Trace

### 3.1 Accrual — Fulfillment-Gated
```
try_accrue_for_order(pool, transaction_id)
  → Idempotency check: SELECT FROM transaction_loyalty_accrual WHERE transaction_id = $1
  → Verify order status = 'fulfilled' AND all non-takeaway lines are picked_up
  → Sum eligible product lines:
      - Excludes service tax_category
      - Excludes products with excludes_from_loyalty = true
      - Uses unit_price × quantity (gross product subtotal)
  → Resolve effective customer ID (couple resolution)
  → points_earned = floor(subtotal) × POINTS_PER_DOLLAR (5)
  → Bound check: min(points_earned, i32::MAX)
  → BEGIN transaction:
      → UPDATE customers SET loyalty_points = loyalty_points + $1 WHERE id = $2
      → INSERT loyalty_point_ledger (delta, balance_after, reason='order_fulfillment')
      → INSERT transaction_loyalty_accrual (guard entry)
  → COMMIT
```

### 3.2 Full Reversal (Cancel/Refund)
```
reverse_order_accrual_in_tx(tx, transaction_id)
  → SELECT accrual WITH FOR UPDATE lock
  → Clamp deduction: GREATEST(0, loyalty_points - points_earned)
  → UPDATE customers SET loyalty_points
  → INSERT loyalty_point_ledger (reason='order_reversal')
  → DELETE transaction_loyalty_accrual guard row
```

### 3.3 Partial Clawback (Returns)
```
clawback_points_for_returned_subtotal_in_tx(tx, transaction_id, returned_subtotal)
  → Proportional: clawed_points = floor(returned_subtotal) × POINTS_PER_DOLLAR
  → Clamp to accrued: min(clawed_points, accrual.points_earned)
  → UPDATE customers SET loyalty_points = GREATEST(0, loyalty_points - clawed_points)
  → UPDATE transaction_loyalty_accrual SET points_earned -= clawed_points
  → INSERT loyalty_point_ledger (reason='partial_return_clawback')
```

### 3.4 Redemption
```
redeem_reward(state, headers, body)
  → Load threshold + reward_amount from store_settings
  → Validate points_to_redeem is positive multiple of threshold
  → resolve_redemption_contract(): enforce apply_to_sale = 0, require card code
  → BEGIN transaction:
      → Resolve effective customer ID
      → UPDATE customers SET loyalty_points -= points_to_deduct WHERE loyalty_points >= $1
      → INSERT loyalty_point_ledger (reason='reward_redemption')
      → Load reward onto loyalty gift card:
          - Existing card: verify card_kind = 'loyalty_reward', add balance, extend expiry
          - New card: INSERT gift_cards (kind='loyalty_reward', is_liability=false, 1-year expiry)
      → INSERT gift_card_events
  → COMMIT
  → Fire-and-forget Podium notification (if opted in)
```

### 3.5 Admin Adjustments
```
adjust_points(state, headers, body)
  → authenticate_pos_staff(cashier_code, pin)
  → Check effective_permissions: loyalty.adjust_points required
  → Validate non-empty reason and non-zero delta_points
  → BEGIN transaction:
      → Resolve effective customer ID
      → UPDATE customers SET loyalty_points = GREATEST(0, loyalty_points + delta)
      → INSERT loyalty_point_ledger (reason, admin metadata)
  → COMMIT
  → log_staff_access audit trail
```

---

## 4. Comparison with April 2026 Audit

| Area | April 2026 | May 2026 | Status |
|:---|:---|:---|:---|
| Accrual rate | 5 pts per $1 | Confirmed: `POINTS_PER_DOLLAR = 5` | ✅ No regression |
| Idempotency | `order_loyalty_accrual` guard | Confirmed: `transaction_loyalty_accrual` table with pre-check | ✅ No regression |
| Clawback | Automatic reversal noted | Full + partial clawback verified with FOR UPDATE locks | ✅ No regression |
| Redemption | "Applied directly to sale" + remainder | Now issuance-only (apply_to_sale must be 0) — cleaner contract | ✅ Improved |
| Batch redemption | Not mentioned | Multi-threshold support via `points_to_redeem` multiples | ✅ New capability |
| Couple resolution | Not mentioned | `resolve_effective_customer_id_tx` verified in accrual + redemption | ✅ Enhanced |
| Podium integration | Not mentioned | SMS/email notification on redemption (opt-in) | ✅ New capability |
| Points expiry | Recommended as future enhancement | Still not implemented — points do not expire | ℹ️ Same as before |

---

## 5. Findings

### 5.1 Positive: Balance Floor at Zero
All mutation paths use `GREATEST(0, loyalty_points + delta)` or `GREATEST(0, loyalty_points - clawed)`, preventing negative loyalty balances regardless of race conditions or data inconsistencies.

### 5.2 Positive: Ledger Completeness
Every point mutation — accrual, reversal, partial clawback, redemption, admin adjustment — inserts a `loyalty_point_ledger` entry with reason code, staff attribution, and full metadata including both selected and effective customer IDs.

### 5.3 Informational: Points Expiry
The April audit recommended a "Points Dormancy" cleanup for inactive customers. This has not been implemented. Points still do not expire. This is a business decision, not a bug.

---

## 6. Conclusion

**0 blockers, 0 regressions.** The Loyalty Program subsystem is production-ready with comprehensive accrual/clawback/redemption flows, strong idempotency guards, and proper customer couple resolution throughout.
