# ros-gemma — ROS-AI worker (loopback HTTP)

> **Optional / historical (2026)** — The in-app **`/api/ai/*`** path and **`ai_doc_chunk`** table were **retired** (migration **78**). This worker is **not** required for shipped Help Center search. Any **new** local inference is **ROSIE** (**RiversideOS Intelligence Engine**) per **`docs/PLAN_LOCAL_LLM_HELP.md`** — not a revival of this worker as-is; see **`ROS_AI_INTEGRATION_PLAN.md`**.

**Purpose:** Small process that serves **`POST /v1/complete`** so **riverside-server** stays isolated from LLM memory and crashes.

**Architecture:** The main API calls the worker on loopback (**`AI_BASE_URL`**, default **`http://127.0.0.1:8787`**). Inference runs in **llama-server** (GGUF); **ros-gemma** maps Riverside’s JSON to **`POST /v1/chat/completions`** on that server.

## Canonical stack (this repo)

Everything runs from **root `docker-compose.yml`**:

1. **Once:** `./scripts/download-ros-ai-gguf.sh` — writes the pinned GGUF under **`tools/ros-gemma/models/`** (see **`MODEL_PIN.json`**). Windows: **`scripts/download-ros-ai-gguf.ps1`**.
2. **`docker compose up -d`** — starts **`db`**, **`llama-server`**, and **`ros-gemma`**.
3. **`ros-gemma`** image and Compose set **`LLAMA_CPP_SERVER_URL=http://llama-server:8080`**; **`llama-server`** loads **`/models/google_gemma-4-E2B-it-Q4_K_M.gguf`** inside the network (port **8080** is not published to the host).
4. On the **API** process: **`AI_ENABLED=true`** (**`server/.env`**). **`AI_BASE_URL`** defaults to **`http://127.0.0.1:8787`** when unset.

If completions still fail: **`docker compose build ros-gemma && docker compose up -d`** so the worker image includes current defaults.

### Pinned weights

| Item | Value |
|------|--------|
| **Family** | **Gemma 4** instruction-tuned **E2B-it** |
| **Size** | **2B** |
| **Format** | **GGUF** **Q4_K_M** |
| **Source** | **[`tools/ros-gemma/MODEL_PIN.json`](../tools/ros-gemma/MODEL_PIN.json)** — HF **`bartowski/google_gemma-4-E2B-it-GGUF`**, file **`google_gemma-4-E2B-it-Q4_K_M.gguf`** |

To change the model for the deployment, edit **`MODEL_PIN.json`** (and Compose **`llama-server`** command if the filename changes), then re-download.

## API test bypass

**`AI_MOCK=true`** on **riverside-server** skips the worker and returns deterministic mock completion text (for automated tests, not store inference).

## Env reference (`ros-gemma`)

| Variable | Default (this repo) | Role |
|----------|---------------------|------|
| `ROS_GEMMA_BIND` | `127.0.0.1:8787` (host binary) / `0.0.0.0:8787` (Compose) | Listen address |
| `ROS_GEMMA_SHARED_SECRET` | _(empty)_ | If set, required header **`x-ros-ai-worker-secret`** |
| `LLAMA_CPP_SERVER_URL` | **`http://llama-server:8080`** (Dockerfile + Compose) | llama-server base; proxy to **`/v1/chat/completions`** |
| `LLAMA_CPP_CHAT_MODEL` | `local` | JSON **`model`** field |
| `LLAMA_CPP_API_KEY` | _(empty)_ | If set, **`Authorization: Bearer`** to llama-server |
| `LLAMA_CPP_TIMEOUT_SEC` | `300` | Upstream HTTP timeout |
| `ROS_GEMMA_MODEL_PATH` | _(empty)_ | Operator hint only; GGUF path is **`llama-server`** `-m` in Compose |

Server-side: **`AI_ENABLED`**, **`AI_BASE_URL`**, **`AI_MOCK`**, **`AI_WORKER_*`** — **`server/.env.example`**.

## Health

**`GET /health`** includes **`inference_mode`**: **`llamacpp_http`** when a base URL is configured, else **`unconfigured`**. **`llm_ready`** mirrors whether a base URL is set (upstream may still error if **llama-server** is down).

## See also

- [`docs/API_AI.md`](API_AI.md) — **`/api/ai/*`**
- [`docs/ROS_AI_HELP_CORPUS.md`](ROS_AI_HELP_CORPUS.md) — staff doc RAG / embeddings (separate from this worker’s GGUF LLM)
- [`ROS_AI_INTEGRATION_PLAN.md`](../ROS_AI_INTEGRATION_PLAN.md)
