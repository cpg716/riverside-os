---
name: ROS AI — retired in-app stack
overview: >
  The former ROS-AI platform (pgvector **`ai_doc_chunk`**, saved NL reports, **`POST /api/ai/*`**, llama worker) was **removed** by migration **`78`**. Staff help today is **Help Center** + **`GET /api/help/search`** (migration **79**, **`PLAN_HELP_CENTER.md`**). **Forward-looking** assistant **ROSIE** (**RiversideOS Intelligence Engine**): local LLM / multimodal help on **Windows 11** (**Axum + Tauri**, inference **sidecar**, whitelisted tools, privacy, Help Center **Ask ROSIE** UX)—**`docs/PLAN_LOCAL_LLM_HELP.md`**. This root file stays the **retirement pointer** plus a short bridge; pre-78 detail remains **historical** only.
todos: []
isProject: false
---

# ROS AI integration — status (2026)

> **Browser / PDF note:** If you opened this from a Markdown preview that hides YAML, the first lines above are **frontmatter** stating this file is a **retirement pointer** for the **removed** in-app stack, not an active build spec for new DB AI tables.
>
> **Ground truth:** Migration **`78_retire_ros_ai_tables.sql`** removed **`ai_doc_chunk`**, **`ai_saved_report`**, **`vector`**, and **`ai_assist` / `ai_reports`**. Staff help ships as **Help Center** + **`GET /api/help/search`** (migration **79**, **`PLAN_HELP_CENTER.md`**, **`docs/MANUAL_CREATION.md`**). **`docs/API_AI.md`** describes a **historical** `/api/ai/*` contract — **no** such router on a DB past **78**.

## Current product (what to build on)

| Need | Where |
|------|--------|
| In-app help for staff | **`HelpCenterDrawer`**, manuals under **`client/src/assets/docs/`**, **`client/src/lib/help/`** |
| Search | **`GET /api/help/search`** (`server/src/api/help.rs`); optional **`RIVERSIDE_MEILISEARCH_URL`** index **`ros_help`** — **`docs/SEARCH_AND_PAGINATION.md`**, **`PLAN_HELP_CENTER.md`**, **`docs/MANUAL_CREATION.md`** |
| Overrides / RBAC | Migration **79**: **`help_manual_policy`**, **`help.manage`** |
| Duplicate review (CRM) | **`customer_duplicate_review_queue`** (from migration **62**) and **`customers_duplicate_review`** / **`customers.merge`** (**64**) — **not** dependent on LLM; merge remains **`POST /api/customers/merge`** |
| **ROSIE** — RiversideOS Intelligence Engine (**planning only**) | **[`docs/PLAN_LOCAL_LLM_HELP.md`](docs/PLAN_LOCAL_LLM_HELP.md)** — **not shipped**. In-product home: **Help Center** **Ask ROSIE** (alongside Browse + Search). Baseline: **Windows 11** for **Axum** + **Tauri**; local inference as a **sidecar** (e.g. llama.cpp-class, **CPU-first** then **CUDA / Vulkan / DirectML** per build—not **ROCm**-as-default); **Axum** remains the **trust boundary** (RBAC, Postgres); model **tools** are **whitelisted** reads only (**`help_search`**, **[`docs/AI_REPORTING_DATA_CATALOG.md`](docs/AI_REPORTING_DATA_CATALOG.md)** specs including Curated Reports v1, CRM reads with permission parity)—**no** ad-hoc SQL. **Go-live status check:** **[`ThingsBeforeLaunch.md`](ThingsBeforeLaunch.md)** § **LLM / staff “AI”**. |

There is **no** **`/api/ai`** router, **`AiCompletion`**, **`ros-gemma`**, or **`ai_doc_chunk`** in a database that has applied migration **78**.

## Forward-looking design (summary — see full spec)

