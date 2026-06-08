# Audit Report: Fal.ai Visual Sidecar (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-25
**Version Audited:** v0.85.0 (commit `73cdd56`)
**Auditor:** Devin (AI assistant)
**Scope:** End-to-end trace of Fal.ai integration — visual generation dispatch, webhook callback processing, async download job with post-processing (avatar crop/resize, JPEG normalization), retry logic with exponential backoff, and health monitoring.

---

## 1. Executive Summary

Fal.ai provides **AI-powered visual generation** for Riverside OS — primarily staff avatar generation and product/promotional image creation. The integration uses a **queue-based async pattern**: dispatch a job to Fal.ai's queue API with a webhook callback URL, then process the completed result via a background download job. Job tracking is stored in `fal_generation_jobs` with full lifecycle states.

**Overall Status:** Production Ready — 0 blockers, 0 regressions.

---

## 2. Architecture Trace

### 2.1 Job Dispatch Flow
```
dispatch_fal_task(model_endpoint, payload, job_type, target_id, state)
  → Require FAL_KEY env var (error: MissingApiKey)
  → Require RIVERSIDE_PUBLIC_BASE_URL (error: MissingBaseUrl)
  → INSERT INTO fal_generation_jobs (status='pending')
  → Build webhook URL: {base}/api/webhooks/fal
  → POST to https://queue.fal.run/{endpoint}?fal_webhook={callback}
    → Authorization: Key {fal_key}
    → Retry: up to 3 attempts with exponential backoff (500ms × 2^n)
    → Network/timeout errors: auto-retry
    → Server errors (5xx): auto-retry
    → Client errors (4xx): fail immediately
  → On success: UPDATE status='processing', pending_job_id={request_id}
  → On failure: UPDATE status='failed', error_message={detail}
```

### 2.2 Retry Policy
```
FAL_MAX_RETRIES = 2 (total 3 attempts)
FAL_BASE_RETRY_DELAY_MS = 500ms
Delay: 500ms, 1000ms (exponential)
Retry conditions: timeout, connect error, 5xx server error
Fail fast: 4xx client errors, non-network errors
```

### 2.3 Background Download Job
```
FalDownloadHandler.handle(ctx)
  → Parse FalDownloadJobPayload
  → Download image from Fal CDN
  → Post-process based on job_type:
    → "staff_avatar": crop + resize to 512×512 JPEG via staff_avatar_processor
    → product/promo: re-encode to JPEG at quality 90
  → Store processed bytes to media asset
  → UPDATE fal_generation_jobs status='completed'
  → On any failure: UPDATE status='failed', error_message={detail}
```

### 2.4 Job States
| State | Meaning |
|:---|:---|
| `pending` | Job record created, not yet dispatched |
| `processing` | Dispatched to Fal.ai, awaiting webhook callback |
| `completed` | Asset downloaded and processed |
| `failed` | Error at any stage (dispatch, download, or processing) |

### 2.5 Health Check
```rust
FalHealth {
    configured: bool,  // FAL_KEY set?
    reachable: bool,   // Can reach queue.fal.run?
    latency_ms: u64,   // Response time
    message: String,   // Human-readable status
}
```
Health check probes `https://queue.fal.run/fal-ai/fast-sdxl` — accepts 200, 405, or 422 as "reachable" (405/422 indicate the endpoint exists but rejects the probe method/payload).

---

## 3. Comparison with April 2026 Audit

| Area | April 2026 | May 2026 | Status |
|:---|:---|:---|:---|
| Queue dispatch | Documented | Verified: full retry with exponential backoff | ✅ No regression |
| Webhook callback | Documented | Confirmed: async webhook → download job | ✅ No regression |
| Avatar processing | Not documented | Verified: 512×512 crop/resize via processor | ✅ New finding |
| JPEG normalization | Not documented | Verified: quality 90 re-encode for product/promo | ✅ New finding |
| Health check | Not documented | Verified: multi-status acceptance (200/405/422) | ✅ New finding |
| Error tracking | Documented | Confirmed: per-job error_message persistence | ✅ No regression |

---

## 4. Conclusion

**0 blockers, 0 regressions.** The Fal.ai integration is production-ready with robust retry logic, comprehensive job tracking, and proper post-processing.
