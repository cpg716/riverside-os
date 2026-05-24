# Audit Report: Fal.ai Visual Sidecar Integration (2026)
**Date:** 2026-05-23
**Status:** Hardened / Production-Grade
**Auditor:** Cascade

## 1. Executive Summary
The Fal.ai Visual Sidecar orchestrates AI-generated images for staff avatars, product catalog images, and promotional content. It dispatches jobs to Fal.ai's GPU queue and processes webhooks for completion, storing all assets locally per the Local-First & Offline-First architecture.

## 2. Technical Architecture

### 2.1 Dispatch Engine (`fal_sidecar.rs`)
- **Queue API**: Posts to `https://queue.fal.run/{model_endpoint}?fal_webhook={callback}`.
- **Auth**: Bearer key from `FAL_KEY` environment variable.
- **Tracking**: Jobs tracked in `fal_generation_jobs` table with status (`pending` → `processing` → `completed`/`failed`).
- **Webhook Callback**: `POST /api/webhooks/fal` receives completion notifications and triggers local download.

### 2.2 Local-First Storage
- Generated images are downloaded, resized, and cached locally in `client/public/fal/{job_type}/{target_id}.jpg`.
- CDN links from Fal.ai are never served directly in production.

## 3. Hardening (v0.70.x)

- **Retry Logic**: Queue submission (`dispatch_fal_task`) now retries up to **2 times** with exponential backoff (500ms → 1000ms) on network timeouts, connection errors, and HTTP 5xx. Failed jobs are updated to `failed` status with error message in `fal_generation_jobs`.
- **Health Check**: New `GET /api/ai/fal-health` endpoint probes the Fal.ai queue endpoint. Returns `configured`, `reachable`, `latency_ms`, `message`.

## 4. API Surface

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/ai/visual/dispatch` | Dispatch a visual generation job |
| `GET` | `/api/ai/visual/status/{job_id}` | Check job status |
| `GET` | `/api/ai/visual/jobs` | List recent jobs |
| `GET` | `/api/ai/fal-health` | **New** Live connectivity + latency check |

## 5. Conclusion
The Fal.ai Visual Sidecar is now a resilient, production-grade image generation pipeline. Retry logic protects against transient network failures, and the health check provides operational visibility without triggering actual generation jobs.

**Last reviewed:** 2026-05-23