The canonical **system design** (architecture diagram, phased roadmap, privacy, component table, implementation checklist) is **[`docs/PLAN_LOCAL_LLM_HELP.md`](docs/PLAN_LOCAL_LLM_HELP.md)**. This section only aligns expectations with that doc:

- **Deploy reality:** Validate **Win x64** binaries, services, paths, and AV/firewall for **localhost** tool traffic—not Linux-only GPU stacks.
- **Split:** **Tauri** + **React** talk to **Axum** for data; the **LLM process** is separate; do not give the model **Postgres credentials** or arbitrary query strings.
- **NL / reporting:** Same safety rules as **[`docs/AI_REPORTING_DATA_CATALOG.md`](docs/AI_REPORTING_DATA_CATALOG.md)** — **`rust_decimal`** on the server, **compile-time-approved** read paths only. **ROSIE** system prompts and RAG should treat **[`docs/AI_CONTEXT_FOR_ASSISTANTS.md`](docs/AI_CONTEXT_FOR_ASSISTANTS.md)** + **`AI_REPORTING_DATA_CATALOG`** as the **assistant constitution** (see **`docs/PLAN_LOCAL_LLM_HELP.md`** § *Controlling prompt & model grounding*).
- **Vision (later):** Opt-in, policy-bound; prefer **route + component context** before pixels; see the full plan for register-display cautions.
- **ROSIE naming:** Use **ROSIE** / **RiversideOS Intelligence Engine** in UI copy and new routes (e.g. **`/api/help/rosie/*`**); do not revive **`/api/ai`** without a new migration story.

Anything **not** listed in **`PLAN_LOCAL_LLM_HELP.md`** should not be assumed approved for build.

## What migration 78 removed

From **`migrations/78_retire_ros_ai_tables.sql`**:

- Tables **`ai_saved_report`**, **`ai_doc_chunk`**
- RBAC keys **`ai_assist`**, **`ai_reports`** (overrides and role seeds)
- PostgreSQL extension **`vector`** when no longer required

**Docker / Postgres:** Compose may still use **`pgvector/pgvector:pg16`**; that is compatible with both legacy installs and **`78`** (which drops the extension if present). See **`AGENTS.md`** and **`README.md`** quick start.

## Historical reference (pre-78 — do not treat as active spec)

The repository previously shipped an optional **llama-server** + **ros-gemma** worker, hybrid RAG over **`ai_doc_chunk`** (FTS + trigram + 384-d embeddings), **`RosAiDrawer`**, and **`POST /api/ai/help`** plus NL reporting primitives. That stack was intentionally retired; the long-form design doc that lived at this path described that architecture.

**Archived detail** that may still be useful as *ideas only*: [`docs/API_AI.md`](docs/API_AI.md), [`docs/ROS_AI_HELP_CORPUS.md`](docs/ROS_AI_HELP_CORPUS.md), [`docs/ROS_GEMMA_WORKER.md`](docs/ROS_GEMMA_WORKER.md), and git history for removed **`server/src/api/ai.rs`** / **`logic/ai_*`** modules.

---

## If you reintroduce LLM features later

Reuse the **non-negotiables** from the old plan (still valid engineering discipline):

- **Thin Axum handlers**; domain logic in **`server/src/logic/`** / **`services/`**
- **No silent financial or inventory writes** from model output — explicit staff actions and existing domain APIs only
- **RBAC parity** with underlying read APIs for any “ask the data” feature
- **No `f32`/`f64` for money** — `rust_decimal::Decimal` at boundaries

**Implementation source of truth:** phased spikes, sidecar/Tauri notes, tool examples, and privacy protocol — **[`docs/PLAN_LOCAL_LLM_HELP.md`](docs/PLAN_LOCAL_LLM_HELP.md)**. Update **that** file when the architecture moves; keep **this** file as the **what shipped vs what was removed** pointer plus the bridge above.

New work should **not** assume **`ai_doc_chunk`**, **pgvector**, or **`POST /api/ai/*`** will return unchanged without an **explicit migration story** and product sign-off.
