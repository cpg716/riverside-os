# Audit Report: QuickBooks Online (QBO) Integration
**Date:** 2026-04-08
**Status:** High-Precision / Financial Grade
**Auditor:** Antigravity

## 1. Executive Summary
The QuickBooks Online (QBO) integration is a high-fidelity financial bridge. It avoids "black box" automated posting by using a **Staging-First** workflow where a manager reviews proposed journal entries before they are transmitted to the cloud.

## 2. Technical Philosophy: Net-Recognition
- **Basis**: Fulfillment-day (Takeaway) recognition.
- **Accuracy**: Accounts for **Returns** and **Tax Reductions** directly on the journal, ensuring the physical inventory and the financial ledger remain in sync.
- **Account Mapping**: Granular per-category mappings for Revenue, COGS, and Inventory asset accounts.

## 3. Core Accounting Workflows

### 3.1 Fulfillment-Day Journal
- **Net Sales**: Calculated per category using "Effective Quantity" (sold minus returned).
- **Deposit Release**: Automatically releases customer deposits (`liability_deposit`) into revenue on pickup day.
- **Tender Mapping**: Maps each payment method (Cash, Card, Check, Store Credit) to specific QBO bank/clearing accounts.

### 3.2 Returns & Restocks
- **Contra-Revenue**: Debits revenue accounts to reverse sales income on the return day.
- **Inventory Recovery**: Re-credits COGS and re-debits Inventory assets only when items are marked as "Restocked."
- **Tax Liability**: Reverses sales tax liability on the date the refund is issued.

### 3.3 Gift Cards & Loyalty
- **Paid Cards**: Credited as `liability_gift_card` when sold; debited for liability relief when spent.
- **Loyalty/Giveaway**: Debited as `expense_loyalty` (not liability) when used by the customer, ensuring accurate promotional spend tracking.

### 3.4 Advanced: Suit Swaps
- **Value Deltas**: Tracks the cost difference between components in a specialized "Suit Swap" journal.
- **Ledger Offset**: Debits/Credits `INV_ASSET` vs `COGS_DEFAULT` to maintain accurate valuation when a customer swaps a product during the fitting process.

## 4. Operational Guardrails
- **Drift Detection**: Detects rounding errors and proportionality issues in large orders.
- **Dedupe Key**: Prevents double-posting of journal entries.
- **Proposal Review**: Surfaces warnings if categories are missing mappings or if deposit releases exceed net sales.

## 5. Findings & Recommendations
1. **Precision**: The "Effective Quantity" logic (line 120 of `qbo_journal.rs`) is an excellent guard against overstating revenue.
2. **Loyalty Handling**: The split between "Expense" and "Liability" for gift cards is a advanced accounting feature not often seen in retail systems.
3. **Resolved**: Staging now uses the store-local business date from `store_settings.receipt_config.timezone` via `reporting.effective_store_timezone()`, and the proposed payload includes the effective `business_timezone` for accounting review.

## 6. Conclusion
The QBO Integration is a **professional-grade financial subsystem**. It provides the auditability and control required for a luxury bridal and menswear operation.
