# POS / Register API Audit

## Scope

Inspected `/api/transactions`, `/api/sessions`, and `/api/pos` route registrations, selected permission gates, checkout transaction usage, register session token middleware, POS frontend consumers, and existing register/transaction docs.

## Endpoint Inventory

| Method | Route | Backend Location | Frontend Consumers | Auth | Staff/Manager Access | Mutates State | DB Tables | Tests | Risk | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/transactions` | `server/src/api/transactions.rs` | Orders, POS order load, customer hub, transaction search | `orders.view` | Staff Access | No | `transactions`, `transaction_lines`, customer/payment joins | Unit/integration coverage present in module for some reads | Medium | Broad read surface with financial/customer data. |
| GET | `/api/transactions/pipeline-stats` | `transactions.rs` | Operations / order dashboards | `orders.view` | Staff Access | No | Transaction/order summary tables | Not fully traced | Medium | Reporting semantics depend on booked vs fulfilled split. |
| GET | `/api/transactions/refunds/due` | `transactions.rs` | Refund queue / POS operations | `orders.refund_process` | Staff Access | No | Refund/payment tables | Not fully traced | High | Financial refund queue visibility. |
| GET | `/api/transactions/fulfillment-queue` | `transactions.rs` | Operations fulfillment command center | `orders.view` | Staff Access | No | `transactions`, `transaction_lines` | Not fully traced | Medium | Feeds pickup readiness workflows. |
| POST | `/api/transactions/checkout` | `transactions.rs`, `logic/transaction_checkout.rs` | POS cart checkout | POS session token only | Open register session | Yes | `transactions`, `transaction_lines`, `payment_transactions`, `payment_allocations`, register/session, inventory/reservation, loyalty evidence | Checkout logic tests and cart tender tests exist | Critical | Requires `x-riverside-pos-session-id` and token matching payload `session_id`; executes multi-step checkout in DB transaction. QBO sales posting is handled by reviewed Daily Staging Journal, not checkout-time direct outbox posting. |
| PATCH | `/api/transactions/{transaction_id}/attribution` | `transactions.rs` | Transaction attribution modal | `orders.edit_attribution` | Staff Access | Yes | `transactions`, `transaction_lines`, audit log | Not fully traced | High | Changes staff commission attribution. |
| PATCH | `/api/transactions/{transaction_id}/financial-date` | `transactions.rs` | QBO/reporting correction surfaces | `qbo.staging_approve` | Manager-class permission | Yes | `transactions`, audit/QBO-impacting data | Not fully traced | Critical | Alters booked/accounting date semantics. |
| POST | `/api/transactions/{transaction_id}/pickup` | `transactions.rs` | POS order pickup | POS session token only | Open register session; manager override in payload for readiness guards | Yes | `transactions`, `transaction_lines`, inventory, loyalty, lifecycle events | Not fully traced | Critical | Fulfillment and revenue recognition trigger; stock shortages warn/audit but do not block customer release. |
| POST | `/api/transactions/{transaction_id}/review-invite` | `transactions.rs` | Receipt/customer follow-up | `orders.view` or customer messaging context | Staff Access | Yes | notification/review tables | Not fully traced | Medium | Customer communication side effect. |
| GET | `/api/transactions/{transaction_id}/audit` | `transactions.rs` | Transaction detail drawer | `orders.view` | Staff Access | No | audit/event tables | Not fully traced | Medium | Important auditability read. |
| POST | `/api/transactions/{transaction_id}/void` | `transactions.rs` | Transaction detail / POS manager workflow | `orders.refund_process` plus manager data | Manager Access expected | Yes | transactions, void records, refund queue, inventory summary | Not fully traced | Critical | Sensitive financial reversal workflow. |
| POST | `/api/transactions/{transaction_id}/refunds/process` | `transactions.rs` | Refund queue | `orders.refund_process` | Staff Access | Yes | refund/payment allocation tables | Not fully traced | Critical | Direct refund state change. |
| POST | `/api/transactions/{transaction_id}/exchange-settlement` | `transactions.rs` | POS exchange wizard | `orders.refund_process` | Staff Access | Yes | transactions, payment/refund tables | Not fully traced | Critical | Exchange settlement can affect tender and balances. |
| POST | `/api/transactions/{transaction_id}/returns` | `transactions.rs`, `logic/transaction_returns.rs` | Returns/exchanges UI | `orders.modify`; Manager Access required for >60 days | Staff Access / Manager Access | Yes | `transaction_return_lines`, inventory/stock, transaction lines | Not fully traced | Critical | Return window and restock semantics are financial/inventory critical. |
| POST | `/api/transactions/{transaction_id}/exchange-link` | `transactions.rs` | POS exchange cart | `orders.modify` | Staff Access | Yes | exchange link/group fields | Not fully traced | High | Links original and replacement transaction. |
| GET/POST | `/api/transactions/{transaction_id}/items` | `transactions.rs` | POS order load, transaction drawer | `orders.view` read; `orders.modify` write | Staff Access | POST yes | `transaction_lines`, transaction totals/audit | Not fully traced | High | Post-checkout line addition affects financial state. |
| PATCH/DELETE | `/api/transactions/{transaction_id}/items/{transaction_line_id}` | `transactions.rs` | Transaction detail drawer | `orders.modify` | Staff Access | Yes | transaction lines, recalculated totals, audit | Not fully traced | High | Post-checkout financial mutation. |
| POST | `/api/transactions/{transaction_id}/items/{transaction_line_id}/suit-swap` | `transactions.rs` | Transaction detail drawer | `orders.suit_component_swap` | Staff Access | Yes | transaction lines, inventory adjustment/events | Not fully traced | Critical | Inventory-aware component swap. |
| GET | `/api/transactions/{transaction_id}/receipt.escpos` | `transactions.rs` | Receipt modal/printer | `orders.view` or session-scoped read | Staff/POS context | No | transaction receipt joins | Receipt tests touch receipt content | Medium | Customer-facing financial artifact. |
| GET | `/api/transactions/{transaction_id}/receipt.html` | `transactions.rs` | Receipt modal/printer/email | `orders.view` or session-scoped read | Staff/POS context | No | transaction receipt joins | Receipt tests touch receipt content | Medium | Customer-facing financial artifact. |
| POST | `/api/transactions/{transaction_id}/receipt/send-email` | `transactions.rs` | Receipt modal | `orders.view` | Staff Access | Yes external send/log | customer notification/email tables | Not fully traced | Medium | Customer communication side effect. |
| POST | `/api/transactions/{transaction_id}/receipt/send-sms` | `transactions.rs` | Receipt modal | `orders.view` | Staff Access | Yes external send/log | podium/message notification tables | Not fully traced | Medium | Customer communication side effect. |
| GET/PATCH | `/api/transactions/{transaction_id}` | `transactions.rs` | Order/transaction detail drawers | `orders.view` read; `orders.modify`/`orders.cancel` write paths | Staff Access | PATCH yes | `transactions` and related rows | Not fully traced | High | Catch-all must remain after specific routes. |
| GET | `/api/sessions/current` | `sessions.rs` | POS bootstrap, checkout pre-check, customer hub | Staff or POS session | Staff/POS context | No | `register_sessions` | Not fully traced | High | Checkout depends on current-session correctness. |
| GET | `/api/sessions/list-open` | `sessions.rs` | Register pick modal, operations | `register.session_attach` | Staff Access | No | `register_sessions` | Not fully traced | Medium | Lane attach visibility. |
| POST | `/api/sessions/open` | `sessions.rs` | Register overlay | Staff or POS authenticated flow | Staff Access | Yes | `register_sessions`, drawer groups | Not fully traced | Critical | Opens till session and float. |
| POST | `/api/sessions/{session_id}/attach` | `sessions.rs` | Register pick modal | `register.session_attach` | Staff Access | Yes station-bound token issue/session attach | `register_sessions`, `register_session_station_tokens` | Not fully traced | High | Joins open register lane from the current workstation. |
| POST | `/api/sessions/{session_id}/shift-primary` | `sessions.rs` | Register staff handoff | POS token or `register.shift_handoff` | Staff/POS context | Yes | `register_sessions`, staff audit | Not fully traced | High | Changes accountable register staff. |
| POST | `/api/sessions/{session_id}/pos-api-token` | `sessions.rs` | POS session bootstrap | Staff/POS context | Open session | Yes | `register_session_station_tokens` | Not fully traced | High | Issues a bearer-equivalent POS token bound to the current workstation station key. |
| GET | `/api/sessions/{session_id}/reconciliation` | `sessions.rs` | Close register modal | POS token or `register.reports` | Staff/POS context | No | register sessions, payments | Not fully traced | High | Z-close financial evidence. |
| POST | `/api/sessions/{session_id}/adjustments` | `sessions.rs` | Cash adjustment modal | POS token or `register.open_drawer` | Staff/POS context | Yes | cash adjustments/register sessions | Not fully traced | Critical | Cash drawer financial mutation. |
| POST | `/api/sessions/{session_id}/drawer-opens` | `sessions.rs` | Manual drawer open | POS token or permission | Staff/POS context | Yes | drawer open event tables | Not fully traced | High | Physical drawer/audit event. |
| POST | `/api/sessions/{session_id}/begin-reconcile` | `sessions.rs` | Close register modal | POS token or `register.reports` | Staff/POS context | Yes | reconciliation snapshot/session | Not fully traced | Critical | Starts close workflow. |
| POST | `/api/sessions/{session_id}/helcim-close-review/{attempt_id}` | `sessions.rs` | Close register modal | POS token or `register.reports` | Staff/POS context | Yes | Helcim attempt/review data | Not fully traced | High | Payment close review. |
| POST | `/api/sessions/{session_id}/close` | `sessions.rs` | Close register modal | POS token or close permissions | Staff/POS context | Yes | register sessions, tenders, reports | Not fully traced | Critical | Final Z-close. |
| GET | `/api/pos/rms-payment-line-meta` | `pos.rs` | POS payment line modal | Staff/POS context | POS Staff | No | products/variant metadata | Not fully traced | Medium | Adds internal payment line metadata. |
| GET | `/api/pos/gift-card-load-line-meta` | `pos.rs` | Gift card load modal | Staff/POS context | POS Staff | No | products/variant metadata | Not fully traced | Medium | Gift card load financial line metadata. |
| GET | `/api/pos/rms-charge/resolve-account` | `pos.rs` | RMS charge tender | RMS/customer permissions or POS session | Staff/POS context | No | customer/RMS account tables | Not fully traced | High | Payment tender lookup. |
| GET | `/api/pos/rms-charge/programs` | `pos.rs` | RMS charge tender | RMS/customer permissions or POS session | Staff/POS context | No | RMS program tables | Not fully traced | Medium | Tender configuration. |
| POST | `/api/pos/rms-charge/reverse-purchase` | `pos.rs` | RMS admin/reversal | RMS reversal permission | Staff Access | Yes | RMS charge/payment records, access log | Not fully traced | Critical | Payment reversal. |
| POST | `/api/pos/rms-charge/reverse-payment` | `pos.rs` | RMS admin/reversal | RMS reversal permission | Staff Access | Yes | RMS charge/payment records, access log | Not fully traced | Critical | Payment reversal. |
| POST | `/api/pos/shipping/rates` | `pos.rs` | POS shipping modal | POS session/staff | Staff/POS context | No external quote | Shippo/settings quote data | Shippo logic tests exist | High | Quote-only, but checkout may use rate assumptions. |

## Contract Notes

- Checkout payload and response types are exported from `logic/transaction_checkout.rs` through `transactions.rs`.
- Checkout uses `CheckoutRequest.session_id`, `checkoutClientId` idempotency, payment split data, deposit metadata, wedding disbursements, and fulfillment flags.
- Receipt endpoints build customer-facing receipts from transaction detail and must include internal financial lines such as RMS payments and gift card loads.
- Returns use a 60-day manager approval window constant in `transactions.rs`.

## Permission Notes

- Checkout is not general staff-header auth. It requires a valid open register POS token and a matching `session_id`.
- Post-sale mutations split between `orders.modify`, `orders.refund_process`, `orders.cancel`, `orders.void_sale`, `orders.suit_component_swap`, `orders.edit_attribution`, and `qbo.staging_approve`.
- Register close/read paths use POS token or Back Office permissions such as `register.reports`, `register.open_drawer`, `register.shift_handoff`, and `register.session_attach`.

## Mutation / Side Effect Notes

- Checkout is the primary financial write path: transactions, transaction lines, payment transactions, payment allocations, deposit liability metadata, gift cards, loyalty evidence, inventory reservations, wedding disbursements, and receipt data. QBO sales posting remains reviewed Daily Staging Journal only.
- Pickup updates fulfillment/revenue recognition evidence and can affect inventory, loyalty, commission, reporting, and QBO staging inputs.
- Returns, voids, refunds, exchange settlements, and RMS reversals are financial mutation endpoints.

## Transaction / Idempotency Notes

- `execute_checkout` begins a DB transaction and commits only after multi-step checkout work completes. It also has rollback paths around provider/payment failure states.
- `checkoutClientId` appears in checkout logic and docs as the intended idempotency guard.
- Several post-checkout mutation handlers begin explicit SQL transactions.
- Follow-up should verify that every refund/void/exchange mutation has idempotent retry behavior and no direct writes outside the transaction block.

## Audit Trail Notes

- `log_staff_access` is used in several sensitive paths, including QBO and RMS reversal paths.
- Transaction lifecycle events are recorded for line lifecycle transitions.
- Register close, drawer open, and cash adjustment paths should be audited in detail in the next pass.

## Test Coverage

- `server/src/logic/transaction_checkout.rs` contains checkout unit/integration-style tests.
- `client/src/hooks/useCartCheckout.test.jsx` covers tender/deposit split math.
- Receipt behavior has recent targeted coverage per changelog, but endpoint-level receipt authorization coverage was not fully traced.
- Missing: explicit endpoint-level tests for unauthorized checkout, duplicate checkout retry, register close permission boundaries, refund idempotency, and manager override failures.

## Risks

- Critical: checkout, pickup, refunds, voids, exchange settlement, returns, suit swap, cash adjustments, register close.
- High: post-sale line edits, financial date edits, session token issuing, register attach/shift-primary.
- Medium: receipt sends, customer communication side effects, read surfaces with sensitive financial/customer data.

## Recommended Follow-Up

- Add a narrow endpoint authorization matrix test for `transactions.rs` and `sessions.rs`.
- Add duplicate/retry tests for checkout, refund, void, and register close.
- Confirm audit log rows for all Manager Access approvals and POS token session actions.
- Document exact tables touched by close-session and refund workflows after a deeper source trace.
