# Audit Report: POS Logic & Helpers (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-08
**Version Audited:** v0.85.0 (commit `73cdd56`)
**Auditor:** Devin (AI assistant)
**Scope:** POS meta helpers — RMS charge management (lookup, purchase, reversal), gift card load line resolution, POS-initiated shipping rate quotes (Shippo integration), permission enforcement for financial operations.

---

## 1. Executive Summary

The POS Logic helpers module provides **register-session-scoped** utilities that bridge the checkout flow to ancillary financial systems (RMS financing, gift card loading, shipping). All operations enforce granular RBAC with the tightened permission model introduced in v0.80.6 (CFP-005). The RMS reversal flow now correctly guards against double-reversal via `resolution_status` checks.

**Overall Status:** Production Ready — 0 blockers, 0 regressions.

---

## 2. Architecture Trace

### 2.1 RMS Charge Operations
| Route | Permission | Purpose |
|:---|:---|:---|
| `GET /rms-payment-line-meta` | Staff or POS session | Resolves product/variant/SKU for the RMS payment line item |
| `GET /gift-card-load-meta` | Staff or POS session | Resolves product/variant/SKU for the gift card load line item |
| `GET /rms-charge-history` | `pos.rms_charge.history_basic` | Customer charge history for POS display |
| `POST /rms-charge-lookup` | `pos.rms_charge.lookup` | Lookup RMS charge eligibility for a customer |
| `POST /reverse-rms-charge-purchase` | `customers.rms_charge.reverse` | Reverse an RMS charge purchase |
| `POST /reverse-rms-charge-payment` | `customers.rms_charge.reverse` | Reverse an RMS charge payment |

### 2.2 RMS Reversal Guard (CFP-003)
Both reversal endpoints check `resolution_status` before processing:
- Prevents double-reversal from rapid retries or network replays
- Already-reversed records return a clear error instead of silently overwriting
- Permission tightened from `orders.refund_process` OR `customers.rms_charge.manage_links` to the dedicated `customers.rms_charge.reverse` (CFP-005)

### 2.3 POS Shipping Rates
```
POST /shipping-rates
  → Requires staff or POS session
  → Delegates to shippo::pos_shipping_rates()
  → Supports custom parcel dimensions and customs declarations
  → force_stub flag for testing without live Shippo API calls
  → Error mapping: InvalidAddress → 400, Api → 502, Database → 500
```

### 2.4 Permission Model
Two tiers of POS permission enforcement:
- **Session-level**: `require_staff_or_pos_register_session` — any authenticated staff OR a valid POS session token
- **Permission-level**: `require_pos_rms_permission` / `require_staff_rms_sensitive_permission` — staff must have specific effective permissions after role-based resolution

---

## 3. Comparison with April 2026 Audit

| Area | April 2026 | May 2026 | Status |
|:---|:---|:---|:---|
| RMS double-reversal | P1 risk (CFP-003) | `resolution_status` guard verified | ✅ Fixed |
| RMS permission scope | Overly broad (CFP-005) | Tightened to `customers.rms_charge.reverse` | ✅ Fixed |
| Shipping rates | Documented | Confirmed: Shippo + stub mode | ✅ No regression |
| Line meta resolution | Not documented | Verified: product/variant/SKU resolution | ✅ New finding |

---

## 4. Conclusion

**0 blockers, 0 regressions.** POS Logic helpers are production-ready with properly tightened permissions and double-reversal guards.
