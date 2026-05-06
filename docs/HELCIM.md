# Helcim integration

**Purpose:** Canonical contract for how Riverside OS uses Helcim for POS and Payments Operations.

This document covers register card payments, terminal readiness, refunds/reverses, webhooks, settlement, reconciliation, deposits, credentials, and provider-attempt audit behavior. Public online store checkout details remain in [`ONLINE_STORE.md`](ONLINE_STORE.md).

Primary code paths:

- Server API: [`server/src/api/payments.rs`](../server/src/api/payments.rs)
- Webhook intake: [`server/src/api/webhooks.rs`](../server/src/api/webhooks.rs)
- Provider client: [`server/src/logic/helcim.rs`](../server/src/logic/helcim.rs)
- Refund queue processing: [`server/src/api/transactions.rs`](../server/src/api/transactions.rs)
- Payments workspace: [`client/src/components/payments/PaymentsWorkspace.tsx`](../client/src/components/payments/PaymentsWorkspace.tsx)
- Helcim Settings: [`client/src/components/settings/HelcimSettingsPanel.tsx`](../client/src/components/settings/HelcimSettingsPanel.tsx)

External standard: [Helcim Developer Docs](https://devdocs.helcim.com/docs/welcome-to-helcim).

## Ownership boundary

ROS owns:

- Encrypted Helcim credentials and readiness checks.
- POS terminal purchase attempts.
- Direct card refund/reverse attempts.
- Queued POS/Orders refund provider-attempt audit.
- Saved-card purchase support through Helcim card tokens.
- Customer/card lookup and card management helpers used by ROS payment flows.
- Durable Helcim webhook event log and replay of failed stored events.
- Payment Operations dashboard, batches, transactions, reconciliation issues, sync runs, fee/net readiness, terminal health, and actual bank deposit matching.
- Operational alerts for payment health, reconciliation, deposits, and sync failures.

Helcim remains the system of record for:

- Merchant account configuration.
- Hardware enrollment, pairing, location assignment, and terminal API-mode setup.
- Processor disputes, chargebacks, raw provider evidence, and merchant-level risk settings.
- Provider-side ACH, Fee Saver, and other merchant-program settings unless ROS explicitly adopts them later.

ROS does not create QBO deposits, automate bank-feed matching, infer missing Helcim fees/net amounts, or mutate processor truth.

## API surface

All routes below are mounted under `/api/payments`.

Configuration and provider state:

- `GET /providers/active`
- `PATCH /providers/active`
- `GET /providers/helcim/status`
- `PATCH /providers/helcim/config`
- `GET /providers/helcim/fees/status`

POS and payment attempts:

- `POST /providers/helcim/purchase`
- `POST /providers/helcim/terminal/refund`
- `POST /providers/helcim/card-token/purchase`
- `POST /providers/helcim/card/refund`
- `POST /providers/helcim/card/reverse`
- `GET /providers/helcim/attempts/{id}`
- `POST /providers/helcim/attempts/{id}/simulate` for local/e2e simulation only.

HelcimPay.js provider boundary:

- `POST /providers/helcim/helcim-pay/initialize`
- `POST /providers/helcim/helcim-pay/confirm`

Customer and card helpers:

- `GET /providers/helcim/customers`
- `GET /providers/helcim/customers/{customer_id}/cards`
- `DELETE /providers/helcim/customers/{customer_id}/cards/{card_id}`
- `PATCH|POST /providers/helcim/customers/{customer_id}/cards/{card_id}/default`

Terminal and hardware readiness:

- `GET /providers/helcim/terminal/card-terminals`
- `GET /providers/helcim/terminal/devices`
- `GET /providers/helcim/terminal/devices/{code}`
- `POST /providers/helcim/terminal/devices/{code}/ping`

Settlement, reconciliation, deposits, and health:

- `POST /providers/helcim/fees/sync`
- `GET /providers/helcim/settlements/status`
- `POST /providers/helcim/settlements/sync`
- `GET /providers/helcim/operations/overview`
- `GET /providers/helcim/batches`
- `GET /providers/helcim/batches/{id}`
- `GET /providers/helcim/batches/{id}/transactions`
- `GET /providers/helcim/transactions`
- `GET /providers/helcim/transactions/{id}`
- `GET /providers/helcim/sync/runs`
- `GET /providers/helcim/events/health`
- `POST /providers/helcim/events/{id}/replay`
- Reconciliation item review, notes, payment linking, deposit creation, deposit review, batch linking, and deposit reconciliation routes in `payments.rs`.

Webhook intake:

- `POST /api/webhooks/helcim`

## Financial safety invariants

- `payment_provider_attempts` is the durable audit trail for provider calls. A failed attempt is evidence only and must not by itself create or mutate `payment_transactions`.
- Terminal purchases and terminal refunds create pending provider attempts before provider completion.
- Direct card refund/reverse routes create and update provider attempts with Helcim response data.
- Queued POS/Orders card refunds create provider-attempt audit data before ROS writes the negative payment.
- ROS writes the queued refund payment, allocation, refund queue update, and transaction paid amount only after Helcim returns an approved/captured refund status.
- Helcim request errors, declines, or rate limits leave ROS refund state unchanged and persist the failed provider attempt for review.
- Idempotency keys are deterministic for provider attempts. Queued refunds include the refund queue row, original Helcim transaction id, prior refunded cents, and current amount cents.
- Provider 429/rate-limit responses must remain visible as provider errors; they are not silently hidden as generic failures.

## Terminal and hardware behavior

- Terminal device and card-terminal endpoints are read-only except `ping`.
- `ping` checks whether the Helcim device is reachable/listening and does not create payment attempts, payment transactions, allocations, settlement rows, or reconciliation records.
- Device codes are configured through Settings -> Helcim or deployment fallbacks. Daily readiness belongs in Payments -> Health.
- ROS can initiate terminal purchase attempts and terminal refund attempts for configured devices, but Helcim dashboard remains required for hardware enrollment, pairing, and provider-side device assignment.

## Webhook behavior

- Inbound Helcim webhooks require signature verification and timestamp freshness before processing.
- Accepted events are stored in `helcim_event_log` before mutation.
- Stored payloads are redacted for card-sensitive fields.
- Duplicate events do not re-enter processing once already processed or ignored.
- Unknown Helcim events are stored and marked ignored instead of failing the whole intake.
- Replay is intentionally narrow: only stored failed Helcim events can be replayed, and replay uses the existing event-log payload. Callers cannot submit raw replay payloads or bypass the event log.

## Settlement and deposits

- Batch and transaction sync stores provider batch headers and batch membership separately from ROS payment rows.
- Fee and net values are applied only when Helcim explicitly provides them. Missing values are tracked as not ready, not estimated and not treated as zero.
- Reconciliation issues compare ROS payment truth against Helcim processor truth and record staff review history.
- Actual bank deposits are external evidence entered or imported into ROS for matching. Matching expected Helcim batches to actual deposits does not create QBO deposits, post bank-feed transactions, or mutate processor/payment amounts.

## Credentials and PCI boundary

- Helcim API token, terminal codes, and webhook secret are saved through encrypted integration credentials or deployment fallbacks.
- Client-facing config/status responses expose readiness only, not raw secrets.
- ROS must not store PAN or CVV. Stored card data is limited to provider-safe token references and masked metadata.
- Webhook payload storage redacts card-sensitive fields.

## Out of scope unless explicitly adopted

- ACH/bank account payments.
- Fee Saver.
- Provider-managed partial-payment programs.
- Level 2/Level 3 optimized interchange payload expansion.
- Dashboard-free merchant onboarding, hardware enrollment, disputes, and chargeback operations.
- Online-store product scope beyond the shared provider boundary documented here.

## Related docs

- Staff operations: [`staff/payments-operations.md`](staff/payments-operations.md)
- Refund queue behavior: [`TRANSACTION_RETURNS_EXCHANGES.md`](TRANSACTION_RETURNS_EXCHANGES.md)
- Settlement/schema contract: [`SCHEMA_CONTRACT_AND_MIGRATIONS.md`](SCHEMA_CONTRACT_AND_MIGRATIONS.md)
- Integration posture: [`INTEGRATIONS_SCOPE.md`](INTEGRATIONS_SCOPE.md)
- QBO clearing behavior: [`QBO_JOURNAL_TEST_MATRIX.md`](QBO_JOURNAL_TEST_MATRIX.md)
