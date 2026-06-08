# Audit Report: Online Store (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-25
**Version Audited:** v0.85.5 (commit `e8edc0f4`)
**Auditor:** Devin (AI assistant)
**Scope:** End-to-end trace of the public-facing online store — product catalog (slug-based), customer account auth (JWT + password), checkout session lifecycle (create → payment → confirmation), coupon/promotion engine, Helcim payment provider, shipping rate integration, tax computation, and Meilisearch-backed catalog search.

---

## 1. Executive Summary

The Online Store is a **public-facing e-commerce storefront** built as a separate auth context (store customer JWT, not staff sessions). It provides catalog browsing, cart management, coupon application, and checkout with HelcimPay.js integration. The store checkout enforces strict session lifecycle with idempotency protection, tax computation (NYS Pub 718-C), and inventory reservation within the DB transaction.

**Overall Status:** Production Ready — 0 blockers, 0 regressions.

---

## 2. Architecture Trace

### 2.1 Catalog (`store_catalog.rs`)
```
list_store_products(pool, search, limit, offset, meilisearch)
  → Filter: is_active=true, catalog_handle set, web_published variants exist
  → Search: Meilisearch (store_product_search_ids) → SQL hydration
  → Fallback: PostgreSQL ILIKE on name/brand
  → Returns: product_id, slug, name, brand, primary_image

get_store_product_detail(pool, slug)
  → Lookup by catalog_handle (slug)
  → Returns: product detail + all web_published variants
  → Includes: variation_axes, images, stock levels, unit_price
```

### 2.2 Customer Auth
Two auth modules:
- `store_customer_jwt.rs`: JWT token issuance/validation for store sessions
- `store_customer_password.rs`: password-based login for returning customers

### 2.3 Checkout Session Lifecycle
```
CreateCheckoutSessionInput
  → cart_id, contact (email/name/phone), customer_id
  → lines: [{variant_id, qty}]
  → coupon_code, fulfillment_method (pickup/shipping)
  → ship_to address, shipping_rate_quote_id
  → selected_provider ("helcim")
  → idempotency_key (SHA-256 based dedup)
  → source/medium/campaign_slug (attribution tracking)

Session states: pending → payment_started → confirmed → expired
```

### 2.4 Payment Flow (HelcimPay.js)
```
1. Create checkout session → resolve cart → compute totals
2. Start payment → initialize HelcimPay checkout token
3. Client-side HelcimPay.js handles card entry
4. Confirm payment → verify provider_payment_id + hash
5. Finalize → create transaction + inventory reservation (in DB transaction)
```

### 2.5 Tax & Promotions
- Tax via `store_tax.rs` with `WebFulfillmentMode` (shipping vs pickup)
- Promotions via `store_promotions.rs`: coupon validation, discount calculation
- Cart resolution via `store_cart_resolve.rs`: variant availability, line qty validation

### 2.6 Provider Readiness Check
```rust
CheckoutConfigResponse {
    web_checkout_enabled: bool,
    default_provider: String,
    providers: Vec<ProviderReadiness>,  // [{provider, enabled, label, missing_config}]
}
```
Detects placeholder/dummy credentials via `looks_placeholder()` to prevent misconfigured checkouts.

### 2.7 Idempotency
Session creation uses `idempotency_key` (SHA-256 hash) to prevent duplicate checkout sessions from the same cart submission.

---

## 3. Comparison with April 2026 Audit

| Area | April 2026 | May 2026 | Status |
|:---|:---|:---|:---|
| Catalog search | Documented | Verified: Meilisearch + SQL fallback | ✅ No regression |
| Checkout lifecycle | Documented | Verified: full session state machine | ✅ No regression |
| HelcimPay integration | Documented | Confirmed: token init → client-side → confirm | ✅ No regression |
| Idempotency | Not documented | Verified: SHA-256 idempotency_key | ✅ New finding |
| Placeholder detection | Not documented | Verified: looks_placeholder() guard | ✅ New finding |
| Attribution tracking | Not documented | Verified: source/medium/campaign_slug | ✅ New finding |

---

## 4. Conclusion

**0 blockers, 0 regressions.** The Online Store is production-ready with secure checkout, proper idempotency, and comprehensive attribution tracking.
