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

## Provider-Neutral Payment Metadata

Stripe remains the current/default processor for integrated card workflows. ROS also stores additive provider-neutral metadata on `payment_transactions` so future processors can be represented without removing or repurposing the existing Stripe fields.

Provider-neutral fields include:
- `payment_provider`
- `provider_payment_id`
- `provider_status`
- `provider_terminal_id`
- `provider_transaction_id`
- `provider_auth_code`
- `provider_card_type`

For existing Stripe payments, `payment_provider` is `stripe` and `provider_payment_id` mirrors `stripe_intent_id`. The original `stripe_intent_id`, `stripe_customer_id`, and `stripe_payment_method_id` fields remain the Stripe compatibility source of truth.

No Helcim purchase, refund, settings, or webhook behavior is implemented by this metadata foundation. Helcim, if added later, must use its own server-side provider adapter and must not change the existing Stripe/WisePOS E behavior.

---

## 🧪 Environmental Requirements

Runtime environment variables used by the shipped Stripe integration:
- `STRIPE_SECRET_KEY`: Server-side API authentication for PaymentIntents, refunds, and vault linkage.
- `STRIPE_PUBLIC_KEY`: Publishable key returned by `GET /api/payments/config` for Stripe Elements card vaulting.
- `STRIPE_WEBHOOK_SECRET`: Optional signing secret for `POST /api/webhooks/stripe` exact fee reconciliation.

Strict-production behavior:
- `RIVERSIDE_STRICT_PRODUCTION=true` requires a live `STRIPE_SECRET_KEY` (`sk_live_...`).
- `RIVERSIDE_STRICT_PRODUCTION=true` also requires a live `STRIPE_PUBLIC_KEY` (`pk_live_...`) because the shipped vaulting flow depends on it.
- `STRIPE_WEBHOOK_SECRET` remains optional, but if configured it must be a valid Stripe signing secret (`whsec_...`).
