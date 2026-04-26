# Bugsquash Report — v0.1.9 (Production Finalization)

**Date:** 2026-04-11  
**Status:** COMPLETE — PRODUCTION READY  
**Auditors:** Antigravity AI & Riverside Engineering  

## Executive Summary
This report summarizes the final "nook and cranny" audit performed to stabilize Riverside OS (ROS) for live production. The primary focus was on financial integrity, tax logic hardening, cashier accountability, and cross-platform consistency between the POS and Wedding Manager systems. ROS is now considered an "Iron Cage" for retail data.

## Critical Fixes & Hardening

### 1. POS Operational Security: Mandatory PIN Gate
*   **Identified Risk:** Register screens remaining unlocked after a sale, allowing subsequent transactions without cashier accountability.
*   **Solution:** Enforced a **Mandatory PIN Reset** on receipt dismissal.
    *   Updated `Cart.tsx` to clear the `checkoutOperator` state when the `ReceiptSummaryModal` is closed.
    *   This forces a return to the "Cashier for this sale" PIN gate before scan, search, or checkout can resume.
*   **Audit Trail:** Every transaction is now strictly linked to the verifying staff member's ID in the `orders.primary_salesperson_id` and `staff_access_log`.

### 2. Standalone Group Pay Support
*   **Requirement:** Enable "Pay for someone else" (Wedding Payouts) even if the customer isn't buying any items for themselves today.
*   **Solution:** Relaxed checkout validation in `transaction_checkout.rs` and `Cart.tsx`.
    *   The system now allows a "Zero Item" checkout IF `wedding_disbursements` (group pay) are present.
    *   This ensures "complete sale" works even when the cart contains NO physical items, routing the payment correctly to the chosen wedding members' accounts.

### 3. Financial Integrity: The "Iron Cage" Tax Hardening
*   **Identified Risk:** Client-side "tax ratio" math was identified as a risk for NYS Publication 718-C compliance. 
*   **Solution:** Implemented **Server-Side Tax Hardening** in `server/src/logic/transaction_checkout.rs`.
    *   The server now ignores client-supplied tax values.
    *   It re-calculates `state_tax` and `local_tax` using the `logic::tax` module for every line item, ensuring threshold rules are applied with server-side authority (e.g., $110 threshold).
*   **Drift Prevention:** Hardened `recalc_transaction_totals` to include `shipping_amount_usd` in the final price aggregation, preventing ledger discrepancies during line returns.

### 4. Search & Data Consistency: CRM Merge Sync
*   **Identified Risk:** Stale data in Meilisearch after a customer merge (slave record remaining in search results).
*   **Solution:** Added Meilisearch sync triggers to the `post_merge_customers` endpoint.
    *   Master records are immediately refreshed to reflect combined history/metrics.
    *   Slave records are explicitly deleted from the search index.

### 5. Physical Inventory: Audit-Ready Snapshots
*   **Verification:** Audited `physical_inventory.rs` for stock snapshot accuracy.
*   **Hardening:** Confirmed the "Sales Since Start" deduction logic correctly handles overlapping transactions during an active count, ensuring published stock values are perfect.

## Financial Invariants (Non-Negotiable)

1.  **Re-Authentication**: A PIN must be entered for **every** transaction. Closing a receipt summary modal MUST lock the terminal.
2.  **Precision**: Currency MUST be handled via `rust_decimal::Decimal` on the server. Floating point numbers (f32/f64) are strictly forbidden for money.
3.  **AUTHORITY**: The Server is the only source of truth for Sales Tax and Order Totals. Client display is a guide.
4.  **Audit Trail**: Every stock movement (Inventory publish) and financial movement (Order pickup/refund) must record a row in its respective Audit/Ledger tables.

## Watchpoints for v0.2.x
*   **Meilisearch Sync**: High-volume catalog imports should be followed by a manual re-index if the background job fails to trigger.
*   **NYS Tax Changes**: Any changes to Publication 718-C thresholds (currently $110) must be updated in `server/src/logic/tax.rs`.

---
**Deployment Status: GREEN**  
ROS is now stabilized in an "Iron Cage" of financial reliability.
