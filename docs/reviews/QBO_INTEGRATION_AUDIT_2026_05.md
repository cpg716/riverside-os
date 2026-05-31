# Audit Report: QuickBooks Online (QBO) Integration (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-08 (updated 2026-05-23, 2026-05-27)
**Version Audited:** v0.85.0 (commit `73cdd56`)
**Auditor:** Devin (AI assistant)
**Scope:** End-to-end trace of `propose_daily_journal` — fulfillment-day revenue recognition, tender mapping, returns contra-revenue, deposit release, gift card accounting, suit swap offsets, inventory transactions, freight, RMS financing, merchant fee recon, refund liability clearing, and balance verification.

---

## 1. Executive Summary

The QBO Integration subsystem is a **high-fidelity financial bridge** with sophisticated accounting logic. The `propose_daily_journal` function (1,936 lines) builds a complete double-entry journal covering 15+ distinct accounting scenarios, with built-in balance verification and proportionality drift detection. The mapping-first, staging-first architecture ensures no entries reach QBO without human review.

**Overall Status:** Production Ready — 0 blockers, 0 regressions. Extensive new capabilities since May 23 audit.

---

## 2. Architecture: Journal Proposal Engine

### 2.1 Revenue Recognition — Fulfillment-Day Basis
Revenue is recognized on the store-local business date when fulfillment occurs:
- Pickup/in-store takeaway: uses fulfillment timestamp
- Shipped orders: uses the shared shipment recognition instant from `report_basis::ORDER_RECOGNITION_TS_SQL`
- **Effective quantity**: `sold_qty - returned_qty` via `TL_EFFECTIVE_JOIN` — prevents overstating revenue

Category-level aggregation groups by `category_id` + custom item type, enabling per-category revenue/COGS/tax mapping to distinct QBO accounts.

### 2.2 Tender Mapping — Comprehensive Classification
The tender mapping engine handles 10+ distinct payment scenarios:

| Tender | QBO Treatment |
|:---|:---|
| Helcim card (all variants) | Consolidated as `helcim_card` → mapped tender account |
| Cash / Check | Direct tender mapping |
| Gift card (purchased) | Liability relief → `liability_gift_card` |
| Gift card (loyalty/donated/promo) | Expense → `expense_loyalty` |
| Store credit | Liability relief → `liability_store_credit` |
| Open deposit | Liability relief → `liability_deposit` |
| RMS financing | Clearing → `RMS_CHARGE_FINANCING_CLEARING` |
| RMS payment collection | Pass-through with reversal support |
| Negative amounts (refunds) | Credit to tender account (cash out) |

**Fallback chain**: Specific mapping → ledger fallback → MISC_FALLBACK → warning if unmapped.

### 2.3 Returns — Contra-Revenue on Activity Date
Returns recorded on `activity_date` generate:
1. **Contra-revenue**: Debits revenue accounts (reduces income)
2. **Tax liability reversal**: Debits sales tax (state + local combined)
3. **COGS reversal** (restock only): Credits COGS, debits inventory asset — only when `restocked = true`

### 2.4 Deposit Release — Proportional Category Allocation
Customer deposits are released into recognized revenue on pickup day:
- Identifies `applied_deposit_amount` from `payment_allocations` metadata
- Allocates proportionally across categories by net sales ratio: `deposit × (cat_net / order_net)`
- **Drift detection**: Compares day-level deposit total vs release total; warns if drift > $0.01
- **Per-order drift**: Detects rounding drift from category splits with tolerance threshold

### 2.5 Gift Card Accounting — Liability, Expense, and Breakage
- **Purchased cards loaded**: Credit `liability_gift_card` (liability increase)
- **Purchased card redemption**: Debit `liability_gift_card` (liability relief)
- **Loyalty/donated/promo redemption**: Debit `expense_loyalty` (expense recognition)
- **Automated Expiration Breakage (v0.3.5+)**:
  - A background task sweeps expired cards on the journal's `activity_date`.
  - Only liability-bearing cards (`is_liability = TRUE`) are processed: their balance is zeroed, status is marked `'depleted'`, and an `'expiration_breakage'` event is inserted.
  - The swept breakage balance debits `liability_gift_card` (reducing liability) and credits `income_gift_card_breakage` (or `REVENUE_GIFT_CARD_BREAKAGE` if unmapped).
  - Promotional, loyalty, and donated gift cards (`is_liability = FALSE`) are excluded from QBO breakage since they represent no cash liability.
- Classification determined by `gift_card_uses_liability_relief()` and `gift_card_uses_loyalty_expense()` helpers checking the payment transaction `sub_type` metadata.

### 2.6 Suit Swap Offsets
Suit/component swap events generate cost-delta journal entries:
- Delta = `(new_unit_cost - old_unit_cost) × effective_quantity`
- Positive delta: Debit INV_ASSET, Credit COGS_DEFAULT
- Negative delta: Credit INV_ASSET, Debit COGS_DEFAULT
- Only processed when `inventory_adjusted = true`

### 2.7 Inventory Transactions (Non-Sale)
Covers `po_receipt`, `adjustment`, `damaged`, `return_to_vendor`, `physical_inventory`:
- Each type maps to specific clearing/expense accounts
- Shrinkage (negative adjustments): Credit Inventory, Debit Shrinkage
- Found inventory (positive adjustments): Debit Inventory, Credit Revenue Fallback

