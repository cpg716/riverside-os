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
- POS terminal purchase attempts, hosted manual-card attempts, and terminal refund attempts.
- Direct card refund/reverse attempts where an original Helcim transaction id is already known and the workflow is explicitly not asking staff to type card data into ROS, including the POS Payments standalone refund action.
- Queued POS/Orders refund provider-attempt audit.
- Saved-card purchase support through Helcim card tokens.
- Customer/card lookup and card management helpers used by ROS payment flows.
- Durable Helcim webhook event log and replay of failed stored events.
- Payment Operations dashboard, batches, transactions, reconciliation issues, sync runs, fee/net readiness, terminal health, and actual bank deposit matching.
- Operational alerts for payment health, reconciliation, deposits, and sync failures.

Helcim remains the system of record for:

- Merchant account configuration.
- Hardware enrollment, pairing, location assignment, and terminal API-mode setup.
- Processor dispute case truth, chargebacks, raw provider evidence, and merchant-level risk settings. ROS surfaces dispute signals, refund/reversal rows, and recovery notes in Payments; provider case response remains limited to supported Helcim API endpoints.
- Provider-side ACH, Fee Saver, and other merchant-program settings unless ROS explicitly adopts them later.

ROS does not create QBO deposits, automate bank-feed matching, infer missing Helcim fees/net amounts, or mutate processor truth.

## API surface

All routes below are mounted under `/api/payments`.

Configuration and provider state:

- `GET /providers/active`
- `PATCH /providers/active`
- `GET /providers/helcim/status`
- `GET /providers/helcim/health` (live API connectivity check with latency)
- `PATCH /providers/helcim/config`
- `GET /providers/helcim/fees/status`

POS and payment attempts:

- `POST /providers/helcim/purchase`
- `POST /providers/helcim/terminal/refund`
- `POST /providers/helcim/card-token/purchase`
- `POST /providers/helcim/card/refund`
- `POST /providers/helcim/card/reverse`
- `GET /providers/helcim/attempts/{id}`
- `GET /providers/helcim/attempts/{id}/stream`
- `POST /providers/helcim/attempts/{id}/simulate` for local/e2e simulation only.

HelcimPay.js provider boundary:

- `POST /providers/helcim/helcim-pay/initialize`
- `POST /providers/helcim/helcim-pay/confirm`
- These routes are for public/web checkout and POS **Card Not Present** keyed-entry flows. HelcimPay.js owns card entry, returns a signed result, and ROS validates the Helcim response before recording the tender.
- HelcimPay.js must run from a Helcim-whitelisted public HTTPS checkout origin. iPad PWA checkout runs there directly. The desktop Tauri app must not render HelcimPay.js from its local `http://tauri.localhost` WebView origin; instead, ROS creates the authenticated Card Not Present attempt, embeds a one-time public HTTPS ROS/PWA handoff page for hosted card entry, and the register drawer listens for the approved attempt before recording the tender. If the public HTTPS base URL is not configured, use Manual Card only for an approval completed outside ROS.
- Hosted Card Not Present does not send a synthetic ROS value as `invoiceNumber`; Helcim rejects values that are not valid Helcim invoice numbers. If the handoff is interrupted, ROS recovers only a single provider purchase whose amount, currency, transaction type, and timestamp uniquely match the hosted attempt. Ambiguous matches remain pending for staff review instead of being guessed or duplicated.

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

- `POST /api/webhooks/card-events`
- `POST /api/webhooks/helcim` (legacy compatibility alias; do not use for new Helcim dashboard setup)

## Retry and hardening

All outbound Helcim API calls use centralized retry logic with exponential backoff:

- ROS keeps its descriptive idempotency key in the local provider-attempt ledger, but sends a stable UUID-form key to Helcim. This satisfies Helcim's current 25-36 character Payment API contract without losing local replay identity.

