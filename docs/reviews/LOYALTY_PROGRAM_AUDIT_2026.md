# Audit Report: Loyalty Subsystem (2026)
**Date:** 2026-04-08
**Status:** Consumption-Based / Fulfillment-Gated

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
- **Security**: Manual point adjustments require **Manager Cashier Code + PIN** authentication, independent of the active session.

### 2.4 POS Redemption (`LoyaltyRedeemDialog.tsx`)
- **Conversion Workflow**: When a reward is redeemed:
  1. Points are deducted from the customer's CRM profile.
  2. The value can be **applied directly** to the current sale (POS tender).
  3. Any **remainder** is loaded onto a non-liability "Loyalty Reward" gift card for future use.
- **Customer Engagement**: Integrated with **Podium** to send an optional SMS/Email notification.

## 3. Findings & Recommendations

### ✅ Strengths
- **Fulfillment-Gated Accrual**: Technical superior; many systems accrue on payment, leading to complex reversal needs for deposits.
- **Flexible Redemption**: "Remainder to Gift Card" logic is a premium retail experience.
- **Security Guardrails**: PIN-secured adjustments represent best-in-class security.

### ⚠️ Recommendations
- **Program Expiry**: Points themselves do not currently expire. Consider adding a "Points Dormancy" cleanup job for inactive customers.
- **Tiered Loyalty**: Currently a single-tier threshold; future enhancements could support multiple tiers (e.g., Silver/Gold).

## 4. Final Verdict
The Loyalty subsystem is **operationally mature and robust**. The integration between POS redemption and the Gift Card ledger system is seamless, and the fulfillment-based accrual engine provides high data integrity.
