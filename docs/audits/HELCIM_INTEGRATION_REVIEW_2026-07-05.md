# Helcim Integration Review - 2026-07-05

## Review scope

This review checked the Riverside OS Helcim integration against the current Helcim v2.2 developer docs and the actual ROS runtime paths, not just existing tests.

Reviewed surfaces:

- POS terminal purchase, hosted Manual Card, saved-card, and terminal refund flows.
- Payments Operations: event health, transaction/batch/fee/deposit/reconciliation surfaces.
- Helcim webhook verification, event storage, duplicate handling, and replay.
- Settings-managed encrypted credentials and deployment env fallbacks.
- Public webhook setup guidance in Settings, Help, deployment docs, and developer docs.

Official docs referenced:

- Helcim docs index and current API set: https://devdocs.helcim.com/docs/welcome-to-helcim
- API token and connection test: https://devdocs.helcim.com/docs/authentication-with-the-helcim-api-and-helcimpayjs
- Payment Hardware purchase: https://devdocs.helcim.com/docs/initiating-a-purchase-transaction
- Payment Hardware debit refund: https://devdocs.helcim.com/docs/initiating-a-refund-transaction
- Payment Hardware webhooks: https://devdocs.helcim.com/docs/enabling-webhooks-for-transactions
- Payment API idempotency: https://devdocs.helcim.com/docs/idempotency
- HelcimPay.js initialization: https://devdocs.helcim.com/docs/initialize-helcimpayjs

## Confirmed-safe areas

- Hardware purchase and terminal refund flows treat Helcim `202 Accepted` as "request started", not final payment approval.
- Pending terminal attempts are stored in `payment_provider_attempts` before provider completion.
- A database uniqueness guard blocks concurrent pending attempts on the same device, matching Helcim's no-queue terminal rule.
- Hardware webhooks verify the base64 verifier token using HMAC SHA-256 over `webhook-id.webhook-timestamp.body`, enforce timestamp freshness, redact stored payloads, and dedupe by `webhook_id`.
- Webhook `cardTransaction` events fetch full card transaction details before matching or recovering local payment state.
- Payment API card-token purchase, card refund, card reverse, terminal purchase/refund, and HelcimPay.js initialize flows use deterministic idempotency keys.
- Terminal debit refund requires explicit customer/original-card-present confirmation before ROS starts the hardware refund.
- Routine Helcim credentials are stored through encrypted Settings-managed integration credentials; env vars remain deployment fallbacks.
- POS Manual Card currently uses hosted HelcimPay.js keyed entry, so ROS does not collect PAN or CVV in native fields.

## Issues fixed in this pass

1. **Webhook delivery URL violated Helcim's current URL rule.**
   - Helcim requires webhook URLs to use HTTPS and not contain the word "Helcim".
   - ROS already had a compliant `/api/webhooks/card-events` route, but Settings/docs still directed admins to `/api/webhooks/helcim`.
   - Fixed current Settings, Remote Access, Payments Health guidance, README, DEVELOPER, Help, staff, and deployment docs to use `/api/webhooks/card-events`.
   - Kept `/api/webhooks/helcim` as a legacy compatibility alias only.

2. **Settings "Check Connection" did not perform the clearest live API check.**
   - The button refreshed config/event status, and backend health used a card-terminal list call.
   - Fixed backend health to use Helcim's dedicated `/v2/connection-test` endpoint.
   - Updated Settings -> Helcim to display live reachability and latency.

3. **Terminal device codes could be saved in invalid shapes.**
   - Helcim hardware device codes are four-character alphanumeric codes.
   - Added server-side normalization/validation for Terminal 1 and Terminal 2 credential saves through both Helcim config and shared Integration Credentials paths.
   - Terminal purchase/refund/device API calls now normalize device codes before building Helcim URLs.

4. **Manual Card documentation contradicted the current app.**
   - Current POS code opens hosted HelcimPay.js for Manual Card.
   - README, DEVELOPER, Helcim docs, and deployment checklist now describe hosted HelcimPay.js keyed entry instead of terminal-keyed phone-order entry.

## Remaining live risks

- Physical Helcim hardware still needs live validation on both terminals: purchase approve, decline, terminal cancel, stale pending recovery, terminal refund with original card present, and concurrent terminal-use blocking.
- Public webhook delivery must be tested from Helcim through the production public HTTPS URL. A local or LAN-only ROS URL is not sufficient.
- Current ROS uses one Helcim API token for API reads, Payment API writes, Payment Hardware API writes, and HelcimPay.js initialization. Helcim recommends scoped API Access Configurations; splitting tokens would be a deliberate least-privilege enhancement.
- POS Manual Card uses hosted HelcimPay.js today. If Riverside wants all phone-order keyed entry to happen on the physical terminal instead, that is a business/workflow change and should be implemented intentionally.
- Fee Saver, ACH, Level 2/3 enhanced data, standalone unlinked refunds, disputes/chargebacks, and provider-managed partial payment programs remain out of scope unless Riverside explicitly adopts them.

## Business decisions needed

1. Keep POS Manual Card as hosted HelcimPay.js, or change it to terminal-keyed phone-order entry on the physical Helcim device?
2. Keep one Helcim API token in Settings, or add separate Settings-managed tokens for Payment Hardware, Payment API/operations reads, and HelcimPay.js least-privilege configurations?
3. Confirm the production public ROS URL for Helcim webhooks. The compliant path should be `https://<public-ros-api-host>/api/webhooks/card-events`.
4. Confirm whether Riverside wants to adopt any optional Helcim programs later: Fee Saver, ACH, Level 2/3 data, standalone refunds, or chargeback/dispute workflows.

## Validation target

- Formatting and type checks for changed Rust/TypeScript paths.
- Help generation and help-impact check because staff-facing Settings/Help docs changed.
- Manual live merchant validation after credentials, terminal pairing, and public webhook delivery are available.
