# Audit Report: Customer Deposits & Fund Management
**Date:** 2026-04-08
**Status:** High-Integrity / Audit-Compliant
**Auditor:** Antigravity

## 1. Executive Summary
The Deposit system in Riverside OS is a specialized "Liability Ledger" designed for high-end wedding retail. It allows the store to securely hold funds on behalf of customers (e.g., pre-payments, wedding party over-payments) and recognized them as revenue only when goods are delivered.

## 2. Deposit Lifecycle & Management

### 2.1 Inflow: The "Party Split" Credit
- **Automated Surplus Flow**: In a wedding context, if a payer (e.g., Groom's Father) pays a lump sum that exceeds a specific member's balance, the system automatically redirects the surplus into the beneficiary's **Open Deposit** account.
- **Traceability**: Every credit is linked to a source `order_id` and `payer_customer_id`, ensuring the store can answer the question: *"Where did this $100 come from?"*

### 2.2 Retention: The Internal Ledger
- **Storage**: Funds are held in `customer_open_deposit_accounts`.
- **Concurrency Safety**: The system uses `FOR UPDATE` row-level database locks during every fund movement. This prevents "Double Spend" scenarios where a deposit could be applied to two different orders simultaneously in a high-volume environment.
- **Audit Snapshots**: The `customer_open_deposit_ledger` records a "Balance After" snapshot for every single penny moved, providing a permanent historical record for financial reconciliation.

### 2.3 Outflow: POS Redemption
- **Tender Mode**: "Open Deposit" is a native payment method in the POS checkout drawer.
- **Validation**: The system performs a real-time balance check before committing the sale. If the balance is insufficient (even by a cent), the checkout is rejected.

## 3. Financial & Accounting Integration

### 3.1 Liability vs. Revenue
- **Recognition Rule**: Deposits are treated as **Liabilities** until fulfillment. 
- **Release Logic**: When an order is marked as "Fulfilled" (picked up), the system triggers a "Deposit Release." This moves the funds from the `liability_deposit` QBO account to the appropriate Revenue accounts.

### 3.2 Proportional Revenue Attribution
- **Precision Splitting**: If a $500 deposit is applied to an order containing both a Suit (Clothing Category) and a Tie (Accessories Category), the system **proportions the release**.
- **Impact**: Revenue is recognized in the correct departments matching the goods delivered, ensuring accurate departmental profit-and-loss reporting.
- **Drift Handling**: Includes internal math to detect and flag "rounding drift," ensuring the sum of category revenues perfectly matches the total deposit amount.

## 4. Findings & Recommendations
1. **Exceptional Locking**: The use of `FOR UPDATE` locks is a standard-setting choice for data integrity.
2. **Wedding Efficiency**: The automated surplus credit (Party Split) significantly reduces the administrative burden on store staff during large wedding group checkouts.
3. **Observation**: Deposits are currently tied to a specific Customer ID. **Recommendation**: For "Master Payer" scenarios (e.g., a corporate account), ensure the staff knows to credit the Master Customer record if funds are intended for group-wide use.

## 5. Conclusion
The Riverside OS Deposit subsystem is **financially mature and technically robust**. It provides a secure, auditable, and automated way to manage customer funds throughout the long-cycle wedding sales process.
