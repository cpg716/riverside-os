# Helcim Integration Audit 2026

**Date:** 2026-05-23
**Scope:** Review existing Helcim integration against https://devdocs.helcim.com/docs/welcome-to-helcim
**Auditor:** Cascade (AI assistant)

## Summary

The Riverside OS Helcim integration is **production-ready** for its intended scope (POS card payments, terminal hardware, settlement reconciliation, and webhook processing). The codebase already implements robust patterns: webhook HMAC verification, payload redaction, idempotency keys, simulator mode, fee/settlement sync, deposit matching, and durable event logging with replay.

This audit focused on **hardening** existing logic rather than expanding scope. Two concrete improvements were applied:

1. **Retry logic with exponential backoff** added to all outbound Helcim API calls.
2. **Live API health check endpoint** (`GET /api/payments/providers/helcim/health`) added for operational monitoring.

## API Coverage Map

| Helcim API Area | ROS Coverage | Notes |
|----------------|-------------|-------|
| **Payment API** — Card token purchase | ✅ `POST /payment/purchase` | Used for saved-card checkout |
| **Payment API** — Card refund | ✅ `POST /payment/refund` | Direct refund with original tx id |
| **Payment API** — Card reverse | ✅ `POST /payment/reverse` | Void/pre-auth reversal |
| **Payment API** — Idempotency keys | ✅ All payment POSTs | Deterministic keys per attempt |
| **Payment API** — Suspected duplicates | ⚠️ Webhook-driven reconciliation | Not a direct API call; handled via `cardTransaction` webhook matching |
| **Payment API** — Level 2/3 optimized | ❌ Out of scope | Not needed for retail POS today |
| **Invoice API** | ❌ Out of scope | Not needed for retail POS |
| **Customer API** — Customers list | ✅ `GET /customers` | CRM linkage helper |
| **Customer API** — Cards list/delete/default | ✅ Full CRUD for cards | Token-safe; no PAN/CVV handling |
| **Customer API** — Bank accounts / PAD | ❌ Out of scope | ACH not adopted |
| **Recurring API** | ❌ Out of scope | Payment plans not needed for retail |
| **Payments Hardware** — Device list/ping | ✅ `GET /devices`, `POST /devices/{code}/ping` | Terminal readiness checks |
| **Payments Hardware** — Terminal purchase | ✅ `POST /devices/{code}/payment/purchase` | POS Card Reader / Manual Card flows |
| **Payments Hardware** — Terminal refund | ✅ `POST /devices/{code}/payment/refund` | Register refund to terminal |
| **Payments Hardware** — Webhooks | ✅ `cardTransaction`, `terminalCancel` | Signed, redacted, deduplicated, replayable |
| **Card Batches** — List / detail / transactions | ✅ Full read support | Fee/settlement sync consumes these |
| **ACH Payment API** | ❌ Out of scope | Not adopted; documented in `HELCIM.md` |
| **ACH Batches** | ❌ Out of scope | Not adopted |
| **HelcimPay.js** — Initialize / Confirm | ✅ `POST /helcim-pay/initialize` | Public/web checkout only |
| **Webhooks** — Signature + freshness | ✅ HMAC-SHA256 + timestamp window | `HELCIM_WEBHOOK_SECRET` required in prod |

## Hardening Applied (2026-05-23)

### 1. Retry logic with exponential backoff

**File:** `server/src/logic/helcim.rs`

All outbound Helcim requests now share a `send_request_with_retry` helper:

- **Retryable conditions:** `reqwest` timeout/connect errors, HTTP 429, HTTP 5xx, and body hints containing "timeout" or "temporarily unavailable".
- **Max retries:** 3
- **Backoff:** 500ms → 1000ms → 2000ms (exponential).
- **Idempotency safety:** Retried payment POSTs reuse the same `idempotency-key` header, so Helcim deduplicates safely.

Affected functions:
- `send_payment_request` (purchase, refund, reverse)
- `send_get_request` (all GET endpoints)
- `fetch_card_transaction`
- `ping_device`
- `delete_customer_card`
- `set_customer_card_default`
- `start_terminal_refund`
- `initialize_helcim_pay`

### 2. Live API health check

**File:** `server/src/api/payments.rs`

New route:
- `GET /api/payments/providers/helcim/health`

Behavior:
- Requires `settings.admin` permission.
- Calls `list_card_terminals` against the live Helcim API.
- Returns JSON with `status` (`connected` or `unreachable`), `message`, and `latency_ms`.
- Useful for Dashboard health widgets and integration alert rules.

### 3. Error message hardening

- Removed unused async `response_error_message` in favor of a sync `response_error_message_sync` that works with the retry loop (avoids double-consuming the response body).
- HTML response detection preserved: warns operators to check WAF/IP settings.
- Rate-limit headers (`retry-after`, `minute-limit-remaining`, `hour-limit-remaining`) still surfaced when present.

## Gaps Identified (Acknowledged / Out of Scope)

The following Helcim API areas are **intentionally not implemented** and are documented as out of scope in `docs/HELCIM.md`:

- ACH bank payments and ACH batches
- Recurring / payment plans / subscribers
- Invoices
- Level 2 / Level 3 optimized interchange payload
- Fee Saver
- Dashboard-free merchant onboarding, disputes, chargebacks

If business requirements change, these can be adopted in future phases with the same retry/audit/webhook patterns already established.

## Files Changed

- `server/src/logic/helcim.rs` — Retry wrapper, hardened request functions, removed dead code.
- `server/src/api/payments.rs` — New `/providers/helcim/health` endpoint.
- `docs/HELCIM.md` — Documented retry behavior, health endpoint, and hardening.

## Validation

- [x] `cargo check` passes (server).
- [x] No new migrations required (code-only hardening).
- [x] Webhook verification behavior unchanged.
- [x] Idempotency key behavior unchanged.
