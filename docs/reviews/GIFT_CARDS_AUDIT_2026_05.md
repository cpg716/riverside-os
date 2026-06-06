# Audit Report: Gift Card Subsystem (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-08
**Version Audited:** v0.85.5 (commit `cac08918`)
**Auditor:** Devin (AI assistant)
**Scope:** End-to-end trace of gift card taxonomy (4 kinds), issuance workflows (POS load, loyalty load, donated, promo), redemption (`prepare_redemption_in_tx`), credit/refund (`credit_gift_card_in_tx`), voiding, event history, summary reporting, and QBO journal integration.

---

## 1. Executive Summary

The Gift Card subsystem remains **hardened and ledger-first** since the April audit. A fourth card kind (`promo_gift_card`) has been added since the previous audit, completing the taxonomy. All balance mutations use `FOR UPDATE` row-level locks within database transactions. The `gift_card_ops` module provides transactional primitives shared by checkout, refund, and standalone API paths.

**Overall Status:** Production Ready — 0 blockers, 0 regressions.

### June 2026 Remediation Addendum

The June 2026 gift-card review found and repaired three production-readiness gaps:

- Scanner and typed code workflows now normalize gift-card codes to uppercase and resolve existing cards case-insensitively.
- Open-card lists and liability summary counts now exclude expired active cards, matching redemption lookup behavior.
- Reuse/refill rules are explicit: depleted purchased, loyalty, donated, and promo cards can be reassigned through the matching workflow while preserving history; active unexpired cards can be topped up; expired purchased cards with remaining balance are blocked from reload until QBO breakage review; expired non-liability balances are closed before reassignment and do not create QBO breakage.

---

## 2. Card Taxonomy — Now 4 Kinds

| Kind | `card_kind` enum | Liability? | Expiry | Issuance Path |
|:---|:---|:---|:---|:---|
| **Purchased** | `purchased` | ✅ Yes | 9 Years | POS register load (cart line or direct API) |
| **Loyalty Reward** | `loyalty_reward` | ❌ No | 1 Year | Loyalty points redemption or manual loyalty load |
| **Donated / Giveaway** | `donated_giveaway` | ❌ No | 1 Year | Back Office admin issuance |
| **Promo Gift Card** | `promo_gift_card` | ❌ No | 1 Year | Back Office admin issuance (requires event name) |

### 2.1 Canonical Sub-Type Mapping
`canonical_gift_card_sub_type_for_kind()` maps each kind to a checkout sub-type:
- `purchased` → `paid_liability`
- `loyalty_reward` → `loyalty_giveaway`
- `donated_giveaway` → `donated_giveaway`
- `promo_gift_card` → `promo_gift_card`

This mapping is critical for QBO journal entries — it determines whether redemption posts as liability relief or loyalty expense.

---

## 3. Architecture Trace

### 3.1 Redemption — Checkout Integration
```
prepare_redemption_in_tx(tx, code, requested_sub_type, amount)
  → Validate amount > 0
  → SELECT id, current_balance, card_kind FROM gift_cards
      WHERE code = $1 AND status = 'active' AND not expired
      FOR UPDATE  (row-level lock)
  → Resolve canonical sub-type
  → If requested_sub_type provided: enforce match (prevents using loyalty card as purchased)
  → Validate current_balance >= amount
  → Compute new_balance = current_balance - amount
  → Status transition: if new_balance == 0 → 'depleted', else stays 'active'
  → Return GiftCardRedemptionPlan { card_id, new_balance, new_status }
```

The caller (checkout engine) then applies the plan within the same transaction, updating `gift_cards.current_balance` and inserting `gift_card_events`.

### 3.2 Credit / Refund
```
credit_gift_card_in_tx(tx, code, amount, transaction_id, session_id)
  → Validate amount > 0
  → SELECT with FOR UPDATE lock (active + not expired)
  → new_balance = old_balance + amount
  → UPDATE gift_cards SET current_balance
  → INSERT gift_card_events (event_kind='refunded')
  → Return GiftCardCreditPlan { card_id, card_kind, normalized_code, new_balance }
```

### 3.3 POS Load — Purchased Cards
```
pos_load_purchased_in_tx(tx, code, amount, customer_id, session_id, transaction_id_for_events)
  → Validate code non-empty, amount > 0
  → 9-year expiry for purchased cards
  → SELECT with FOR UPDATE (any status)
  → If existing card:
      → Enforce card_kind == 'purchased'
      → Reject if 'void'
      → If depleted/zero: reactivate (status='active', is_liability=true, add to original_value)
      → If active and unexpired: add to current_balance, extend expiry
      → If active, expired, and positive balance: block reload until breakage review
  → If new code: INSERT as purchased, active, is_liability=true
  → INSERT gift_card_events (kind varies: 'issued' for new/reactivated, 'loaded' for top-up)
```

### 3.4 Loyalty Load
```
issue_loyalty_load(state, headers, body)
  → Requires POS/staff authentication
  → 1-year expiry
  → If existing active, unexpired card:
      → Enforce card_kind == 'loyalty_reward'
      → Add amount to balance, extend expiry
      → Event: 'loaded'
  → If depleted/zero: reactivate with new value and preserve history
  → If expired with positive balance: close expired non-liability value before reassigning
  → If new: INSERT as loyalty_reward, not liability
      → Event: 'issued'
```

