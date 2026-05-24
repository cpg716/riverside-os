# Audit Report: NuORDER Integration
**Date:** 2026-05-23
**Status:** Hardened / Production-Grade
**Auditor:** Cascade

## 1. Executive Summary
The NuORDER integration connects Riverside OS to the NuORDER wholesale B2B platform, enabling catalog sync (products, variants, images), approved order import (converted to purchase orders), and inventory push (ATS levels). Authentication uses OAuth 1.0 (One-Legged) with per-request HMAC-SHA1 signatures.

## 2. Technical Architecture

### 2.1 API Client (`server/src/logic/nuorder.rs`)
- **OAuth 1.0 Signing**: Per-request `oauth_nonce`, `oauth_timestamp`, and HMAC-SHA1 signature using consumer key/secret + user token/secret.
- **Rate Limiting**: `tokio::sync::Semaphore(5)` enforces NuORDER's strict 5-concurrent-call limit.
- **HTTP Methods**: `fetch_products`, `fetch_approved_orders`, `update_inventory`.

### 2.2 Sync Engine (`server/src/logic/nuorder_sync.rs`)
- **Catalog Sync**: Resolves vendors by `nuorder_brand_id`, upserts products with `catalog_handle`, downloads images, upserts variants with SKU/UPC matching.
- **Order Sync**: Converts NuORDER "Approved" orders into ROS purchase orders with line-item matching (NuORDER ID → SKU → UPC).
- **Inventory Sync**: Pushes `stock_on_hand` as ATS for all variants with SKUs.
- **Error Accumulation**: Each sync collects per-item errors and reports partial/failure status.
- **Audit Logging**: All syncs write to `nuorder_sync_logs` with status, counts, and error messages.

### 2.3 Settings API (`server/src/api/settings.rs`)
- Credential management via `integration_credentials` (encrypted at rest).
- Manual sync triggers with `nuorder.sync` permission.

### 2.4 Notifications
- Action Center toasts for `nuorder_sync_success` and `nuorder_sync_failed`.

## 3. Hardening Applied (v0.70.x)

### 3.1 Retry Logic with Exponential Backoff
- All three API methods now retry up to **3 times** with delays of 500ms → 1000ms → 2000ms.
- Retries trigger on: network timeouts, connection errors, HTTP 5xx.
- Fails fast on: HTTP 4xx, parse errors, auth failures.

### 3.2 HTTP Timeouts
- `reqwest` client configured with 15s connect timeout and 60s request timeout.
- Prevents indefinite hangs on unresponsive upstream.

### 3.3 Enhanced Error Reporting
- Non-2xx responses now capture the full response body in error messages.
- Structured error propagation from client → sync engine → API response.

### 3.4 Health Check Endpoint
- New `GET /api/settings/nuorder/health` endpoint.
- Performs a lightweight single-product probe (`page=1&per_page=1`).
- Returns `configured`, `reachable`, `latency_ms`, `message`.
- Requires `nuorder.sync` permission.

## 4. API Surface

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `GET` | `/api/settings/nuorder/config` | `settings.admin` | Read config + last 20 sync logs |
| `PATCH` | `/api/settings/nuorder/config` | `settings.admin` | Save credentials |
| `GET` | `/api/settings/nuorder/health` | `nuorder.sync` | Live connectivity + latency check |
| `POST` | `/api/settings/nuorder/sync/catalog` | `nuorder.sync` | Pull products & variants |
| `POST` | `/api/settings/nuorder/sync/orders` | `nuorder.sync` | Import approved orders as POs |
| `POST` | `/api/settings/nuorder/sync/inventory` | `nuorder.sync` | Push ATS levels to NuORDER |

## 5. Findings & Recommendations
1. **Semaphore Retry Safety**: The semaphore permit is acquired fresh on each retry attempt, preventing permit starvation during backoff.
2. **Idempotency**: Order sync checks for existing POs by `po_number` before insert, preventing duplicate purchase orders on retry.
3. **Future Enhancement**: Consider a webhook-based push from NuORDER for order status changes instead of polling.

## 6. Conclusion
The NuORDER integration is now a **resilient, production-grade wholesale bridge**. Retry logic, timeouts, and health checks bring it in line with enterprise standards while preserving the existing OAuth 1.0 authentication and rate-limiting posture.
