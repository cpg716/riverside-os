# Audit Report: Metabase Proxy (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-08
**Version Audited:** v0.85.5 (commit `e8edc0f4`)
**Auditor:** Devin (AI assistant)
**Scope:** End-to-end trace of Metabase reverse proxy — request routing, session handoff (silent auth via JWT SSO), iframe embedding controls, HTML rebranding injection, hop-by-hop header stripping, and upstream health/disable configuration.

---

## 1. Executive Summary

The Metabase Proxy provides a **reverse proxy** at `/metabase/*` that routes requests to a Metabase instance (default `http://127.0.0.1:3001`). It handles iframe embedding by stripping `X-Frame-Options` and `Content-Security-Policy` headers, supports silent authentication via `metabase_session_id` query parameter handoff, and injects CSS/JS to rebrand the Metabase UI as "Data Insights" within the Riverside OS Insights shell.

**Overall Status:** Production Ready — 0 blockers, 0 regressions.

---

## 2. Architecture Trace

### 2.1 Upstream Configuration
```
RIVERSIDE_METABASE_UPSTREAM env var:
  - Unset/empty → default to http://127.0.0.1:3001
  - "0" / "off" / "false" / "disabled" → proxy disabled (503)
  - Any URL → use as upstream base (trailing slash stripped)
```

### 2.2 Request Routing
```
/metabase → 301 permanent redirect to /metabase/
/metabase/* → proxy to upstream after stripping /metabase prefix

Request flow:
  1. Strip /metabase prefix from path
  2. Extract metabase_session_id from query params (silent auth)
  3. Filter remaining query params
  4. Build upstream URL: {base}{path}?{filtered_query}
  5. Forward method + headers (strip hop-by-hop + Host + Accept-Encoding)
  6. Add X-Forwarded-Host and X-Forwarded-Proto headers
  7. Read request body (256 MB limit)
  8. Proxy to upstream
```

### 2.3 Response Processing
For **HTML responses** (Content-Type: text/html):
- Strip `X-Frame-Options`, `Content-Security-Policy`, `Content-Security-Policy-Report-Only`
- Strip `Content-Encoding` (since body is modified)
- Inject rebranding CSS/JS before `</head>`:
  - CSS: hides Metabase logos, applies Riverside OS purple accent (#7c3aed)
  - JS: renames "Metabase" to "Data Insights" in page title and all text nodes (runs on interval)
- Remove `Content-Length` (Axum recalculates after modification)
- Set `metabase.SESSION` cookie if silent auth handoff was used

For **non-HTML responses** (API JSON, assets, etc.):
- Stream body directly (efficient for large payloads)
- Only strip hop-by-hop and embed-blocking headers

### 2.4 Silent Auth Session Handoff
```
GET /metabase/?metabase_session_id=abc123
  → Extract session ID from query params
  → Strip from forwarded query (Metabase doesn't expect it)
  → On HTML response: Set-Cookie: metabase.SESSION=abc123; Path=/metabase; HttpOnly; SameSite=Lax
```

This enables the Insights shell to authenticate users via JWT SSO without requiring a separate Metabase login.

### 2.5 Header Security
Stripped from forwarded requests:
- Hop-by-hop: `connection`, `keep-alive`, `proxy-authenticate/authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`
- `host` (replaced by upstream)
- `accept-encoding` (proxy handles decompression for HTML injection)

Stripped from responses:
- `x-frame-options` (allows iframe embedding)
- `content-security-policy` / `content-security-policy-report-only`
- Hop-by-hop headers

---

## 3. Comparison with April 2026 Audit

| Area | April 2026 | May 2026 | Status |
|:---|:---|:---|:---|
| Reverse proxy | Documented | Verified: path stripping, header forwarding | ✅ No regression |
| Silent auth handoff | Not documented | Verified: query param → cookie flow | ✅ New finding |
| HTML rebranding | Not documented | Verified: CSS/JS injection, "Data Insights" branding | ✅ New finding |
| Iframe embed support | Documented | Confirmed: CSP/X-Frame-Options stripped | ✅ No regression |
| Disable mechanism | Not documented | Verified: env var 0/off/false/disabled | ✅ New finding |

---

## 4. Conclusion

**0 blockers, 0 regressions.** The Metabase Proxy is production-ready with proper iframe embedding support, silent authentication, and white-label rebranding.
