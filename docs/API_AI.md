# ROS-AI HTTP API (internal reference)

> **RETIRED — historical contract only (2026-04)**  
> Migration **`78_retire_ros_ai_tables.sql`** removed the in-app AI database artifacts and RBAC keys. Current servers **do not** mount **`/api/ai/*`**. Use **Help Center** manuals, **`GET /api/help/search`**, and optional Meilisearch (**`docs/SEARCH_AND_PAGINATION.md`**, **`PLAN_HELP_CENTER.md`**, **`ROS_AI_INTEGRATION_PLAN.md`** at repo root). The sections below document the **pre-78** API for archaeology and RAG ideas only.

**Base path:** *(was)* `/api/ai/*` on the Axum server. **Auth:** staff headers (`x-riverside-staff-code`, PIN when required) unless noted. **Kill switch:** `AI_ENABLED=false` returns **503** on most routes.

This document was the **contract summary** (no generated OpenAPI in-tree). Handlers *previously* lived in `server/src/api/ai.rs`; that module is **not** in current builds after **78**.

---

## Health and status

| Method | Path | Permission | Response notes |
|--------|------|------------|----------------|
| `GET` | `/api/ai/health` | Authenticated staff | Worker reachability probe. |
| `GET` | `/api/ai/status` | Authenticated staff | `{ ai_config_enabled, worker_ok, help_doc_chunks, can_help, can_reports }` — client uses this to show the robot affordance. |

---

## Help (Pillar 1)

| Method | Path | Permission | Body | Response |
|--------|------|------------|------|----------|
| `POST` | `/api/ai/help` | `ai_assist` | `{ "question": string, "top_k"?: number }` | `{ "answer": string, "sources": [{ "path", "chunk_index", "excerpt" }] }` |

Retrieval is **hybrid**: **PostgreSQL FTS + pg_trgm** on `ai_doc_chunk` (migration **65**) **and**, when **`embedding`** is populated (384-d cosine via pgvector, migration **62**), a **merged lexical + dense** ranking. Reindex **`POST /api/ai/admin/reindex-docs`** reparses the staff manifest and, unless **`AI_EMBEDDINGS_ENABLED`** is false/0, fills **`embedding`** with local **fastembed** (AllMiniLML6V2). Query-time embed failures fall back to lexical-only.

---

## Assistive search (Pillar 2)

| Method | Path | Permission | Body |
|--------|------|------------|------|
| `POST` | `/api/ai/search/inventory` | `ai_assist` | `{ "hint": string, … }` — see handler for limits. |
| `POST` | `/api/ai/search/customers` | `ai_assist` | Same pattern. |

Responses include deterministic candidates plus optional `assist_note` from the worker/mock.

---

## Variant draft (Pillar 3)

| Method | Path | Permission | Body |
|--------|------|------------|------|
| `POST` | `/api/ai/inventory/variant-draft` | `ai_assist` + `catalog.edit` | `{ "category_id": uuid, "notes": string }` |

Response: `{ "variants": [{ "row_value", "col_value", "suggested_sku_suffix"? }] }`.

---

## NL reports (Pillar 4)

All routes require **`ai_reports`** and **`insights.view`** (plus `AI_ENABLED`, rate limits).

| Method | Path | Body / notes |
|--------|------|--------------|
| `POST` | `/api/ai/reports/interpret` | `{ "phrase": string }` → whitelisted `spec` JSON. |
| `POST` | `/api/ai/reports/execute` | `{ "spec": <ReportSpec> }` → `{ "rows": [ { "bucket", "gross_revenue", "order_count" } ], "truncated"?: … }`. |
| `POST` | `/api/ai/reports/narrate` | Arbitrary JSON (e.g. `phrase`, `spec`, `rows`) flattened for the prompt → `{ "narration": string }`. |
| `GET` | `/api/ai/reports/saved` | Lists current staff’s saved specs. |
| `POST` | `/api/ai/reports/saved` | `{ "title": string, "spec": <ReportSpec> }`. |
| `DELETE` | `/api/ai/reports/saved/{id}` | Remove a saved spec. |

`ReportSpec` is a tagged union (`kind: "sales_pivot"`, …) validated server-side — **never raw SQL** from the client.

---

## Admin

| Method | Path | Permission | Body |
|--------|------|------------|------|
| `POST` | `/api/ai/admin/reindex-docs` | `settings.admin` | `{ "repo_root"?: string }` — defaults to server env `RIVERSIDE_REPO_ROOT` / cwd. Rebuilds chunks and (when embeddings enabled) ONNX vectors; first run may download model weights to cache. |

---

## Worker (loopback)

The API calls **`POST {AI_BASE_URL}/v1/complete`** with JSON `{ "system", "user", "max_tokens" }` and expects `{ "text" }`. Optional header `x-ros-ai-worker-secret` when `AI_WORKER_SHARED_SECRET` is set. See [`docs/ROS_GEMMA_WORKER.md`](ROS_GEMMA_WORKER.md).

---

## Related

- [`ROS_AI_INTEGRATION_PLAN.md`](../ROS_AI_INTEGRATION_PLAN.md) — phases and safety.
- [`docs/ROS_AI_HELP_CORPUS.md`](ROS_AI_HELP_CORPUS.md) — staff manifest, hybrid retrieval, reindex, embeddings env, Rust toolchain.
- [`docs/AI_REPORTING_DATA_CATALOG.md`](AI_REPORTING_DATA_CATALOG.md) — RBAC vs Insights.