### 3.5 Donated / Promo Issuance
- **Donated**: Requires `gift_cards.manage` permission. Creates `donated_giveaway`, not liability, 1-year expiry.
- **Promo**: Same permission. Creates `promo_gift_card` with required `event_name`. Not liability, 1-year expiry.
- Existing unexpired cards can be topped up through the matching workflow. Depleted cards can be reassigned while preserving history. Expired non-liability balances are closed before reassignment.

### 3.6 Voiding
```
void_gift_card(state, id, headers)
  → Requires gift_cards.manage
  → UPDATE status = 'void' WHERE id = $1 AND status != 'void'
  → If no rows affected: 404
  → INSERT gift_card_events: event_kind='voided', amount=-current_balance, balance_after=0
```

The void event correctly captures the negative amount equal to the remaining balance, maintaining ledger accuracy.

---

## 4. API Surface

| Route | Method | Auth | Purpose |
|:---|:---|:---|:---|
| `/gift-cards/` | GET | gift_cards.manage | List with search, kind, status, sort filters |
| `/gift-cards/summary` | GET | gift_cards.manage | Aggregate stats (open count, liability balance, etc.) |
| `/gift-cards/open` | GET | POS/staff | Active cards with balance > 0 (for POS lookup) |
| `/gift-cards/code/{code}` | GET | POS/staff | Lookup by code (active + not expired only) |
| `/gift-cards/code/{code}/events` | GET | POS/staff | Event history by code (limit 300) |
| `/gift-cards/pos-load-purchased` | POST | POS/staff | Load purchased card (triggers Sales Support notification) |
| `/gift-cards/issue-loyalty-load` | POST | POS/staff | Load loyalty reward card |
| `/gift-cards/issue-donated` | POST | gift_cards.manage | Issue donated/giveaway card |
| `/gift-cards/issue-promo` | POST | gift_cards.manage | Issue promo card (requires event name) |
| `/gift-cards/{id}/void` | POST | gift_cards.manage | Void a card |
| `/gift-cards/{id}/events` | GET | gift_cards.manage | Event history by card ID |

### 4.1 Summary Reporting
`get_gift_card_summary()` provides:
- `open_cards_count`: Active cards with balance > 0
- `active_liability_balance`: Sum of balances where `is_liability = true` and active
- `loyalty_cards_count`, `donated_cards_count`, `promo_cards_count`: Counts by kind

This is critical for financial reporting — the `active_liability_balance` represents a real balance sheet liability.

### 4.2 Sales Support Notification
Direct POS loads (outside checkout) trigger `notify_sales_support_direct_pos_load()`:
- Fans out app notification to all active `sales_support` role staff
- Deduplication key includes code + amount + timestamp
- Audit log entry for the operator

---

## 5. QBO Journal Integration

Gift cards interact with the QBO journal in three distinct ways:
1. **Purchased card loads**: Excluded from merchandise revenue. Credited to `liability_gift_card` account.
2. **Purchased card redemption**: Debited from `liability_gift_card` (liability relief).
3. **Loyalty/donated/promo redemption**: Debited from `expense_loyalty` (expense recognition, not liability).

The `canonical_gift_card_sub_type_for_kind()` function is the bridge between the gift card subsystem and QBO journal — it determines the accounting treatment for each payment transaction.

---

## 6. Comparison with April 2026 Audit

| Area | April 2026 | May 2026 | Status |
|:---|:---|:---|:---|
| Card taxonomy | 3 kinds (purchased, loyalty, donated) | **4 kinds** — promo_gift_card added | ✅ Enhanced |
| FOR UPDATE locks | Documented | Confirmed in all mutation paths | ✅ No regression |
| Event trail | "Every balance change tracked" | Confirmed: issued, loaded, refunded, voided events | ✅ No regression |
| Liability distinction | "Handled correctly" | Verified: only purchased cards set `is_liability = true` | ✅ No regression |
| Activation timing | "Credits only when sale is fully paid" | Confirmed: `pos_load_purchased_in_tx` runs inside checkout transaction | ✅ No regression |
| Balance history UI | Recommended | `gift_card_events` API now supports both by-ID and by-code lookups | ✅ Improved |
| Manual balance override | Recommended | Still requires void + re-issue workflow | ℹ️ Same as before |
| Operational alerts | "Direct Load triggers notification" | Verified: deduped notification to sales_support + audit log | ✅ No regression |
| POS code lookup | "Real-time lookups" noted | Verified: `/code/{code}` filters active + not expired | ✅ No regression |

---

## 7. Findings

### 7.1 Positive: Comprehensive Sub-Type Enforcement
The `prepare_redemption_in_tx()` function enforces sub-type matching when `requested_sub_type` is provided. This prevents a customer from using a loyalty card as a purchased card (or vice versa), which would cause incorrect QBO accounting.

### 7.2 Positive: Depleted Card Reactivation
When a purchased card with zero balance is loaded again, the system correctly transitions it back to `active` status, resets the session, and adds to `original_value`. This handles the common retail scenario of "reloading" a gift card after it's been fully spent.

### 7.3 Positive: Unit Tests
`gift_card_ops.rs` includes unit tests for:
- `canonical_sub_type_follows_card_kind`: Verifies all 4 card kinds map to correct sub-types
- `redemption_blocks_sub_type_mismatch`: Integration test (requires DATABASE_URL) verifying cross-type redemption is blocked

---

## 8. Conclusion

**0 blockers, 0 regressions.** The Gift Card subsystem is production-ready with a complete 4-kind taxonomy, strong ledger integrity via `FOR UPDATE` locks, comprehensive event trails, proper liability/expense accounting classification, and operational safeguards including Sales Support notifications and sub-type enforcement.
