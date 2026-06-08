# Audit Report: Hardware & Printer Integration (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-08
**Version Audited:** v0.85.0 (commit `73cdd56`)
**Auditor:** Devin (AI assistant)
**Scope:** End-to-end trace of Thermal Hub — network printer communication (TCP), printer readiness checks, ESC/POS payload dispatch (text and raw binary), PNG-to-ESC/POS rasterization, error handling, and auth model.

---

## 1. Executive Summary

The Hardware & Printer Integration module ("Thermal Hub") provides a **server-mediated TCP bridge** for thermal receipt printers. The Rust backend acts as a proxy: the React frontend sends print jobs via HTTP, and the server opens a direct TCP socket to the printer on the LAN. This architecture avoids browser-level raw TCP limitations while keeping printer communication off the public internet.

**Overall Status:** Production Ready — 0 blockers, 0 regressions.

---

## 2. Architecture Trace

### 2.1 Endpoints
| Route | Method | Purpose |
|:---|:---|:---|
| `/print` | POST | Dispatch ESC/POS payload to printer |
| `/check-printer` | POST | Test printer TCP reachability |
| `/escpos-from-png` | POST | Convert PNG image to ESC/POS raster commands |

### 2.2 Print Dispatch Flow
```
POST /print
  → Auth: require_staff_or_pos_register_session
  → Payload: { ip, port, payload, format? }
  → Format handling:
      "raw_escpos_base64" → base64-decode to raw bytes
      (default) → UTF-8 text bytes
  → TCP connect with 5-second timeout
  → Write all bytes + flush
  → Return: { status: "dispatched" } or error
```

### 2.3 Printer Check Flow
```
POST /check-printer
  → Auth: require_staff_or_pos_register_session
  → Validate: IP not empty
  → TCP connect with 5-second timeout
  → Success → 200 { status: "reachable" }
  → Connection refused → 503 with error
  → Timeout → 504 "Printer connection timeout"
```

### 2.4 PNG-to-ESC/POS Rasterization
```
POST /escpos-from-png
  → Auth: require_staff_or_pos_register_session
  → Input: { png_base64 } (base64-encoded PNG)
  → Calls receipt_escpos_raster::png_to_escpos_tm_raster()
  → Returns { escpos_base64, width_dots }
  → Width: ESCPOS_RECEIPT_WIDTH_DOTS constant
```

### 2.5 Error Handling
All three endpoints produce structured JSON errors:
- `401 Unauthorized` — missing/invalid session
- `400 Bad Request` — invalid base64, empty IP
- `503 Service Unavailable` — printer TCP connection refused
- `504 Gateway Timeout` — printer connection timeout (5s)
- `500 Internal Server Error` — TCP write failure

### 2.6 Security Model
- All endpoints require `require_staff_or_pos_register_session` — same as POS checkout
- No IP allowlist for printer addresses (printers are LAN-only; the server itself is on the same LAN)
- No payload size limit in the API layer (Axum body limits apply at framework level)

---

## 3. Comparison with April 2026 Audit

| Area | April 2026 | May 2026 | Status |
|:---|:---|:---|:---|
| TCP bridge model | Documented | Verified: 5s timeout, error classification | ✅ No regression |
| Dual format support | Not documented | Verified: raw_escpos_base64 + UTF-8 text | ✅ New finding |
| PNG rasterization | Not documented | Verified: receipt_escpos_raster module | ✅ New finding |
| Auth model | Documented | Confirmed: session-level (no granular permission) | ✅ No regression |

---

## 4. Conclusion

**0 blockers, 0 regressions.** The Thermal Hub is production-ready: clean TCP bridge with proper timeout handling and dual-format support.