- **Transient failures**: Network timeouts, connection errors, HTTP 429 (rate limit), and HTTP 5xx responses are retried up to 3 times with delays of 500ms, 1000ms, and 2000ms.
- **Non-retryable errors**: HTTP 4xx client errors (except 429) fail immediately without retry.
- **Idempotency keys**: Payment POSTs (`purchase`, `refund`, `reverse`, and terminal operations) include deterministic idempotency keys so retries are safe against duplicate transactions. HelcimPay.js initialization follows its separate checkout-session token contract.
- **Rate-limit awareness**: Error messages include `retry-after`, `minute-limit-remaining`, and `hour-limit-remaining` headers when Helcim returns them.
- **HTML response detection**: If the API returns an HTML page (e.g., WAF block or wrong base URL), the error message explicitly flags it so operators can check networking settings.

## Financial safety invariants

- `payment_provider_attempts` is the durable audit trail for provider calls. A failed attempt is evidence only and must not by itself create or mutate `payment_transactions`.
- Terminal purchases, hosted manual-card payments, and terminal refunds create pending provider attempts before provider completion.
- Direct card refund/reverse routes create and update provider attempts with Helcim response data. POS Payments standalone refunds use this path and intentionally do not create a ROS sales refund or mutate a Transaction Record by themselves.
- Queued POS/Orders card refunds create provider-attempt audit data before ROS writes the negative payment.
- ROS writes the queued refund payment, allocation, refund queue update, and transaction paid amount only after Helcim returns an approved/captured refund status.
- Helcim request errors, declines, or rate limits leave ROS refund state unchanged and persist the failed provider attempt for review.
- Idempotency keys are deterministic for provider attempts. Queued refunds include the refund queue row, original Helcim transaction id, prior refunded cents, and current amount cents.
- Provider 429/rate-limit responses must remain visible as provider errors; they are not silently hidden as generic failures.
- **Card-token purchase atomic update (v0.80.7):** The `POST /providers/helcim/card-token/purchase` success path updates the provider attempt record inside the same database transaction that locks the register session. This prevents an attempt from remaining `pending` if the server process crashes after Helcim approves the charge but before the local status commit.

## Terminal and hardware behavior

- Terminal device and card-terminal endpoints are read-only except `ping`.
- `ping` checks whether the Helcim device is reachable/listening and does not create payment attempts, payment transactions, allocations, settlement rows, or reconciliation records.
- Device codes are configured through Settings -> Helcim as Terminal 1 / Terminal 2 or through `HELCIM_TERMINAL_1_DEVICE_CODE` / `HELCIM_TERMINAL_2_DEVICE_CODE`. Daily readiness belongs in Payments -> Health.
- ROS can initiate terminal purchase attempts and terminal refund attempts for configured devices, but Helcim dashboard remains required for hardware enrollment, pairing, and provider-side device assignment.
- POS **Card Reader** sends the amount to the selected Helcim terminal for tap/insert/swipe.
- POS **Card Not Present** opens secure HelcimPay.js hosted card entry for keyed/phone-order cards. ROS must not collect PAN or CVV in native fields, notes, references, search fields, or support chats.
- Card Not Present does not require staff to enter an invoice number. ROS keeps the hosted attempt server-side and uses the validated Helcim result first; after a handoff or server interruption, recovery requires one unique provider purchase matching the attempt amount, currency, type, and narrow time window.
- POS **Card Refund** is available for refund/negative checkout totals. **API Refund** uses Helcim Payment API refund with the original Helcim transaction id when the card is not present. **Terminal Refund** sends the refund to the selected Helcim terminal only when the customer and original card are present. If the original id is not supplied by the calling workflow, staff must enter the original Helcim transaction id before the refund can be sent.
- POS **Manual Card** records a manually approved card sale or refund when the authorization happened outside ROS or no live Helcim connection is available. It requires an approval/reference, last four digits, and reason, stores no PAN/CVV, and does not claim a Helcim provider attempt.
- POS **Payments -> Refund** starts a standalone Helcim card refund when the original Helcim transaction id is known and the refund is not being driven by an in-cart return/exchange workflow. The provider attempt is recorded immediately in ROS for review.
- Register routing uses Terminal 1 / Terminal 2 naming. Register #1 defaults to Terminal 1, Register #2 defaults to Terminal 2, and other registers must choose an available terminal before sending a terminal payment/refund.
- ROS sends each terminal purchase with a unique `ROS-{attempt}` invoice reference. If the live terminal response or webhook is delayed, the checkout drawer **Recover payment** action asks the server to refresh the attempt and match by that invoice reference and exact amount before staff retry the card.
- Customer receipts must come from ROS, not the Helcim terminal. The Helcim terminal/device configuration must have terminal receipt printing disabled for Riverside lanes; if a terminal prints a card receipt, correct the Helcim device/dashboard setting and still use the ROS receipt as the store receipt.

