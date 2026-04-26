# Audit Report: Loyalty & Donated Gift Card Subsystem
**Date:** 2026-04-08
**Status:** Multi-Tier Accounting / Promotion-Ready
**Auditor:** Antigravity

## 1. Executive Summary
Riverside OS differentiates between "Paid" gift cards (which represent a financial liability) and "Loyalty/Donated" gift cards (which represent a marketing expense). This distinction ensures that the store's balance sheet perfectly reflects the difference between customer-funded credit and store-funded promotions.

## 2. Technical Taxonomy & Lifecycle

### 2.1 The Three Gift Card "Sub-Types"
The system categorizes gift card redemptions into three distinct business flows via the POS `sub_type` tag:
- **`paid_liability`**: Standard gift cards purchased by a customer. These are treated as pure liabilities.
- **`loyalty_giveaway`**: Promotional credits given to high-value customers. These are treated as a marketing cost.
- **`donated_giveaway`**: Credits donated to charities (e.g., fundraisers). These are treated as a charitable expense.

### 2.2 POS Workflow (`NexoCheckoutDrawer`)
- **UI Logic**: When the "Gift Card" tender tab is selected (lines 178-182), staff are presented with a three-way toggle to select the card's classification.
- **Validation**: The frontend enforces that a code must be scanned/entered and a classification must be selected before the payment split can be applied to the ledger.
- **Deduplication**: The backend verifies (via `transaction_checkout.rs`) that the `sub_type` metadata is provided specifically for gift card methods, preventing mis-tagging of cash or card tenders.

## 3. Financial & Accounting Differential

### 3.1 Advanced QBO Mapping (`propose_daily_journal`)
The system's "Accounting Brain" performs a differential ledger mapping during the daily journal generation:
- **Case 1: Paid Liability**: Debits the `liability_gift_card` account (clearing the store's debt to the customer).
- **Case 2: Loyalty Giveaway**: Debits the `expense_loyalty` account (recognizing the cost of the promotion on the P&L).
- **Case 3: Donated Giveaway**: Debits the `expense_donated` account (categorizing the promotion as a charitable expense).

### 3.2 Integrity & Audit
- **Balance Logic**: All classifications use the same transactional balance deduction logic (with `FOR UPDATE` locking) to prevent over-spending on any single card.
- **Event Logging**: Every redemption is logged in `gift_card_events` with the persistent metadata of its classification (`paid`, `loyalty`, or `donated`), ensuring that even years later, the store can audit how much of their gift card liability was cleared via "Free" vs "Paid" credits.

## 4. Findings & Recommendations
1. **Financial Precision**: The differential QBO mapping is a "Best-in-Class" feature that prevents promotional credits from "poisoning" the liability account on the balance sheet.
2. **Staff Transparency**: The clear UI toggle in the checkout drawer reduces the likelihood of staff mis-categorizing expensive loyalty promotions as regular paid cards.
3. **Observation**: Currently, `card_kind` is also stored at the card level (`gift_cards.card_kind`). **Recommendation**: Always ensure the `sub_type` selected during checkout matches the `card_kind` on the card to maintain perfect internal consistency (though the system currently allows override for maximum floor flexibility).

## 5. Conclusion
The Loyalty & Donated gift card system is **architecturally sound and financially accurate**. It provides store owners with the transparency needed to run aggressive marketing campaigns without losing track of their true financial liabilities.
