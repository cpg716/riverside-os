# Audit Report: Helcim Payment Integration (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-05-23
**Version Audited:** v0.85.0
**Auditor:** Devin (AI assistant)
**Scope:** Helcim API client, terminal payment flow, card token purchases, webhook handling (HMAC verification, dedup, event processing), retry logic, payload redaction

---

## 1. Executive Summary

The Helcim integration is **production-hardened** with comprehensive webhook verification, idempotent event processing, multi-strategy attempt matching, and secure payload redaction. The retry logic is well-designed with exponential backoff. The system handles both terminal (in-person) and card-token (online) payment flows with appropriate error categorization.

**Overall Status:** Production Ready — 0 blockers, 0 significant issues.

---

## 2. Architecture Overview

### 2.1 Components
- `server/src/logic/helcim.rs` (1888 lines) — API client, request building, retry logic, payload parsing, amount conversion, redaction
- `server/src/api/webhooks.rs` (1687 lines) — Webhook endpoint, HMAC-SHA256 verification, event dedup, card transaction/terminal cancel processing

### 2.2 Configuration
```rust
HelcimConfig {
    api_token: Option<String>,        // Stored via integration_credentials
    terminal_1_device_code: Option<String>,
    terminal_2_device_code: Option<String>,
    api_base_url: String,             // Default: https://api.helcim.com/v2
}
```

- Credentials stored in DB via `integration_credentials` (not hardcoded, not in env files)
- `apply_persisted_helcim_config_to_env` loads credentials from DB to env at startup
- Simulator mode controlled by `HELCIM_SIMULATOR_ENABLED` env var (disabled when `RIVERSIDE_STRICT_PRODUCTION` is set)
- Status endpoint exposes configuration readiness without leaking secrets

---

## 3. Retry Logic

### 3.1 Implementation (`send_request_with_retry`)
```
MAX_RETRIES = 3
BASE_DELAY  = 500ms (exponential backoff)
```

- **Network errors** (timeout, connect): Always retried
- **Non-network errors**: Fail immediately
- **HTTP error responses**: Checked against `is_retryable_helcim_error` (status code + body text) — only retried if retryable AND attempts remain
- **Successful responses**: Returned immediately

### 3.2 Assessment
- Retry is applied to all Helcim API calls (purchases, refunds, lookups, pings, device queries) via consistent use of `send_request_with_retry`
- Backoff prevents thundering-herd on Helcim API
- Non-retryable errors (auth failures, validation errors) fail fast

---

## 4. Webhook Security

### 4.1 HMAC-SHA256 Verification
```
verify_helcim_webhook(headers, body, now)
  → load HELCIM_WEBHOOK_SECRET from env
  → base64-decode the secret
  → extract webhook-id, webhook-timestamp, webhook-signature from headers
  → parse timestamp (epoch seconds/millis or RFC3339)
  → check freshness within HELCIM_WEBHOOK_FRESHNESS_WINDOW
  → compute HMAC-SHA256 over "{webhook_id}.{webhook_timestamp}.{body_text}"
  → base64-encode expected signature
  → match against signature_header candidates (split by whitespace, "v1,{sig}")
  → constant-time comparison via ct_eq
```

### 4.2 Security Strengths
1. **Constant-time comparison**: `ct_eq` from the `subtle` crate prevents timing attacks
2. **Freshness window**: Rejects stale/replayed webhooks outside the time window
3. **Multiple signature support**: Parses space-separated candidates with version prefix (`v1,`)
4. **Secret from env**: Not hardcoded; loaded at runtime from `HELCIM_WEBHOOK_SECRET`
5. **Strict validation**: Body parsed as `HelcimWebhookPayload` for structural validation after HMAC check

### 4.3 Payload Redaction
`redact_provider_payload` recursively walks the JSON payload and replaces sensitive fields (determined by `helcim_field_is_sensitive`) with `"[REDACTED]"`. This is applied before storing in `helcim_event_log.payload_json`, so raw card numbers and tokens are never persisted.

