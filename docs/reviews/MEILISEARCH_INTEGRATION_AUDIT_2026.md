# Audit Report: Meilisearch Integration
**Date:** 2026-05-23
**Status:** Hardened / Production-Grade
**Auditor:** Cascade

## 1. Executive Summary
Meilisearch powers Riverside OS's fast, typo-tolerant search across customers, orders, products, alterations, staff, and help manuals. The integration is best-effort: when Meilisearch is unavailable, search falls back to PostgreSQL `ILIKE` queries, ensuring zero downtime.

## 2. Technical Architecture

### 2.1 Client Bootstrap (`meilisearch_client.rs`)
- Reads `RIVERSIDE_MEILISEARCH_URL` and `RIVERSIDE_MEILISEARCH_API_KEY` at startup.
- Creates a shared `meilisearch_sdk::Client` stored in `AppState`.
- When `RIVERSIDE_MEILISEARCH_URL` is unset, `AppState.meilisearch` is `None` and all search routes gracefully fall back to SQL.

### 2.2 Index Settings
Per-index configuration is stored in `meilisearch_client.rs`:
- `ros_variants` — product catalog search (SKU, barcode, name, brand)
- `ros_customers` — CRM search (name, phone digits, email, code)
- `ros_orders` — order lookup by ID, customer name, display ID
- `ros_alterations` — alteration work orders
- `ros_help` — chunked staff manual content for ROSIE / help search
- `ros_staff` — staff directory for admin lookup
- Additional indexes: `ros_store_products`, `ros_wedding_parties`, `ros_transactions`, `ros_tasks`, `ros_appointments`, `ros_categories`, `ros_vendors`

### 2.3 Sync Pipeline (`meilisearch_sync.rs`)
- **Incremental sync**: Upsert/delete individual documents on create/update/delete events.
- **Full reindex**: Nightly or on-demand rebuild using temp-index swap pattern to avoid downtime.
- **Sync status tracking**: `meilisearch_sync_status` table records last attempt, success flag, row count, and error message per index.

### 2.4 Help Corpus Indexing (`help_corpus.rs`)
- Parses markdown manuals, strips YAML front matter, splits into semantic chunks.
- Generates URL slugs and indexes into `ros_help`.
- Reindex uses temp-index swap to keep search live during rebuild.

### 2.5 Search Execution (`meilisearch_search.rs`)
- `search_help_chunks()` powers the `/api/help/search` endpoint.
- `search_staff_ids()` powers staff directory lookups.
- Results are mapped to lightweight DTOs and returned with hit highlighting.

## 3. Hardening Applied (v0.70.x)

### 3.1 Document Enqueue Retry Logic
- `enqueue_documents` in `meilisearch_sync.rs` now retries up to **3 times** with exponential backoff (300ms → 600ms → 1200ms).
- Retries are triggered on `Meilisearch` SDK errors and HTTP transport errors.
- Non-retryable errors (e.g., auth, malformed payload) fail fast to prevent infinite loops.

### 3.2 Meilisearch Health Check Endpoint
- New `GET /api/help/admin/ops/meilisearch-health` endpoint verifies sidecar reachability.
- Returns JSON with `configured`, `reachable`, `indexing`, `latency_ms`, and `message`.
- Requires `help.manage` permission.
- Gracefully handles unconfigured state (`RIVERSIDE_MEILISEARCH_URL` unset).

## 4. API Surface

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/help/search` | Search help manuals (public) |
| `GET` | `/api/help/admin/ops/status` | Includes `meilisearch_configured` and `meilisearch_indexing` |
| `GET` | `/api/help/admin/ops/meilisearch-health` | **New** Live health check with latency |
| `POST` | `/api/help/admin/ops/reindex-search` | Reindex help corpus (with optional full fallback) |
| `GET` | `/api/insights/metabase-health` | **New** Metabase upstream health |

## 5. Findings & Recommendations
1. **Graceful Degradation**: The PostgreSQL fallback for all search endpoints is a critical reliability feature. Verified and retained.
2. **Temp-Index Swap**: The swap-based reindex pattern prevents search downtime during full rebuilds. Verified in all reindex flows.
3. **Future Enhancement**: Consider exposing Meilisearch sync status metrics to the Prometheus metrics endpoint for operational alerting.

## 6. Conclusion
The Meilisearch integration is a **robust, resilient search layer**. It provides sub-second fuzzy search across the entire Riverside data corpus while gracefully degrading to SQL when the sidecar is unavailable. Retry logic and health checks bring it in line with enterprise production standards.