## Webhook behavior

- Inbound Helcim webhooks require signature verification and timestamp freshness before processing.
- Production Helcim terminal webhooks require a public HTTPS route to the ROS API. Helcim requires that URL to use HTTPS and not contain the word "Helcim"; at Riverside, the intended store route is `https://ros.riversidemens.com/api/webhooks/card-events`.
- If that public host is backed by Cloudflare Tunnel, `cloudflared` must run as a supervised OS service on the host that can reach ROS on port `3000`. **Settings -> Remote Access -> Repair Cloudflare Tunnel** can repair the local tunnel origin to the ROS port when the public hostname is configured; Cloudflare DNS/WAF records remain in Cloudflare.
- The local development preflight can kickstart the macOS `com.cloudflare.riverside-helcim` LaunchAgent when it exists. Production must use the equivalent host service or scheduled task for the deployment machine.
- Local terminal readiness does not require a public webhook URL. The Helcim webhook signing secret is optional only when Helcim cannot reach this ROS server. If a public webhook endpoint is configured, the signing secret is required and unsigned deliveries fail closed.
- Local POS terminals subscribe to the ROS attempt stream for the current card attempt. ROS updates that stream from stored webhooks when Helcim deliveries arrive and can also refresh a known terminal attempt as a recovery aid. Manual status refresh is not a substitute for a working production webhook path.
- Accepted events are stored in `helcim_event_log` before mutation.
- If a cardTransaction webhook corresponds to an existing ROS Helcim payment, the event log must link to that `payment_transactions` row and use a non-`none` match type so Health does not flag a completed ROS payment as unresolved.
- Stored payloads are redacted for card-sensitive fields.
- Duplicate events do not re-enter processing once already processed or ignored.
- Unknown Helcim events are stored and marked ignored instead of failing the whole intake.
- Replay is intentionally narrow: only stored failed Helcim events can be replayed, and replay uses the existing event-log payload. Callers cannot submit raw replay payloads or bypass the event log.

### Helcim webhook setup

Configure Helcim webhooks only when ROS has a public HTTPS API URL that Helcim can reach.

1. In Helcim, open **All Tools -> Integrations -> Webhooks**.
2. Turn webhooks on.
3. Set the delivery URL to `https://<public-ros-api-host>/api/webhooks/card-events`.
4. Enable the Helcim events ROS handles: `cardTransaction` and `terminalCancel`.
5. Copy the Helcim webhook verifier/signing token into Settings -> Helcim -> Optional webhook signing secret.
6. Confirm the public route reaches ROS from **Settings -> Remote Access -> Run Live Callback Check**. Cloudflare `502`, `1033`, `403`, or HTML challenge responses mean Helcim cannot deliver to ROS.
7. Send a test or live terminal event and verify it in Payments -> Health under Payment Updates and Helcim Terminal Review. If a terminal outcome blocks Z-close, staff can record the review outcome in the POS close flow; this creates a recovery audit row and clears the close blocker without recording a payment, refund, or ledger mutation.

Do not use `localhost`, `127.0.0.1`, a register workstation URL, or any non-HTTPS URL as the Helcim delivery URL.

