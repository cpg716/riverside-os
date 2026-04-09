# Audit Report: POS Payments & Ledger Subsystem
**Date:** 2026-04-08
**Status:** Highly Flexible / Multi-Tender
**Auditor:** Anti-gravity

## 1. Executive Summary
The Payments subsystem is a multi-tender transactional engine that powers the POS. It isn't just a "Pay Now" button; it is a full **Ledger Allocation System** that handles split payments, store credit, gift cards, and customer account deposits.

## 2. Technical Architecture

### 2.1 Split Resolution Engine (`resolve_payment_splits`)
- **Mechanism**: The backend can resolve a single order into a mosaic of payment methods (e.g., $100 Cash + $200 Card + $50 Gift Card).
- **Validation**: Every split is validated to ensure the `payment_splits` sum exactly to the `amount_paid`, preventing balance discrepancies in the till.
- **Labels**: Generates a human-readable "Tender Label" (e.g., `Cash + Card`) for the receipt and the wedding manager activity feed.

### 2.2 Supported Tender Types
- **Cash**: Standard till tender.
- **Card**: Integrated Stripe (via `STRIPE_INTEGRATION_AUDIT`).
- **Gift Card**: Integrated with the `gift_card` table, allowing for `paid_liability` (standard) or `loyalty_giveaway` (promotional) splits.
- **Store Credit**: Debits the customer's `store_credit_balance` directly.
- **RMS/Deposit Ledger**: Allows a customer to pay for a new order using funds they previously "deposited" on their account.

## 3. Checkout Integrity

### 3.1 Idempotency Guard
- **`checkout_client_id`**: Every checkout request from the UI carries a unique UUID. 
- **Purpose**: If a salesperson clicks "Complete Sale" twice (due to network lag or accidental double-tap), the server detects the ID, skips the second checkout, and returns the existing `order_id` instead of double-charging.

### 3.2 Role-Based Pricing Control
- **Discount Thresholds**: The system verifies the operator's permissions before committing any price overrides. 
- **Limit Integrity**: If a staff member with a "Sales Support" role tries to apply a 30% discount exceeding their allowed threshold, the checkout is rejected before any payment is processed.

### 3.3 Financial Calculations
- **Bundle Logic**: Correctly expands bundle SKUs into component lines, apportioning the total price based on retail weights to ensure accurate tax (state vs local) and commission reporting.

## 4. Operational Maintenance
- **Audit Logging**: Every checkout logs a `register_open`, `register_shift_handoff`, or `order_booked_at` event linked to the operator's staff ID.
- **Till Reconciliation**: Every tender is tracked per-lane (`register_lane`), enabling highly granular Z-Report reconciliations at the end of the day.

## 5. Findings & Recommendations
1. **Splits Flexibility**: The ability to mix regular tenders with "Account Deposits" is a high-value feature for high-ticket wedding retail.
2. **Idempotency Strength**: Using a client-provided UUID is the "Best Practice" for financial POS systems.
3. **Observation**: The system handles both "Order-Level" and "Line-Level" salesperson attribution. **Recommendation**: Ensure the "Primary Salesperson" is correctly set when split-commission lines are present.

## 6. Conclusion
The POS Payments subsystem is **robust, transactional, and audit-ready**. It provides the store with the flexibility required for complex wedding transactions while maintaining absolute ledger accuracy.
