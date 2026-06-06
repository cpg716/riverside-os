# Payments / Helcim API Audit

## Scope

Inspected `/api/payments` routes, Helcim webhook routes, key payment permission helpers, terminal attempt recovery behavior, deposit reconciliation mutations, and frontend consumers in Payments, POS checkout, Operations Center, Settings, and register close.

## Endpoint Inventory

| Method | Route | Backend Location | Frontend Consumers | Auth | Staff/Manager Access | Mutates State | DB Tables | Tests | Risk | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/payments/config` | `server/src/api/payments.rs` | POS/payment setup | Currently no staff gate in handler | None | No | None | Not traced | Medium | Returns provider config; should stay non-sensitive. |
| GET/PATCH | `/api/payments/providers/active` | `payments.rs` | Operations Center, settings | GET staff or POS session; PATCH `settings.admin` | Staff/POS for read, admin for write | PATCH yes | store/settings provider config | Not traced | High | Active provider is currently constrained to Helcim. |
| GET | `/api/payments/providers/helcim/status` | `payments.rs` | Settings/Payments | `settings.admin` or payment gate depending handler | Staff Access | No | credential status | Not traced | Medium | Must not leak secrets. |
| GET | `/api/payments/providers/helcim/health` | `payments.rs` | Settings health | `settings.admin` | Staff Access | External read | Helcim/config | Helcim health tests exist | High | External provider health may refresh/apply config. |
| PATCH | `/api/payments/providers/helcim/config` | `payments.rs` | Helcim settings panel | `settings.admin` | Manager/Admin | Yes | encrypted integration credentials | Not traced | Critical | Stores API token, device codes, webhook secret. |
| GET/POST | `/api/payments/providers/helcim/fees/status`, `/fees/sync` | `payments.rs` | Payments workspace | `payments.view`, `payments.sync` | Staff Access | Sync yes | provider fee/batch transaction tables | Not traced | High | External sync and reconciliation assumptions. |
| GET/POST | `/api/payments/providers/helcim/settlements/status`, `/settlements/sync` | `payments.rs` | Payments workspace | `payments.view`, `payments.sync` | Staff Access | Sync yes | settlements/batches | Not traced | High | Settlement sync affects reconciliation. |
| GET | `/api/payments/providers/helcim/operations/overview` | `payments.rs` | Payments workspace | `payments.view` | Staff Access | No | payment provider tables | Not traced | Medium | Operational dashboard. |
| GET | `/api/payments/providers/helcim/batches` | `payments.rs` | Payments workspace | `payments.view` | Staff Access | No | `payment_provider_batches` | Not traced | Medium | Expected deposit source. |
| GET | `/api/payments/providers/helcim/batches/{id}` | `payments.rs` | Payments workspace | `payments.view` | Staff Access | No | batch/detail tables | Not traced | Medium | Batch detail. |
| GET | `/api/payments/providers/helcim/batches/{id}/transactions` | `payments.rs` | Payments workspace | `payments.view` | Staff Access | No | provider transactions | Not traced | Medium | Transaction-level provider data. |
| GET | `/api/payments/providers/helcim/reconciliation/items` | `payments.rs` | Payments/Operations | `payments.view` | Staff Access | No | reconciliation item tables | Not traced | High | Open issue list. |
| PATCH | `/api/payments/providers/helcim/reconciliation/items/{id}/status` | `payments.rs` | Payments workspace | `payments.reconcile.*` | Staff Access | Yes | reconciliation items/events | Not traced | Critical | Resolves/changes payment reconciliation issue status. |
| POST | `/api/payments/providers/helcim/reconciliation/items/{id}/notes` | `payments.rs` | Payments workspace | `payments.reconcile.review` | Staff Access | Yes | reconciliation notes/events | Not traced | Medium | Audit note side effect. |
| GET | `/api/payments/providers/helcim/reconciliation/items/{id}/candidate-payments` | `payments.rs` | Payments workspace | `payments.reconcile.link` or view gate | Staff Access | No | payment candidates | Not traced | High | Supports manual payment linkage. |
| POST | `/api/payments/providers/helcim/reconciliation/items/{id}/link-payment` | `payments.rs` | Payments workspace | `payments.reconcile.link` | Staff Access | Yes | reconciliation item/payment link tables | Not traced | Critical | Links provider activity to Riverside payment. |
| GET | `/api/payments/providers/helcim/transactions` | `payments.rs` | Payments workspace | `payments.view` | Staff Access | No | provider transactions | Not traced | Medium | Provider transaction list. |
| GET | `/api/payments/providers/helcim/transactions/{id}` | `payments.rs` | Payments workspace | `payments.view` | Staff Access | No | provider transaction detail | Not traced | Medium | Detail read. |
| GET | `/api/payments/providers/helcim/sync/runs` | `payments.rs` | Payments workspace | `payments.view` | Staff Access | No | sync run logs | Not traced | Medium | Sync history. |
| GET | `/api/payments/providers/helcim/events/health` | `payments.rs` | Operations Center | `payments.view` | Staff Access | No | Helcim event log | Not traced | High | Webhook durability health. |
| POST | `/api/payments/providers/helcim/events/{id}/replay` | `payments.rs` | Payments ops | `payments.sync` or reconcile permission | Staff Access | Yes | event log, payment attempts | Not traced | Critical | Replays provider event effects. |
| POST | `/api/payments/providers/helcim/terminal/recovery-actions` | `payments.rs` | POS/payment recovery | Staff/POS with payment gate | Staff/POS context | Yes | terminal recovery action table | Not traced | Critical | Manual recovery path for terminal attempts. |
| GET | `/api/payments/providers/helcim/terminal/card-terminals` | `payments.rs` | POS/settings | Staff/POS or view gate | Staff/POS context | No | config/provider | Not traced | Medium | Terminal selection. |
| GET | `/api/payments/providers/helcim/terminal/devices` | `payments.rs` | Settings/payments | Staff/POS or payment gate | Staff/POS context | External read | provider devices | Not traced | Medium | External provider read. |
| GET/POST | `/api/payments/providers/helcim/terminal/devices/{code}`, `/ping` | `payments.rs` | Settings/payments | Staff/POS or payment gate | Staff/POS context | Ping external | provider devices | Not traced | Medium | Device diagnostic. |
| GET/POST | `/api/payments/providers/helcim/deposits` | `payments.rs` | Payments workspace | GET `payments.view`; POST `payments.deposit.adjust` | Staff Access | POST yes | `payment_actual_deposits`, event tables | Not traced | Critical | Actual bank deposit records. |
| GET | `/api/payments/providers/helcim/deposits/unmatched-batches` | `payments.rs` | Payments workspace | `payments.view` | Staff Access | No | expected batch tables | Not traced | High | Reconciliation candidate source. |
| GET | `/api/payments/providers/helcim/deposits/unmatched-deposits` | `payments.rs` | Payments workspace | `payments.view` | Staff Access | No | actual deposit tables | Not traced | High | Reconciliation candidate source. |
| POST | `/api/payments/providers/helcim/deposits/reconciliation/runs` | `payments.rs` | Payments workspace | `payments.deposit.review/link/adjust` | Staff Access | Yes | reconciliation item tables | Not traced | Critical | Creates reconciliation issues. |
| GET | `/api/payments/providers/helcim/deposits/{id}` | `payments.rs` | Payments workspace | `payments.view` | Staff Access | No | deposit detail/event/link tables | Not traced | Medium | Actual deposit detail. |
| POST | `/api/payments/providers/helcim/deposits/{id}/link-batches` | `payments.rs` | Payments workspace | `payments.deposit.link` | Staff Access | Yes | deposit-batch links, reconciliation items/events | Not traced | Critical | Manual bank-to-batch linking. |
| POST | `/api/payments/providers/helcim/deposits/{id}/notes` | `payments.rs` | Payments workspace | `payments.deposit.review` | Staff Access | Yes | deposit event table | Not traced | Medium | Review note. |
| PATCH | `/api/payments/providers/helcim/deposits/{id}/review` | `payments.rs` | Payments workspace | `payments.deposit.review` or `payments.deposit.adjust` if variance accepted | Staff Access | Yes | deposit status, reconciliation items, events | Not traced | Critical | Accepts variance or marks deposit reviewed. |
| POST | `/api/payments/providers/helcim/deposits/{id}/reopen` | `payments.rs` | Payments workspace | `payments.deposit.review` | Staff Access | Yes | deposit status/events | Not traced | High | Reopens reviewed deposit. |
| POST | `/api/payments/providers/helcim/purchase` | `payments.rs` | POS card reader checkout | POS staff/session or payment permission fallback | Staff/POS context | Yes | payment provider attempts | Helcim purchase mapping tests exist | Critical | Starts terminal purchase with idempotency key. |
| POST | `/api/payments/providers/helcim/terminal/refund` | `payments.rs` | Refund flow | payment/refund permission | Staff Access | Yes | provider attempts/refunds | Not traced | Critical | Terminal refund. |
| POST | `/api/payments/providers/helcim/card-token/purchase` | `payments.rs` | Saved-card payment | payment permission/customer context | Staff Access | Yes | payment records/provider attempts | Not traced | Critical | Charges saved card token. |
| POST | `/api/payments/providers/helcim/card/refund` | `payments.rs` | Refund flow | payment/refund permission | Staff Access | Yes | payment/refund records | Not traced | Critical | Card refund. |
| POST | `/api/payments/providers/helcim/card/reverse` | `payments.rs` | Reversal flow | payment/refund permission | Staff Access | Yes | payment/reversal records | Not traced | Critical | Card reversal/void. |
| POST | `/api/payments/providers/helcim/helcim-pay/initialize` | `payments.rs` | Storefront/web checkout | Store/session context | Public checkout context | Yes | checkout session/provider attempt | Not traced | Critical | Hosted payment initialization. |
| POST | `/api/payments/providers/helcim/helcim-pay/confirm` | `payments.rs` | Storefront/web checkout | Store/session context | Public checkout context | Yes | checkout session/provider attempt/order | Not traced | Critical | Hosted payment confirmation. |
| GET | `/api/payments/providers/helcim/customers` | `payments.rs` | Customer/payment admin | customer/payment permissions | Staff Access | No external/provider read | provider customer mapping | Not traced | Medium | Must avoid leaking card data. |
| GET | `/api/payments/providers/helcim/customers/{customer_id}/cards` | `payments.rs` | Customer payment admin | customer/payment permissions | Staff Access | No | provider card metadata | Not traced | High | Card metadata only, no raw card data. |
| DELETE | `/api/payments/providers/helcim/customers/{customer_id}/cards/{card_id}` | `payments.rs` | Customer payment admin | customer/payment permissions | Staff Access | Yes external/provider | provider card metadata | Not traced | High | Deletes saved card. |
| PATCH/POST | `/api/payments/providers/helcim/customers/{customer_id}/cards/{card_id}/default` | `payments.rs` | Customer payment admin | customer/payment permissions | Staff Access | Yes | provider card metadata | Not traced | Medium | Sets default card. |
| GET | `/api/payments/providers/helcim/attempts/{id}` | `payments.rs` | POS checkout polling | POS/session/payment context | Staff/POS context | No | payment provider attempts | Not traced | High | Attempt status drives checkout. |
| GET | `/api/payments/providers/helcim/attempts/{id}/stream` | `payments.rs` | POS SSE stream | POS/session/payment context | Staff/POS context | No stream | payment provider attempts | Not traced | High | SSE plus polling fallback. |
| POST | `/api/payments/providers/helcim/attempts/{id}/release` | `payments.rs` | POS recovery | POS/session/payment context | Staff/POS context | Yes | provider attempt lock/status | Not traced | High | Releases terminal attempt lock. |
| POST | `/api/payments/providers/helcim/attempts/{id}/simulate` | `payments.rs` | E2E/dev | simulator/config gate expected | Staff/POS context | Yes | provider attempts | Not traced | High | Must remain gated to simulator/dev conditions. |
| POST | `/api/webhooks/helcim` and `/api/webhooks/card-events` | `server/src/api/webhooks.rs` | Helcim provider | Helcim HMAC/webhook secret | Provider auth | Yes | `helcim_event_log`, payment attempts, checkout recovery | Webhook verification tests exist | Critical | Provider-signed inbound event path. |

## Contract Notes

- Helcim terminal payment attempts carry `idempotency_key`, `register_session_id`, selected terminal route, override staff/reason metadata, provider payment/transaction IDs, and status timestamps.
- Manual actual deposits do not create QBO deposits or mutate payment/batch money fields directly; they reconcile expected provider batches to actual bank deposit records.
- The code distinguishes expected deposits (batch-based) from actual bank deposits.

## Permission Notes

- Payments has a local `require_payment_permission` helper that resolves effective permissions and supports selected fallback permissions.
- General settings writes use `settings.admin`.
- Sync operations use `payments.sync`.
- Reconciliation and deposit operations split across `payments.reconcile.*`, `payments.deposit.review`, `payments.deposit.link`, and `payments.deposit.adjust`.
- POS terminal operations may allow a valid POS register session where payment permission is not appropriate for the register workflow.

## Mutation / Side Effect Notes

- Helcim purchase/refund/reverse endpoints talk to the external provider and persist payment provider attempts.
- Helcim card refund/reverse now reuse an existing scoped provider attempt for a repeated client idempotency key before making another provider call.
- Webhook handling persists provider events and can recover/finalize pending checkout attempts.
- Deposit review/link operations write actual deposit events and reconciliation issue status changes.

## Transaction / Idempotency Notes

- Terminal attempts include idempotency keys and final-status skip helpers.
- Card refund/reverse requests with a repeated client idempotency key return the existing scoped Helcim attempt, including concurrent duplicate insert races.
- Deposit create/link/review/reopen handlers use SQL transactions and event rows.
- Follow-up should add endpoint tests for provider charge/refund idempotency and provider retry handling.

## Audit Trail Notes

- Deposit actions insert deposit event rows with staff id and before/after payloads.
- Terminal override fields include staff and reason.
- Webhook events persist raw payloads and statuses in `helcim_event_log`.

## Test Coverage

- `server/src/api/webhooks.rs` includes Helcim webhook signature and final-status tests.
- `server/src/api/payments.rs` includes Helcim terminal purchase error mapping tests.
- `server/src/api/payments.rs` includes unit coverage proving pending card refund/reverse idempotency replay returns the cached attempt without provider refresh.
- `server/src/logic/helcim.rs` includes provider helper tests.
- Missing: endpoint-level RBAC tests for every payment mutation, duplicate webhook replay tests, and terminal attempt release/simulate guard tests.

## Risks

- Critical: provider purchase/refund/reverse, hosted pay confirm, webhook recovery, deposit variance acceptance, reconciliation link-payment.
- High: sync endpoints, terminal attempt release, device/terminal override, saved-card deletion.
- Medium: payment reads and status diagnostics.

## Recommended Follow-Up

- Add a payment endpoint permission matrix test for `payments.view`, `payments.sync`, reconcile, deposit review/link/adjust, and POS-session fallback.
- Add duplicate webhook replay tests for approved, failed, cancelled, and already-final attempts.
- Confirm `simulate` is unreachable in production-like configuration.
