# Audit Report: Gift Card Subsystem (2026)
**Date:** 2026-04-08
**Status:** Hardened / Ledger-First

## 1. Executive Summary
The Riverside OS Gift Card subsystem provides a closed-loop value storage and redemption system. It is designed around a **ledger-first model**, where every balance change is tracked as a discrete event in the `gift_card_events` table.

## 2. Component Analysis

### 2.1 Card Taxonomy
| Kind | Use Case | Liability? | Expiry |
| :--- | :--- | :--- | :--- |
| **Purchased** | Sold or reloaded through Register. | ✅ Yes | 9 Years |
| **Loyalty Reward** | Exchanged for CRM points. | ❌ No | 1 Year |
| **Donated / Giveaway** | Promotional / Community support. | ❌ No | 1 Year |

### 2.2 Back Office Management (`GiftCardsWorkspace.tsx`)
- **Issuance**: Back Office supports non-liability donated/giveaway issuance only. Purchased cards are Register-only so sale, tender, card event, and liability accounting stay linked.
- **Voiding**: Safe voiding workflow with a confirmation modal and negative ledger entry for remaining balance.
- **Status Mapping**: Correctly maps statuses: `active`, `depleted`, `void`.

### 2.3 POS Loading & Activation (`RegisterGiftCardLoadModal.tsx`)
- **Workflow**: Gift cards are "loaded" as a cart line item.
- **Activation Trigger**: Credits the balance **only** when the sale is fully paid. This prevents "free money" exploits if a sale is cancelled after a card is scanned.
- **Safety**: UI performs real-time lookups while typing to prevent loading onto voided or non-purchased cards.

### 2.4 Redemption & Checkout (`NexoCheckoutDrawer.tsx`)
- **Tender Integration**: Gift cards are a first-class tender type in the checkout drawer.
- **Partial Payments**: Full support for splitting a sale across multiple gift cards or combining them with cash/card.

### 2.5 Integrity & Security (`gift_card_ops.rs`)
- **Transaction Safety**: All balance changes use `FOR UPDATE` row-level locking.
- **Audit Trail**: Captures `event_kind`, `amount`, `balance_after`, and associated `order_id` / `session_id`.
- **Operational Alerts**: "Direct Load" API calls trigger an `app_notification` to "Sales Support" staff.

## 3. Findings & Recommendations

### ✅ Strengths
- **Accounting Integrity**: The distinction between liability and non-liability cards is handled correctly.
- **Atomic Reliability**: Use of PostgreSQL transactions ensures balance deduction/addition is never orphaned.
- **Operational Awareness**: Real-time lookup during loading provides high guardrails.

### ⚠️ Recommendations
- **Balance Adjustment History**: While the `gift_card_events` API exists, the Back Office Workspace does not currently display a "History" tab for a selected card.
- **Manual Balance Override**: There is currently no UI for adjusting a card balance manually (e.g., fixing a mistake). Admins must void and re-issue.

## 4. Final Verdict
The Gift Card subsystem is **hardened and operationally sound**. The ledger model is robust, and the POS/Back Office separation reflects high-quality financial engineering.