If Cloudflare returns `1033`, the tunnel is not connected to Cloudflare and Helcim webhooks cannot reach ROS. Start or repair the supervised `cloudflared` service before testing terminal cancel/approval behavior.

Operational wording matters:

- **Webhook received by ROS** means a signed Helcim delivery reached this server and was stored for review.
- **Card approved by processor** means Helcim reported approval. It does not mean ROS has written the sale payment yet.
- **Payment recorded in ROS** means checkout finalization wrote the ROS payment rows used by register close, reporting, and accounting.
- **Provider event attached to ROS checkout** means ROS matched that stored provider event to one pending terminal attempt.
- Webhook delivery does not by itself create ROS payment ledger rows, close a checkout, or prove that ROS recorded a payment.
- Unmatched approved provider events must remain labeled as unresolved card outcomes until staff review.
- Staff UI should avoid telling staff to retry or continue safely while a card outcome is still pending, approved-but-not-recorded, or unresolved.

If the signing secret is missing or wrong, ROS fails closed before storing the event. Those rejected deliveries may require server-log review because unsigned or bad-signature payloads are not trusted enough to enter `helcim_event_log`.

## Settlement and deposits

- Batch and transaction sync stores redacted provider batch headers and batch membership separately from ROS payment rows.
- Fee and net values are applied only when Helcim explicitly provides them. Missing values are tracked as not ready, not estimated and not treated as zero.
- Reconciliation issues compare ROS payment truth against Helcim processor truth and record staff review history.
- Actual bank deposits are external evidence entered or imported into ROS for matching. Matching expected Helcim batches to actual deposits does not create QBO deposits, post bank-feed transactions, or mutate processor/payment amounts.

## Credentials and PCI boundary

- Helcim API token and Terminal 1 / Terminal 2 device codes are saved through encrypted integration credentials or current deployment env names. Terminal device codes are four-character alphanumeric codes from Helcim device pairing. The webhook secret is optional and only used for public inbound Helcim webhook delivery.
- Client-facing config/status responses expose readiness only, not raw secrets.
- ROS must not store, log, display, or transmit PAN or CVV. Manual/phone-order card entry happens inside HelcimPay.js hosted card entry, not in ROS-owned fields.
- Stored card data is limited to provider-safe token references, Helcim transaction/payment ids, statuses, amounts, terminal references, and masked/brand/last4 metadata returned safely by Helcim.
- Saved-card payments use Helcim card tokens. Tokens are provider credentials and should not be shown in staff UI, copied into notes, or logged.
- Saved-card purchase attempts carry the open checkout client id and a stable idempotency key. An interrupted retry reuses the existing provider attempt and Helcim idempotency key; ROS rejects a different sale or amount and does not attach a provider result with an amount mismatch to the payment ledger.
- Webhook, storefront confirmation, settlement sync, and provider error storage redact card-sensitive fields.

## Out of scope unless explicitly adopted

- ACH/bank account payments.
- Fee Saver.
- Provider-managed partial-payment programs.
- Level 2/Level 3 optimized interchange payload expansion.
- Dashboard-free merchant onboarding and hardware enrollment.
- Full dispute/chargeback case response automation until Helcim exposes a supported dispute-response API for the account. ROS Payments keeps dispute signals, refund-required flags, duplicate warnings, notes, and payment links in-app.
- Online-store product scope beyond the shared provider boundary documented here.

## Related docs

- Staff operations: [`staff/payments-operations.md`](staff/payments-operations.md)
- Refund queue behavior: [`TRANSACTION_RETURNS_EXCHANGES.md`](TRANSACTION_RETURNS_EXCHANGES.md)
- Settlement/schema contract: [`SCHEMA_CONTRACT_AND_MIGRATIONS.md`](SCHEMA_CONTRACT_AND_MIGRATIONS.md)
- Integration posture: [`INTEGRATIONS_SCOPE.md`](INTEGRATIONS_SCOPE.md)
- QBO clearing behavior: [`QBO_JOURNAL_TEST_MATRIX.md`](QBO_JOURNAL_TEST_MATRIX.md)
