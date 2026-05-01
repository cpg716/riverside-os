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

Stripe remains the default compatibility processor for integrated card workflows, but Settings > Payment Processing now selects the active card terminal provider before go-live. Valid active providers are `stripe` and `helcim`. Neither provider should be assumed live until its environment values, terminal/device setup, and supervised store test are complete.

Provider-neutral fields include:
- `payment_provider`
- `provider_payment_id`
- `provider_status`
- `provider_terminal_id`
- `provider_transaction_id`
- `provider_auth_code`
- `provider_card_type`

For existing Stripe payments, `payment_provider` is `stripe` and `provider_payment_id` mirrors `stripe_intent_id`. The original `stripe_intent_id`, `stripe_customer_id`, and `stripe_payment_method_id` fields remain the Stripe compatibility source of truth.

Refunds and saved-card/vaulting remain future provider-specific work. Existing Stripe fields are preserved and are not removed or repurposed by the provider-neutral metadata foundation.

### Provider Attempt Records

ROS also includes a provider-neutral `payment_provider_attempts` table for future terminal-provider control flow. These records are audit/control rows for a payment attempt lifecycle, not payment ledger rows and not revenue records.

Attempt records capture:
- provider and status
- amount/currency
- register session and staff context
- device or terminal identity
- provider/idempotency references
- redacted error/audit references

Stripe checkout behavior is unchanged and continues to use the existing Stripe PaymentIntent path when Stripe is the active provider. Helcim uses attempt rows to track pending, approved, canceled, failed, and completed terminal states before any approved payment is recorded in `payment_transactions`.

### Active Card Provider Setting

`store_settings.active_card_provider` controls which provider the POS card reader tender uses:
- `stripe` is the default for compatibility.
- `helcim` sends card reader purchases through the Helcim device provider path.

`GET /api/payments/providers/active` returns the selected provider plus Stripe and Helcim configuration status. `PATCH /api/payments/providers/active` is `settings.admin` gated and changes the selected provider. POS reads the same setting before starting a card reader payment and never falls back to the other provider after a payment starts.

### Helcim Backend Configuration And Attempts

The backend can detect Helcim configuration and start a terminal purchase attempt when Helcim is selected. `GET /api/payments/providers/helcim/status` is a `settings.admin` read-only status endpoint that reports whether the server has the required Helcim environment values. It returns only enabled/configured booleans, a masked device-code suffix, the API base host, and missing-config notes.

Settings > Payment Processing shows Stripe status, Helcim status, the active provider, and warnings when the selected provider is not fully configured.

Server-side Helcim environment variables:
- `HELCIM_API_TOKEN`
- `HELCIM_DEVICE_CODE`
- `HELCIM_API_BASE_URL` (optional; defaults to `https://api.helcim.com/v2`)

`HELCIM_API_TOKEN` must remain server-side only. It is never returned by status or purchase endpoints and must not be placed in client env files or browser-visible settings.

`POST /api/payments/providers/helcim/purchase` creates a `payment_provider_attempts` row, enforces one pending Helcim attempt per configured device, sends the purchase request to Helcim, and treats Helcim `202 Accepted` as `pending`. POS shows the pending state and does not add a completed tender or finalize checkout until approval is confirmed through `GET /api/payments/providers/helcim/attempts/{id}`. Webhook confirmation, refunds, and saved-card/vaulting are not implemented in this phase.

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