### 2.8 Inbound Freight
Freight from receiving events posts to `COGS_FREIGHT` expense with offset to `INV_RECEIVING_CLEARING`. Freight is explicitly NOT part of COGS — it has its own account.

### 2.9 Merchant Fee Reconciliation
For card transactions with reconciled fees:
- Debit `expense_merchant_fee` (fee expense)
- Credit the tender clearing account (reducing gross to net)
- Only processes when fees are non-zero and mapping exists

### 2.10 Refund Liability Clearing
Handles the timing mismatch between return day (contra-revenue booked) and refund payout day (cash out):
- `refund_liability_delta = refund_liability_created - refund_liability_relieved`
- Positive delta: Credit `liability_refund_queue` (liability increase — returns awaiting payout)
- Negative delta: Debit `liability_refund_queue` (liability relief — payouts processed)

### 2.11 Balance Verification
Post-generation, the proposal verifies `debits == credits`:
- Logs a warning with line-level detail if unbalanced
- Surfaces the imbalance amount in the `warnings` array and `totals.balanced = false`
- This is a guardrail — the staging UI shows the imbalance before any sync attempt

---

## 3. Operational Safeguards

### 3.1 Staging Lifecycle
```
ensure_pending_daily_journal(pool, activity_date)
  → Check for existing qbo_sync_logs rows for this date
  → If pending row exists: UPDATE payload (regenerate)
  → If no pending: INSERT new 'pending' row
  → Locked rows (approved/synced) are preserved and surfaced in metadata
```

### 3.2 Token Management
- AES-256-GCM encryption for stored OAuth tokens (`v2:` prefix for AEAD format)
- Proactive refresh: `refresh_due_tokens()` runs every 50 minutes
- Health endpoint: `GET /api/qbo/token-health` for monitoring
- CompanyInfo validation: `GET /api/qbo/company-info` for connection verification

### 3.3 RBAC Gates
- `qbo.view`: Read mappings, staging, and sync logs
- `qbo.mapping_edit`: Modify category/tender/ledger mappings
- `qbo.staging_approve`: Approve pending entries for sync
- `qbo.sync`: Execute sync to QBO, retry failed, void synced

### 3.4 Counterpoint Import Handling
Imported Counterpoint transactions are included in proposals with explicit warnings about non-authoritative tax data and zero-tax line counts.

---

## 4. Comparison with Previous Audits

| Area | April/May 2026 | May 29 Re-Audit | Status |
|:---|:---|:---|:---|
| Fulfillment-day recognition | Documented | Verified: `ORDER_RECOGNITION_TS_SQL` with effective qty | ✅ No regression |
| Deposit release | Documented | Verified: proportional allocation with drift detection | ✅ No regression |
| Returns contra-revenue | Documented | Verified: revenue debit + tax reversal + conditional COGS restock | ✅ No regression |
| Gift card split (liability vs expense) | Documented | Verified: 4 sub-types with correct accounting treatment | ✅ No regression |
| Suit swap offsets | Documented | Verified: cost-delta entries with INV_ASSET/COGS_DEFAULT | ✅ No regression |
| Token health/refresh | Resolved May 23 | Confirmed: AES-GCM encryption, 50-min proactive refresh | ✅ No regression |
| Revert/Retry/Void | Resolved May 27 | Not re-verified (API-level, not journal logic) | ℹ️ Not in scope |
| Merchant fee recon | Not documented | Verified: fee expense + clearing offset for card tenders | ✅ New finding |
| Refund liability clearing | Not documented | Verified: timing mismatch handling for async refund payouts | ✅ New finding |
| Freight accounting | Not documented | Verified: separate COGS_FREIGHT with receiving clearing offset | ✅ New finding |
| RMS financing/collections | Not documented | Verified: financing clearing, payment pass-through, reversals | ✅ New finding |
| Balance verification | "Drift detection" noted | Verified: exact debit/credit check + day-level + per-order drift | ✅ Enhanced |
| Invoice/Bill support | Open item #10 | Still JournalEntry-only — Invoice entity support not implemented | ℹ️ Same as before |

---

## 5. Findings

### 5.1 Positive: Comprehensive Balance Integrity
The journal proposal engine performs three levels of verification:
1. **Line-level**: Debits == Credits check on completed journal
2. **Day-level**: Deposit release total vs allocation total (drift > $0.01 = warning)
3. **Per-order**: Rounding drift from proportional category splits

This triple-verification provides high confidence in journal accuracy before any QBO sync.

### 5.2 Positive: Defensive Mapping Strategy
Every accounting scenario has a 3-tier fallback: specific mapping → ledger mapping → MISC_FALLBACK. When no mapping exists, the line is **omitted with a warning** rather than posting to a wrong account. This is the correct behavior for a staging system.

### 5.3 Informational: Journal Size
The `propose_daily_journal` function is 1,600+ lines of accounting logic. While well-structured with inline struct definitions and clear sections, this is a large single function. The complexity is inherent to the accounting domain — breaking it up would sacrifice the clear sequential flow. No refactoring recommended.

---

## 6. Conclusion

**0 blockers, 0 regressions.** The QBO Integration subsystem is production-ready with the most thorough accounting journal engine reviewed in this audit series. The mapping-first staging workflow, triple-verification balance checks, and defensive fallback strategy make this a robust financial bridge.
