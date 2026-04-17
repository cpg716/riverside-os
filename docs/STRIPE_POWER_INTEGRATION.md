# Stripe Power Integration — Technical Overview

Riverside OS (ROS) includes a "Power Integration" for Stripe that enables secure card vaulting (for phone orders and recurring customers) and unlinked financial credits (for terminal-backed refunds).

---

## 🔒 PCI Compliance & Security

**ROS follows a "Zero-Touch" policy for sensitive payment data.**

1. **No Raw Card Data**: The ROS server never handles, stores, or logs raw Primary Account Numbers (PAN) or CVC codes.
2. **SetupIntents**: Card collection is performed entirely via **Stripe Elements** on the client, which communicates directly with Stripe to generate a tokenized `PaymentMethod`.
3. **Vaulting Partition**: ROS stores only non-sensitive metadata (`last4`, `brand`, `expiry`, and the Stripe `payment_method_id`) in the local database (`customer_vaulted_payment_methods`).

---

## 🛠️ Card Vaulting Lifecycle

### 1. Initiation (Customer Hub)
Staff click **Vault New Card** in the Customer Relationship Hub. This calls `POST /api/payments/customers/{id}/setup-intent`.

### 2. Client-Side Collection
The `StripeVaultCardModal` mounts the Stripe `PaymentElement`. When the user submits:
- Client calls `stripe.confirmSetup()`.
- Stripe validates the card and returns a `payment_method` ID.

### 3. Server-Side Linkage
The client sends the `payment_method_id` to `POST /api/payments/customers/{id}/payment-methods/record`. 
The server:
- Fetches the `PaymentMethod` object from Stripe to verify metadata.
- Attaches the `PaymentMethod` to the Stripe `Customer` (created on-the-fly if missing).
- Records the metadata in the ROS `customer_vaulted_payment_methods` table.

---

## 💳 Using Vaulted Cards (POS)

When a customer is linked to a POS cart, the **STRIPE VAULT** tab appears in the checkout drawer.

- **Offline / Phone Orders**: Staff can charge a vaulted card without the physical reader.
- **Workflow**: Selecting a saved card calls `POST /api/payments/intent` with the `payment_method_id`.
- **Off-Session Logic**: The server marks the `PaymentIntent` as `off_session: true` to bypass 3DS challenges where the customer is not present.

---

## 🔄 Unlinked Terminal Credits

ROS supports issuing credits directly to a customer's card via the Stripe terminal, even if there is no previous transaction to "refund."

- **Trigger**: When the cart balance is negative (e.g., a return for a customer who originally paid cash or on a different card).
- **STRIPE CREDIT Tab**: Appears only when `amount_due < 0`.
- **Mechanism**: The server creates a special `PaymentIntent` with the negative amount. The terminal recognizes this as an **unlinked credit** and prompts the customer to insert/tap their card.
- **Accounting**: These are tracked as `card_credit` tender types in the daily journal for QBO reconciliation.

---

## 🏗️ Technical Map

| Logic | Location |
|-------|----------|
| **Backend Logic** | `server/src/logic/stripe_vault.rs` |
| **Axum API** | `server/src/api/payments.rs` |
| **Element Modal** | `client/src/components/customers/StripeVaultCardModal.tsx` |
| **POS UI** | `client/src/components/pos/NexoCheckoutDrawer.tsx` |
| **Database** | `customer_vaulted_payment_methods` (Migration 131) |

---

## 🧪 Environmental Requirements

The following environment variables must be set:
- `STRIPE_SECRET_KEY`: Server-side API authentication.
- `VITE_STRIPE_PUBLIC_KEY`: Client-side Stripe Elements initialization.
