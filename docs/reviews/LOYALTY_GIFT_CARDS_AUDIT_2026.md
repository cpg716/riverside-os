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
- **Deduplication**: The backend verifies (via `order_checkout.rs`) that the `sub_type` metadata is provided specifically for gift card methods, preventing mis-tagging of cash or card tenders.

## 3. Financial & Accounting Differential

### 3.1 Advanced QBO Mapping (`propose_daily_journal`)
The system's "Accounting Brain" performs a differential ledger mapping during the daily journal generation:
- **Case 1: Paid Liability**: Debits the `liability_gift_card` account (clearing the store's debt to the customer).
- **Case 2: Loyalty Giveaway**: Debits the `expense_loyalty` account (recognizing the cost of the promotion on the P&L).
- **Case 3: Donated Giveaway**: Debits the `expense_donated` account (categorizing the promotion as a charitable expense).

### 3.3 Expiration, Sweep & Breakage Behavior (v0.3.5+)
The system performs a defensive sweep before daily QBO journal proposal generation:
- **Scope**: Only purchased gift cards (`is_liability = TRUE`) are eligible for breakage.
- **Process**: Active gift cards whose expiration date (`expires_at`) is on or before the current business date are zeroed out (`current_balance = 0.00`) and set to `'depleted'`. A `gift_card_events` row of kind `'expiration_breakage'` is logged, backdated to `23:59:59` of the expiration day.
- **Accounting**:
  - **Purchased Gift Cards**: The swept amount is recognized as **Breakage Revenue** by debiting `liability_gift_card` (clearing the unredeemed liability) and crediting `income_gift_card_breakage` (or `REVENUE_GIFT_CARD_BREAKAGE` if unmapped).
  - **Donated & Loyalty Gift Cards**: Since promotional and loyalty cards do not carry initial cash liability (`is_liability = FALSE`), expiration has no balance sheet impact and generates **no** purchased-card breakage entry. Checkout rejects them after the saved expiration. Their retained card row remains auditable; if staff later reassign the same matching code, Riverside records closure of any expired balance before issuing the new value.

## 4. Findings & Recommendations
1. **Financial Precision**: The differential QBO mapping is a "Best-in-Class" feature that prevents promotional credits from "poisoning" the liability account on the balance sheet.
2. **Staff Transparency**: Checkout revalidates the scanned card and replaces requested subtype metadata with the card's canonical server classification, preventing a Loyalty or Donated card from being recorded as purchased liability.
3. **Automated Liability Cleansing**: The background breakage sweep automatically converts abandoned, expired customer liabilities into revenue on QBO, ensuring the balance sheet is not inflated with stale debt.
4. **Audit evidence**: ROS-created Loyalty and Donated events retain the acting staff member. Loyalty issuance history also stores the issuer and uses the saved server expiration for letters and reprints.

## 5. Conclusion
The Loyalty & Donated gift card system is **architecturally sound and financially accurate**. It provides store owners with the transparency needed to run aggressive marketing campaigns without losing track of their true financial liabilities.
