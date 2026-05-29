# Audit Report: Podium Integration (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-08
**Version Audited:** v0.85.0 (commit `73cdd56`)
**Auditor:** Devin (AI assistant)
**Scope:** End-to-end trace of Podium integration — OAuth 2.0 credential management, operational SMS dispatch, webhook verification (HMAC-SHA256), idempotent delivery ledger, CRM ingest, messaging hub (inbox, conversations, sync), health monitoring, and E.164 phone normalization.

---

## 1. Executive Summary

Podium provides **customer messaging** (SMS/email) for Riverside OS. The integration covers: OAuth 2.0 token management, outbound operational SMS (order notifications, appointment reminders), inbound webhook processing with HMAC-SHA256 verification, and a CRM-linked messaging hub with conversation threading. The system is designed to **gracefully degrade** — all Podium operations are fire-and-forget with comprehensive logging.

**Overall Status:** Production Ready — 0 blockers, 0 regressions.

---

## 2. Architecture Trace

### 2.1 Credential Management
Two credential paths:
1. **OAuth App Credentials** (`PodiumOAuthAppCredentials`): `client_id`, `client_secret` from `integration_credentials` table or env vars
2. **Env Credentials** (`PodiumEnvCredentials`): `api_key`, `organization_uid` from DB or env vars with dual-fallback

OAuth flow:
```
build_podium_oauth_authorize_url()
  → Validates redirect_uri (domain allowlist for security)
  → Validates state parameter (alphanumeric, 8-128 chars)
  → Returns authorization URL with scopes

exchange_podium_oauth_authorization_code()
  → POST /oauth/token with authorization_code grant
  → Returns access_token, refresh_token, expires_in
```

### 2.2 Operational SMS Dispatch
```
try_send_operational_sms(pool, http, token_cache, to_e164, body, crm_customer_id)
  → Check credentials (skip if none)
  → Check store config (skip if SMS disabled)
  → Validate location_uid (warn if empty)
  → Validate phone digits (warn if invalid)
  → send_v4_message(http, token_cache, creds, location, "phone", ...)
  → On success: record_outbound_message() for CRM thread
  → Structured logging: podium_send_ok / podium_send_err / podium_send_skip
```

### 2.3 Phone Normalization
```rust
normalize_phone_e164("(555) 123-4567") → Some("+15551234567")
normalize_phone_e164("+44 7911 123456") → Some("+447911123456")
normalize_phone_e164("123") → None  // Too short
```
- Strips non-digits, prepends country code for 10-digit US numbers
- Handles `+1` prefix for 11-digit numbers

### 2.4 Webhook Verification
```
verify_podium_webhook_headers(headers, body, secret)
  → Extract podium-timestamp header
  → Extract podium-signature header
  → Parse hex signature to [u8; 32]
  → Compute HMAC-SHA256: key=secret, message="{timestamp}.{body}"
  → Constant-time comparison (subtle::ConstantTimeEq)
  → Check timestamp skew (staleness window)
  → Return Ok(()) or typed error
```

Security controls:
- **Constant-time comparison** via `subtle` crate (timing-attack resistant)
- **Timestamp freshness** prevents replay attacks
- **Dev mode**: `RIVERSIDE_PODIUM_WEBHOOK_ALLOW_UNSIGNED=true` for local dev only
- **Secret required**: explicit error if secret unset and unsigned not allowed

### 2.5 Idempotent Delivery Ledger
```
record_podium_webhook_delivery(pool, idempotency_key, event_type, payload)
  → podium_webhook_delivery table with unique idempotency_key
  → Returns Accepted (new) or Duplicate (retry)
```

Idempotency key derivation: SHA-256 of `{event_id}.{event_type}` from webhook payload, with body hash fallback.

### 2.6 Messaging Hub
| Function | Purpose |
|:---|:---|
| `list_messages_for_customer` | Threaded conversation view |
| `hydrate_missing_messages_for_customer` | Lazy-sync from Podium API |
| `list_messaging_inbox` | Staff inbox with unread tracking |
| `mark_conversation_viewed` | Update `last_viewed_at` |
| `record_outbound_message` | Persist sent messages |
| `sync_recent_from_podium` | Pull recent conversations from API |
| `communication_timeline` | Cross-channel customer communication history |
| `list_unmatched_conversations` | Conversations not yet linked to CRM customers |

### 2.7 Health Dashboard
```rust
PodiumMessagingHealth {
    credentials_configured: bool,      // 3 required keys present
    sms_send_enabled: bool,            // Store config toggle
    location_uid_configured: bool,     // Podium location set
    webhook_secret_configured: bool,   // HMAC secret present
    inbound_ingest_enabled: bool,      // CRM ingest active
    local_conversation_count: i64,
    unmatched_conversation_count: i64,
    last_webhook_received_at,
    last_webhook_failure_at,
    last_webhook_failure_reason,
    last_message_at,
    last_outbound_at,
    last_sync_at,
}
```

---

## 3. SMS Templates
Configurable per-store via `StorePodiumSmsConfig`:
- SMS templates with `{placeholder}` substitution
- Email templates with merged defaults
- All templates stored in `store_settings.podium_sms_config` JSONB

---

## 4. Comparison with April 2026 Audit

| Area | April 2026 | May 2026 | Status |
|:---|:---|:---|:---|
| OAuth flow | Documented | Verified: redirect_uri + state validation | ✅ No regression |
| Webhook HMAC | Documented | Verified: constant-time, freshness, dev mode | ✅ No regression |
| Messaging hub | Not documented | Verified: inbox, sync, unmatched, timeline | ✅ New finding |
| Health dashboard | Not documented | Verified: 12-field operational status | ✅ New finding |
| Graceful degradation | Documented | Confirmed: all ops fire-and-forget | ✅ No regression |
| Phone normalization | Not documented | Verified: E.164 with US/international | ✅ New finding |

---

## 5. Conclusion

**0 blockers, 0 regressions.** The Podium integration is production-ready with HMAC-verified webhooks, idempotent delivery processing, and comprehensive messaging hub for CRM.
