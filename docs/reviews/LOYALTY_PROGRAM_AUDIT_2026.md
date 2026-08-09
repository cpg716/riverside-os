# Audit Report: Loyalty Subsystem (2026)
**Date:** 2026-08-09 (re-audited; supersedes the April 8 workflow notes)
**Status:** Fulfillment-gated, ledger-backed, single and batch reward-card fulfillment

## 1. Executive Summary
The Riverside OS Loyalty subsystem is a consumption-based rewards engine designed to drive customer retention. It uses a 5-points-per-$1 model, with earned points convertible into store credit (loyalty reward gift cards).

## 2. Component Analysis

### 2.1 Core Rules
- **Earn Basis**: points are earned on the **truncated product subtotal** (excluding tax, service fees, and specifically excluded SKUs).
- **Rate**: Fixed at **5 points per $1** in the business logic.
- **Trigger**: points are accrued only when an order line is **fulfilled**. For special orders, this occurs at pickup; for takeaway, this occurs at checkout. This ensures points represent final, owned merchandise.

### 2.2 Backend Logic & Integrity (`loyalty.rs`)
- **Idempotency**: Use of the `order_loyalty_accrual` guard table prevents double-earning if an order is re-fulfilled or edited.
- **Clawbacks**: Implements automatic point reversal for order cancellations and proportional clawbacks for merchandise returns.
- **Ledger Model**: Every point change (earn, redeem, adjustment) is recorded in the `loyalty_point_ledger` with a specific reason code.

### 2.3 Back Office Management (`LoyaltyWorkspace.tsx`)
- **Program Configuration**: Admins can dynamically adjust the `threshold` (points required) and the `reward_amount` ($ value).
- **Security**: Manual point adjustments require an authenticated operator with `loyalty.adjust_points` plus a separate Manager Access staff selection and PIN approval.
- **Single and Group Fulfillment**: Staff can issue for one eligible customer or select multiple customers for a guided batch. Each reward block is loaded to a separately scanned loyalty card.
- **Physical Output**: Staff can print one letter/label or select a group. Bulk letters use one print job with one page per customer; selected cards for the same customer are consolidated into the customer's letter.

### 2.4 POS Redemption (`LoyaltyRedeemDialog.tsx`)
- **Conversion Workflow**: When a reward is redeemed:
  1. Points are deducted from the customer's CRM profile.
  2. The full reward is loaded onto a non-liability **Loyalty Reward** gift card.
  3. Any current sale is completed separately; reward issuance does not silently change the open sale.
- **Retry Safety**: A client-generated redemption request ID is stored with the issuance. Replaying the same logical request returns the original result instead of deducting points or loading the card again.
- **Customer Fulfillment**: This workflow uses physical letters and mailing labels. It does not send a Podium SMS or email.

### 2.5 API and Persistence Review
- Settings changes validate the complete payload before one atomic `store_settings` update.
- Eligible-customer responses include the customer code used by the UI and printable fulfillment output.
- Redemption resolves couple-linked profiles to the shared primary account, deducts points, writes the point ledger, loads the non-liability card, and records the issuance in one database transaction.
- `loyalty_reward_issuances.redemption_request_id` is unique when present, and the original `balance_after` is retained for an exact idempotent response.
- Reward cards retain their saved server issue/expiration evidence and remain separate from customer-paid gift-card liability.

## 3. Findings & Recommendations

### ✅ Strengths
- **Fulfillment-Gated Accrual**: Technical superior; many systems accrue on payment, leading to complex reversal needs for deposits.
- **Explicit Redemption**: The full reward is always issued to a classified loyalty card, keeping the open sale and customer-paid gift-card liability unambiguous.
- **Security Guardrails**: PIN-secured adjustments represent best-in-class security.
- **Operational Fulfillment**: Both individual and selected-group card, letter, and label workflows are present in Back Office; POS retains the single-customer path.

### ⚠️ Remaining Boundaries
- **Program Expiry**: Points themselves do not currently expire. Consider adding a "Points Dormancy" cleanup job for inactive customers.
- **Tiered Loyalty**: Currently a single-tier threshold; future enhancements could support multiple tiers (e.g., Silver/Gold).
- **Printer/Scanner Hardware**: Automated tests verify API, UI, and printable-document contracts. A controlled store rehearsal is still required to prove the actual scanner, desktop print dialog, label stock, and physical reward cards on deployed hardware.
- **Recent History Window**: The History workspace returns the latest 100 issuance rows. It supports bulk selection within that retained view but is not a full paginated archive.

## 4. Final Verdict
The audited local implementation has complete single and batch reward-card fulfillment paths, retry-safe redemption, authenticated point adjustment, grouped letter/label output, and ledger-backed accrual/clawback behavior. Local automated validation does not prove the migration is installed on the Main Hub or that production scanner/printer hardware has completed a physical rehearsal.
