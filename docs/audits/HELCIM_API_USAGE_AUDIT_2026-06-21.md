# Helcim API Usage Audit - 2026-06-21

## Current architecture

Riverside OS uses Helcim through three production paths:

- `server/src/logic/helcim.rs` owns Helcim API request construction, authentication headers, idempotency headers, response normalization, provider payload redaction, and live terminal/card-terminal health calls.
- `server/src/api/payments.rs` exposes `/api/payments/providers/helcim/*` for terminal purchases/refunds, saved-card/card-token payments, Payment API refunds/reverses, HelcimPay, card/customer storage, batch/fee/deposit/reconciliation operations, terminal routing, event replay, and recovery notes.
- `server/src/api/webhooks.rs` verifies signed Helcim webhooks, stores redacted event evidence in `helcim_event_log`, and links `cardTransaction` / `terminalCancel` events to pending `payment_provider_attempts`.
- POS checkout records approved Helcim attempts as tender evidence through `payment_provider_attempt_id`. Register close blocks unresolved pending/approved-without-ledger Helcim attempts.
- Payments workspace (`client/src/components/payments/PaymentsWorkspace.tsx`) is wired to Helcim operations: overview, transactions, batches, deposits, reconciliation, webhook health, terminal routing, devices/card terminals, event replay, and recovery actions.

## ROS endpoint map

| ROS endpoint | Helcim doc/API concept | Current result |
| --- | --- | --- |
| `POST /api/payments/providers/helcim/purchase` | Hardware API `/devices/{code}/payment/purchase`; `202 Accepted` means request accepted only | Correctly leaves local attempt `pending`; webhook/poll determines final status; active-device unique index blocks overlaps. |
| `POST /api/payments/providers/helcim/terminal/refund` | Hardware API `/devices/{code}/payment/refund`; debit refund requires original debit/card/customer present; `202 Accepted` means accepted only | Fixed: requires explicit customer/original-card-present confirmation and tolerates empty `202` body while remaining pending. |
| `POST /api/payments/providers/helcim/card-token/purchase` | Payment API `payment/purchase` with card token and idempotency key | Uses `api-token`, `idempotency-key`, amount/currency, stores provider IDs/status/card evidence. |
| `POST /api/payments/providers/helcim/card/refund` | Payment API `payment/refund`; closed-batch full/partial refund, customer not present | Uses idempotency, original transaction ID, amount, and records refund attempt/provider evidence. Helcim enforces closed-batch eligibility. |
| `POST /api/payments/providers/helcim/card/reverse` | Payment API `payment/reverse`; open-batch full reverse only | Fixed: now requires Helcim to be active provider before creating a reverse attempt. Payload remains full-reverse only. |
| `POST /api/payments/providers/helcim/helcim-pay/initialize` and `/confirm` | HelcimPay checkout/token flow | Uses active-provider guard, amount/currency, attempt evidence, and confirmation lookup. |
| `/api/payments/providers/helcim/customers*` and `cards*` | Customer/card vault endpoints | Server-side only; token/card data are redacted and not persisted as PAN/CVV. |
| `/api/payments/providers/helcim/batches*`, `settlements/sync`, `fees/sync` | Card batches, transactions, settlement/fee sync | Review-first operations with reconciliation items and no silent accounting mutations. |
| `/api/payments/providers/helcim/deposits*` | Expected processor deposits vs actual bank deposits | Manual/review/link workflow; does not post to QBO or mutate payment totals directly. |
| `/api/webhooks/helcim` | Webhooks for `cardTransaction` and `terminalCancel` | Verifies signature/timestamp, stores redacted payload, handles duplicates idempotently, supports replay for failed events. |

## Helcim requirements verified

Sources used: Helcim Welcome, Payment API, Payments/refund/reverse, Idempotency, Hardware purchase/refund, Webhooks, Card batches/settlements docs.