`redact_sensitive_text_fragments` handles non-JSON error messages as a fallback.

---

## 5. Event Processing Pipeline

### 5.1 Deduplication
```sql
INSERT INTO helcim_event_log (webhook_id, ...)
ON CONFLICT (webhook_id) WHERE webhook_id IS NOT NULL
DO UPDATE SET webhook_id = helcim_event_log.webhook_id
RETURNING id, processing_status, (xmax = 0) AS created
```
- `xmax = 0` on the RETURNING clause detects whether the row was newly inserted or was an existing duplicate
- Duplicate webhooks return `200 OK` with `"duplicate": true` — Helcim sees success and stops retrying
- Only newly created events proceed to processing

### 5.2 Event Types
- `cardTransaction` → `handle_helcim_card_transaction` (process approved/declined payments)
- `terminalCancel` → `handle_helcim_terminal_cancel` (handle terminal-initiated cancels)
- All other types → `mark_helcim_event_ignored` (stored for audit but not processed)

### 5.3 Attempt Matching Strategy
When a `cardTransaction` webhook arrives, the system matches it to a `payment_provider_attempts` row using a two-phase strategy:

1. **Primary match**: `provider_transaction_id` — matches the Helcim transaction ID against pending attempts with the same provider_transaction_id.
2. **Fallback match**: `terminal_amount` — if no primary match, uses `find_safe_helcim_terminal_fallback_candidate` to match by terminal device code + amount cents + currency. This handles cases where the POS didn't pre-populate the provider_transaction_id (e.g., terminal-initiated flows).

### 5.4 Processing-to-Checkout Bridge
For approved transactions with a `checkout_client_id` but no existing `payment_transactions` row, the webhook handler:
1. Looks up the `transactions` row with `checkout_client_id` and `status = 'processing'`
2. Creates a `payment_transactions` row with `method: card_terminal, status: approved`
3. Creates a `payment_allocations` row linking the payment to the order
4. Updates the order's `amount_paid`, `balance_due`, and status
5. If fully paid + all takeaway → marks order as fulfilled

This completes the two-phase checkout flow initiated by the POS register.

### 5.5 Failed Event Replay
`replay_helcim_event` allows operators to retry failed events:
- Only events with `processing_status = 'failed'` can be replayed
- Status is reset to `'received'` before reprocessing
- Failures during replay re-mark the event as `'failed'`

---

## 6. Amount Handling

### 6.1 Cents Conversion
```rust
pub fn amount_cents(&self) -> Option<i64> {
    let decimal = rust_decimal::Decimal::from_str(&amount).ok()?;
    (decimal * Decimal::from(100)).round_dp(0).to_string().parse::<i64>().ok()
}
```
- Amounts are parsed from Helcim's string/number format into `Decimal`
- Converted to cents via `* 100` and `round_dp(0)` — no floating-point
- Webhook amount matching uses the same conversion via `helcim_webhook_amount_cents`

### 6.2 Comparison with Tolerance
`helcim_attempt_comparison_cents` (in checkout) compares POS-side amount with Helcim-side amount using a cents-based tolerance to handle minor rounding differences.

---

## 7. Simulator Mode

For development/testing without a physical terminal:
- `HELCIM_SIMULATOR_ENABLED=true` enables simulated transactions
- Simulator device code: `SIM1`
- Guarded by `!RIVERSIDE_STRICT_PRODUCTION` — cannot be enabled in production
- `simulated_card_transaction` generates deterministic test responses with VISA/SIMOK

---

## 8. Conclusion

The Helcim integration is mature and well-hardened. The webhook pipeline demonstrates best practices: HMAC-SHA256 with constant-time comparison, deduplication via unique constraint, payload redaction before storage, multi-strategy attempt matching, and structured error handling with replay capability. No security or financial integrity issues found.

**Status: PRODUCTION READY**
