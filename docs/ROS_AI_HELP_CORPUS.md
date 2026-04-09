# ROS-AI staff help corpus (RAG)

> **Historical (pre–migration 78)** — Table **`ai_doc_chunk`** and **`vector`** were **dropped** by **`78_retire_ros_ai_tables.sql`**. Current staff help indexes **`ros_help`** and **`GET /api/help/search`** — **`PLAN_HELP_CENTER.md`**, **`docs/MANUAL_CREATION.md`**. The sections below describe the **old** RAG pipeline for reference and git archaeology.

Operational guide for **Pillar 1** contextual help *(retired)*: what was indexed, how retrieval worked, and how to **rebuild** chunks and **embeddings** after doc changes.

**Retirement pointer:** [`ROS_AI_INTEGRATION_PLAN.md`](../ROS_AI_INTEGRATION_PLAN.md) · **Old HTTP contract (not served):** [`docs/API_AI.md`](API_AI.md) · **Staff authoring:** [`docs/staff/README.md`](staff/README.md) · **Assistant routing:** [`docs/AI_CONTEXT_FOR_ASSISTANTS.md`](AI_CONTEXT_FOR_ASSISTANTS.md)

---

## Source of truth

| Artifact | Role |
|----------|------|
| [`docs/staff/CORPUS.manifest.json`](staff/CORPUS.manifest.json) | Ordered list of **repo-relative** Markdown paths ingested into **`ai_doc_chunk`**. |
| Files under **`docs/staff/`** | Human-facing guides; keep aligned with sidebar labels ([`Sidebar.tsx`](../client/src/components/layout/Sidebar.tsx), [`PosSidebar.tsx`](../client/src/components/pos/PosSidebar.tsx)). |

When you **add or rename** a staff guide, update the manifest (and run drift check — below).

---

## Database and migrations

| Migration | What it adds |
|-----------|----------------|
| **62** | **`vector`** extension, **`ai_doc_chunk`** with **`content_tsv`** (FTS) and **`embedding vector(384)`**, plus other AI tables — see **`DEVELOPER.md`**. |
| **65** | **`pg_trgm`** + GIN on **`ai_doc_chunk.content`** for trigram similarity alongside FTS. |

---

## Retrieval (how `POST /api/ai/help` finds chunks)

1. **Lexical:** PostgreSQL **FTS** on **`content_tsv`** and **`pg_trgm`** **`similarity(content, query)`** (migration **65**).
2. **Dense (when available):** If **`AI_EMBEDDINGS_ENABLED`** is on (default) and at least one row has **`embedding IS NOT NULL`**, the server embeds the user question with **fastembed** **AllMiniLML6V2** (384 dimensions) and merges **cosine-style** vector distance with normalized lexical scores in **`server/src/logic/ai_docs.rs`**.
3. **Fallback:** If embeddings are disabled, all **`embedding`** values are null, or query embedding fails, search uses **lexical-only** (logged at **warn**).

**Code:** `server/src/logic/ai_docs.rs` (chunk + search), `server/src/logic/ai_embed.rs` (ONNX model in **`spawn_blocking`**).

---

## Reindexing (chunks + vectors)

**Admin API:** **`POST /api/ai/admin/reindex-docs`** — requires **`settings.admin`**. Body optional: `{ "repo_root": "/absolute/path/to/riverside-os" }`. If omitted, the server uses **`RIVERSIDE_REPO_ROOT`** env or fails if the path is not a directory containing **`docs/staff/CORPUS.manifest.json`**.

**Behavior:**

1. For each manifest path: **DELETE** existing rows for that **`source_path`**, **INSERT** new rows (chunked markdown).
2. **Commit** the transaction.
3. If **`AI_EMBEDDINGS_ENABLED`** is not false/0: for each path, **embed** all new chunks and **UPDATE** **`ai_doc_chunk.embedding`**.

First run may **download** ONNX / tokenizer artifacts (HF hub); cache defaults under **`.fastembed_cache`** or **`FASTEMBED_CACHE_DIR`**.

**Local convenience (API must already be listening):**

```bash
# From repo root; defaults to repo root + staff 1234/1234 — see script header for overrides
npm run reindex:staff-docs
```

The script **`curl`**s **`127.0.0.1:3000`**; start the API first (**`npm run dev`** / **`npm run dev:server`**, or **`bash scripts/dev-server.sh`**). **`curl: (7) Failed to connect`** means nothing is bound on that port.

Script: [`scripts/ros-ai-reindex-local.sh`](../scripts/ros-ai-reindex-local.sh). Env: **`ROS_REINDEX_API_BASE`**, **`RIVERSIDE_REPO_ROOT`**, **`E2E_BO_STAFF_CODE`**, **`E2E_BO_STAFF_PIN`**.

---

## Environment variables

| Variable | Notes |
|----------|--------|
| **`RIVERSIDE_REPO_ROOT`** | Absolute path to clone root for reindex when the request body omits **`repo_root`**. |
| **`AI_EMBEDDINGS_ENABLED`** | Default on; **`false`** / **`0`** / **`no`** skips writing vectors at reindex and forces lexical-only help search. See [`server/.env.example`](../server/.env.example). |
| **`FASTEMBED_CACHE_DIR`** | Optional override for ONNX/tokenizer cache (defaults documented in fastembed). |

**LLM** for answer wording (separate from retrieval): **`AI_ENABLED`**, **`AI_BASE_URL`**, etc. — [`docs/API_AI.md`](API_AI.md), [`docs/ROS_GEMMA_WORKER.md`](ROS_GEMMA_WORKER.md).

---

## Toolchain

The API server pins **Rust 1.88+** in **`server/rust-toolchain.toml`** (**`ort`** / **fastembed**). If **`cargo`** invokes **Homebrew `rustc` 1.86**, use **`npm run check:server`** from the repo root (**`scripts/cargo-server.sh`**, same **`PATH`** fix as **`dev-server.sh`**), put **`~/.cargo/bin`** first on **`PATH`**, or run **`rustup run 1.88 cargo …`** — **`DEVELOPER.md`** § Build / quality checks.

---

## Verification and drift

```bash
# Manifest paths exist; no orphan docs/staff/*.md (see docs/AI_CONTEXT_FOR_ASSISTANTS.md §8)
npm run verify:ai-docs
# or: python3 scripts/verify_ai_knowledge_drift.py
```

**SQL spot-check** (embeddings backfilled):

```sql
SELECT COUNT(*) AS chunks, COUNT(embedding) AS with_embedding FROM ai_doc_chunk;
```

---

## Troubleshooting

| Symptom | Check |
|---------|--------|
| Reindex **400** “set repo_root…” | Set **`RIVERSIDE_REPO_ROOT`** or pass **`repo_root`** in JSON. |
| Help always lexical-only | **`AI_EMBEDDINGS_ENABLED`**, or run reindex with embeddings on; confirm **`COUNT(embedding)`** > 0. |
| **`ort` / rustc errors** | Use **Rust 1.88+** per **`server/rust-toolchain.toml`**. |
| Reindex slow / disk | First embed run downloads model; ensure free disk and network for HF. |