- Payment API refunds are for original card payments in a closed card batch and can be full or partial.
- Reverse is for an open-batch card payment and is full amount only.
- Customer-not-present credit refunds are represented by Payment API refund against the original Helcim transaction ID, not by terminal hardware.
- Debit hardware refunds require original debit transaction/card/customer-present workflow.
- Hardware purchase/refund `202 Accepted` is not final payment/refund approval.
- Helcim hardware requests are not queued per device; ROS must avoid overlapping terminal requests.
- Idempotency keys are required for Payment API retries.
- Processor transaction IDs, payment IDs, status, auth/code/card metadata, redacted payloads, webhook records, batch/deposit evidence, and recovery notes must remain auditable.

## Confirmed-safe areas

- Terminal purchase flow treats `202` as pending and waits for webhook/poll result.
- Active-device database uniqueness prevents concurrent pending requests on the same terminal/device.
- Two-terminal routing tracks selected terminal key, route source, override staff/reason, device ID, terminal ID, and register lane.
- POS checkout validates approved Helcim attempt ownership and prevents duplicate use of the same provider attempt.
- Register close blocks unresolved Helcim terminal attempts and approved provider results without ROS tender rows.
- Webhooks are signature/timestamp verified, duplicate-safe, redacted, and replayable.
- Payments workspace is wired to transaction, batch, reconciliation, deposit, event-health, device, card-terminal, and recovery endpoints.
- Legacy/pre-ROS or Helcim-dashboard card refunds do not pretend ROS processed a linked API refund; manager-approved manual Helcim refund records explicit external refund reference evidence.
- Split/multiple-card refund allocation is capped by original Helcim tender capacity and refuses over-refunds. Cross-card refunds are intentionally done as separate operator actions to avoid partial provider success hazards.

## Issues fixed in this pass

1. Terminal debit refund could be sent without explicit customer/original-card-present confirmation.
   - Fixed in `server/src/api/payments.rs` and `client/src/components/pos/NexoCheckoutDrawer.tsx`.
2. Hardware terminal refund treated an empty `202 Accepted` response body as an error.
   - Fixed in `server/src/logic/helcim.rs`; empty accepted body now normalizes to pending.
3. Card reverse endpoint did not verify Helcim was the active provider.
   - Fixed in `server/src/api/payments.rs`.
4. Staff workflow documentation did not state the terminal refund customer/card-present requirement.
   - Fixed in `client/src/assets/docs/pos-nexo-checkout-drawer-manual.md`.
5. Manual Helcim/backend refunds needed a first-class external processor reference.
   - Fixed in `server/src/api/transactions.rs`, `client/src/components/orders/OrdersWorkspace.tsx`, and `client/src/components/pos/PosRefundModal.tsx`.

## Remaining risks / merchant confirmation

- Helcim closed-batch/open-batch eligibility is still provider-enforced at refund/reverse time. ROS stores batch data when synced, but does not yet pre-block every refund/reverse based on a guaranteed fresh batch state.
- Merchant-specific support for standalone/unlinked refunds remains intentionally unsupported unless confirmed and explicitly configured later.
- Physical-device smoke testing is still required with both Helcim terminals: purchase, cancel, accepted-then-approved webhook, accepted-then-timeout/recovery, debit refund with original card, and concurrent terminal use.
- Settlement/fee availability depends on Helcim batch timing; Payments workspace presents not-ready/review states instead of posting estimates.

## Migrations

No schema migration was required. Existing `payment_provider_attempts`, `helcim_event_log`, payment provider batch/deposit/reconciliation tables already store the evidence needed for this pass.

## Targeted validation plan

- `cargo test -p riverside-server helcim --lib`
- `cargo test -p riverside-server payments::tests::terminal_refund_request_confirmation_defaults_to_false --lib`
- `npm run check:server`
- `npm run lint`
- `cd client && npm run typecheck`
- `npm run check:help-impact`
- Targeted Playwright where a local E2E stack is available: `api-gates.spec.ts`, `payments-operations-contract.spec.ts`, `payments-operations-ui.spec.ts`, `register-close-reconciliation.spec.ts`, and tender/refund specs covering terminal attempts and split tender refunds.
