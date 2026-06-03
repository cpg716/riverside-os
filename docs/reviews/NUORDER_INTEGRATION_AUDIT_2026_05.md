# Audit Report: NuOrder Integration (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-25
**Version Audited:** v0.85.5 (commit `cac08918`)
**Auditor:** Devin (AI assistant)
**Scope:** End-to-end trace of NuOrder wholesale integration — OAuth 1.0 HMAC-SHA1 authentication, product/order/inventory API client, catalog sync with notification emission, order import, inventory push, rate limiting via semaphore, and health monitoring.

---

## 1. Executive Summary

NuOrder provides **wholesale B2B ordering** for Riverside OS — enabling the store to browse vendor catalogs, receive approved orders, and push inventory levels. The integration uses **OAuth 1.0 HMAC-SHA1** signing for all API requests, with a strict **5-concurrent-request semaphore** to respect NuOrder's rate limits. Credentials are stored encrypted in `integration_credentials`.

**Overall Status:** Production Ready — 0 blockers, 0 regressions.

---

## 2. Architecture Trace

### 2.1 OAuth 1.0 Authentication
```
get_oauth_header(method, url)
  → Generate nonce (UUID v4)
  → Generate timestamp (Unix epoch)
  → Sort parameters alphabetically
  → Build base string: {METHOD}&{encoded_url}&{encoded_params}
  → Sign with HMAC-SHA1: key = {consumer_secret}&{user_secret}
  → Base64-encode signature
  → Return full OAuth Authorization header
```

### 2.2 API Client Operations
| Operation | Method | URL | Purpose |
|:---|:---|:---|:---|
| `fetch_products` | GET | `/api/v1/products` | Full product catalog |
| `fetch_approved_orders` | GET | `/api/v1/orders?status=Approved` | Approved wholesale orders |
| `update_inventory` | PUT | `/api/v1/inventory/{sku}` | Push available-to-sell count |
| `health_check` | GET | `/api/v1/products?page=1&per_page=1` | Lightweight connectivity test |

### 2.3 Retry Policy (All Operations)
```
NUORDER_MAX_RETRIES = 3 (total 4 attempts)
NUORDER_BASE_RETRY_DELAY_MS = 500ms
Delay: 500ms, 1000ms, 2000ms (exponential)
Retry: timeout, connect error, 5xx server error
Fail fast: 4xx client errors, non-network errors
```

### 2.4 Rate Limiting
```rust
semaphore: Arc::new(Semaphore::new(5))  // NuORDER strict 5-concurrent limit
```
Every API call acquires a semaphore permit before making the HTTP request. This prevents exceeding NuOrder's concurrency limits even during bulk sync operations.

### 2.5 Catalog Sync
```
sync_catalog(pool, client, actor_staff_id)
  → Create nuorder_sync_logs entry (status='syncing')
  → fetch_products() from NuOrder
  → For each product: upsert_nuorder_product()
    → Track: created/updated/variants/errors
  → Update sync log: status=success|partial|failure
  → On success: emit_nuorder_sync_finished (notification)
  → On partial/failure: emit_nuorder_sync_failed (notification)
```

### 2.6 Credential Management
```rust
nuorder_client_from_pool(pool)
  → load_integration_credentials(pool, "nuorder",
      ["consumer_key", "consumer_secret", "user_token", "user_secret"])
  → Validate all 4 credentials present and non-empty
  → Build NuorderClient with credentials
```

### 2.7 Data Model
```rust
NuorderProduct {
    id, name, style_number, brand_name, description,
    wholesale_price: Decimal,  // rust_decimal
    retail_price: Decimal,
    image_urls: Vec<String>,
    variants: Vec<NuorderVariant>,
}

NuorderVariant {
    id, upc, color, size, available_to_sell: Option<i32>,
}
```

---

## 3. Comparison with April 2026 Audit

| Area | April 2026 | May 2026 | Status |
|:---|:---|:---|:---|
| OAuth 1.0 signing | Documented | Verified: full HMAC-SHA1 implementation | ✅ No regression |
| Rate limiting | Not documented | Verified: 5-concurrent semaphore | ✅ New finding |
| Retry logic | Not documented | Verified: 4 attempts with exponential backoff | ✅ New finding |
| Sync logging | Not documented | Verified: nuorder_sync_logs with status tracking | ✅ New finding |
| Notification emission | Not documented | Verified: success/failure notifications | ✅ New finding |
| Health check | Not documented | Verified: lightweight product probe | ✅ New finding |

---

## 4. Conclusion

**0 blockers, 0 regressions.** The NuOrder integration is production-ready with proper OAuth 1.0 signing, strict rate limiting, and comprehensive sync tracking.
