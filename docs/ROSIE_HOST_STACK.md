# ROSIE Host Stack

## Purpose
This file is the canonical source of truth for the approved ROSIE Host runtime stack.

It defines:
- the Host deployment model
- the approved production LLM / STT / TTS stack
- the fail-closed production policy
- what is implemented now vs what is development-only diagnostic support

If runtime code, env notes, or workstation setup drift from this file, this file wins and the drift must be corrected explicitly.

## Deployment Model

### Canonical Host Model
- One Host machine runs ROSIE.
- Tauri apps and PWAs use ROSIE through that Host.
- Assume one active ROSIE user at a time unless future capacity guidance explicitly documents broader concurrency.

### Architecture Constraint
- STT -> text -> ROSIE -> governed tools -> structured JSON -> visible text -> TTS
- Voice is an input/output layer on top of the same ROSIE pipeline.
- Voice does not create a second assistant path.
- Tool execution, RBAC, and ROSIE governance remain server-validated.

### Zero-Python Binary Deployment Model (v0.85.9+)

ROSIE is a **Zero-Python** stack. No Python interpreter, `pip`, `venv`, or `uv` is required on any workstation or server.

All runtime components are pre-compiled native binaries invoked directly by the server and Tauri processes:

| Component | Binary | Acquired via |
|---|---|---|
| **STT** | `sherpa-onnx-offline.exe` | `Install-RosieAiStack.ps1` downloads sherpa-onnx v1.13.4 from GitHub Releases |
| **TTS** | `sherpa-onnx-offline-tts.exe` | Same sherpa-onnx release package |
| **LLM** | `llama-server.exe` | Bundled in deployment package or downloaded by `Install-RosieAiStack.ps1` from llama.cpp releases |

**Binary path on Windows:** `C:\RiversideOS\rosie\bin\`

**Model paths on Windows:**

| Asset | Path |
|---|---|
| SenseVoice STT model | `C:\RiversideOS\rosie\stt\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17\` |
| Kokoro TTS model | `C:\RiversideOS\rosie\tts\kokoro-multi-lang-v1_1\` |
| Gemma QAT GGUF | `C:\RiversideOS\rosie\models\gemma-4-e4b\gemma-4-E4B_q4_0-it.gguf` |
| Gemma vision projector | `C:\RiversideOS\rosie\models\gemma-4-e4b\gemma-4-E4B-it-mmproj.gguf` |

**Acquisition behaviour:** Binaries and models are **never committed to git**. The deployment ZIP may optionally pre-bundle them for air-gapped installs. If absent, `Install-RosieAiStack.ps1` downloads them automatically on first run. Production install is fail-closed: LLM, STT, TTS, and required binaries must all verify before setup is considered successful.

**Readiness files:**
- `C:\RiversideOS\rosie\rosie_status.json` is the component-level readiness manifest and records LLM/STT/TTS/binary status.
- `C:\RiversideOS\rosie\gemma_model_certification.json` binds the active text model and projector to successful text, SSE streaming, native tool-calling, and image-input probes. Changing either file's path, length, or last-write time invalidates certification.
- `C:\RiversideOS\rosie\rosie_ready` is written only when the full ROSIE stack is usable.
- Deployment and audit tools must treat a missing `rosie_ready` as a ROSIE blocker, not as a successful degraded install.

**Version pins** (update the version pin block at the top of `Install-RosieAiStack.ps1`):
- sherpa-onnx: **v1.13.4** (Windows x64, archive SHA256-pinned)
- llama.cpp Host runtime: **b10229** (`llama-b10229-bin-win-cpu-x64.zip`, SHA256-pinned)
- STT model: `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`
- TTS model: `kokoro-multi-lang-v1_1`
- LLM: official Google `gemma-4-E4B_q4_0-it.gguf` plus matching `gemma-4-E4B-it-mmproj.gguf` (revision and SHA256 pinned in `tools/ros-gemma/MODEL_PIN.json`)

### macOS Development Speech Bridge

macOS development may run the repo helper scripts through the installed sherpa Python tool when the native `sherpa-onnx-offline` and `sherpa-onnx-offline-tts` binaries are not present under the local ROSIE root. The server and Tauri runtime still prefer native binaries first, then use `RIVERSIDE_ROSIE_SPEECH_PYTHON_PATH` or `~/.local/share/uv/tools/sherpa-onnx/bin/python` for workstation testing.

This is development/diagnostic support only. Windows Host production readiness remains zero-Python and fail-closed on missing native binaries or model assets.

## Token Telemetry and Cost Monitoring

### Purpose
ROSIE token telemetry tracks AI token usage for cost analysis when evaluating local LLMs vs cloud-based APIs. This enables data-driven decisions about scaling ROSIE to cloud providers.

### Data Collection
- **Table**: `rosie_token_telemetry` (migration `060_rosie_token_telemetry.sql`)
- **Fields**: `id` (UUID), `timestamp` (timestamptz), `model_name`, `provider`, `input_tokens`, `output_tokens`
- **Indexes**: Timestamp (DESC) for date-based queries, provider/model for provider comparison
- **Non-Blocking Recording**: Telemetry writes use `tokio::spawn` for fire-and-forget DB inserts, ensuring POS terminal performance is not impacted

### Metrics API
- **Endpoint**: `GET /api/settings/rosie/token-metrics`
- **Permission**: Requires `settings.admin`
- **Response**: Daily/monthly input and output tokens, configured comparison provider/model, configured input/output rates, and estimated monthly input/output/total cost
- **Cost Rate**: Read from ROSIE store settings (`external_input_cost_per_1m_tokens`, `external_output_cost_per_1m_tokens`) so admins can compare local Gemma usage against Gemini, OpenAI/ChatGPT, or a custom API rate card

### UI Component
- **Location**: `RosieSettingsPanel.tsx` → `RosieTokenMonitor` component
- **Display**: Daily/monthly LLM token use, input/output split, external API estimate, configured comparison provider/model, and configured input/output rates
- **Access**: Visible to staff with `help.manage` permission

### Operational Notes
- Telemetry is recorded for all ROSIE interactions regardless of provider (local or cloud)
- Cost estimates use configured provider rates; update the ROSIE settings rate fields when Gemini/OpenAI/other API pricing changes
- TTS/STT API cost is not included until ROSIE records speech input/output usage minutes
- Data supports comparison between local Gemma costs vs cloud API pricing models

## Approval Status Labels
- Approved production default: explicitly approved as the intended production stack baseline.
- Development/diagnostic only: may exist for local debugging, but must not be treated as production continuity.
- Temporary implementation: implemented now but not an approved long-term product decision.

## Approved Production Stack

### 1. LLM Providers

ROSIE selects the LLM provider with `ROSIE_PROVIDER`. Legacy `ROSIE_PROVIDER_MODE` and `RIVERSIDE_LLAMA_PROVIDER` remain mapped for compatibility.

| Provider | Runtime | Default / Required Config | Approval status |
|---|---|---|---|
| `local_llm` | Host-based `llama.cpp` `llama-server` | Save `ROSIE_LOCAL_LLM_BASE_URL` equivalent in Settings, or use fallback env / legacy `RIVERSIDE_LLAMA_UPSTREAM`; Gemma E4B GGUF at the local ROSIE model path | Approved production default |
| `remote_lmstudio` | Private OpenAI-compatible LM Studio endpoint on the work hub | Save base URL/model in Settings; fallback env is `ROSIE_REMOTE_LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1`, `ROSIE_REMOTE_LMSTUDIO_MODEL=gemma-4-12B-it-q5_k_m.gguf` | Approved explicit private provider |
| `openai` | OpenAI API, server-side only | Requires `ROSIE_ALLOW_CLOUD_PROVIDERS=true` plus an approved privacy review | Disabled by current production policy |
| `gemini` | Google Gemini API, server-side only | Requires `ROSIE_ALLOW_CLOUD_PROVIDERS=true` plus an approved privacy review | Disabled by current production policy |

Local Gemma details:
- Model selection evidence and acceptance gate: [`ROSIE_MODEL_SELECTION_2026-08.md`](ROSIE_MODEL_SELECTION_2026-08.md)
- Model family: Gemma 4 E4B
- Expected file: `gemma-4-E4B_q4_0-it.gguf`
- Matching vision projector: `gemma-4-E4B-it-mmproj.gguf`
- Default Host path: `~/Library/Application Support/riverside-os/rosie/models/gemma-4-e4b/gemma-4-E4B_q4_0-it.gguf`
- Desktop path: Tauri uses the Main Hub server-governed route by default. The `rosie_llama_*` direct/local path is host-only and requires an explicit `VITE_ROSIE_LLM_DIRECT=1` build setting.
- Server-governed Host path: `POST /api/help/rosie/v1/chat/completions`

Remote LM Studio details:
- LM Studio runs outside Riverside OS. ROSIE never starts, stops, or supervises the LM Studio process.
- LM Studio Remote / LM Link should expose the remote home RTX 4080 SUPER model through the work hub's local LM Studio server.
- ROSIE talks to the work hub endpoint, typically `http://127.0.0.1:1234/v1`.
- The remote model is expected to be `gemma-4-12B-it-q5_k_m.gguf`.
- Context length, GPU offload, Flash Attention, and KV cache are configured in LM Studio, not dynamically by Riverside OS.
- `ROSIE_REMOTE_LMSTUDIO_CONTEXT_HINT=65536` is informational/diagnostic unless a future implementation proves otherwise.
- For this setup, set `VITE_ROSIE_LLM_DIRECT=0` so desktop chat goes through the server-governed ROSIE route.

Recommended work-hub Remote LM Studio env:

```bash
ROSIE_PROVIDER=remote_lmstudio
ROSIE_REMOTE_LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1
ROSIE_REMOTE_LMSTUDIO_MODEL=gemma-4-12B-it-q5_k_m.gguf
ROSIE_REMOTE_LMSTUDIO_CONTEXT_HINT=65536
ROSIE_STT_PROVIDER=local
ROSIE_TTS_PROVIDER=local
VITE_ROSIE_LLM_DIRECT=0
```

Cloud provider policy:
- `ROSIE_ALLOW_CLOUD_PROVIDERS=false` is the production default and blocks public-cloud LLM, STT, and TTS selection.
- Settings intentionally exposes only the Main Hub and approved private LM Studio endpoints.
- Enabling public cloud requires an explicit future privacy review, deployment change, and `ROSIE_ALLOW_CLOUD_PROVIDERS=true`; enabling only the older sensitive-request flag is insufficient.

### 2. STT
- Provider selection: `ROSIE_STT_PROVIDER=local` in production. Cloud values are forced back to local while public cloud is disabled.
- Default engine: SenseVoice Small via Sherpa-ONNX
- Mode: explicit one-shot microphone capture only
- Expected assets:
  - `model.int8.onnx`
  - `tokens.txt`
- Default Host path: `~/Library/Application Support/riverside-os/rosie/stt/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/`
- Approval status: Approved production default

### 3. TTS
- Provider selection: `ROSIE_TTS_PROVIDER=local` in production. Cloud values are forced back to local while public cloud is disabled.
- Default engine: Kokoro-82M via Sherpa-ONNX
- Runtime expectation: local Host synthesis with direct process arguments, then workstation/browser playback through `/api/help/rosie/v1/voice/synthesize`
- Expected assets:
  - `model.onnx`
  - `voices.bin`
  - `tokens.txt`
  - `espeak-ng-data/`
- Default Host path: `~/Library/Application Support/riverside-os/rosie/tts/kokoro-multi-lang-v1_1/` with `v1_0` accepted only as a migration fallback.
- Approval status: Approved production default

### 4. Host optimization stance
- Preferred Host deployment uses OpenVINO where applicable.
- Do not assume AVX512.
- macOS workstation verification may still run `cpu` providers when OpenVINO is not applicable on that Host.
- Approval status: Approved production deployment note

## Production Reliability

### Host supervision
- `start-riverside-llama.ps1` registers `Riverside OS LLM Host` with persistent restart settings.
- `watch-rosie-stack.ps1` registers as `Riverside OS ROSIE Watchdog` during `Install-RosieAiStack.ps1`.
- The installer's full watchdog certification checks required binaries and assets, the LLM `/health` endpoint, text completion, SSE streaming, native structured tool calling, multimodal image input, and a bounded speech fixture that Kokoro synthesizes and SenseVoice transcribes.
- Standard Main Hub update workflows run the pinned ROSIE installer; matching assets are reused, while changed model pins are downloaded, activated, and certified automatically.
- Normal watchdog runs reuse certification only while it still matches the exact model/projector metadata. A failed new-model certification restores the previously configured model path when one is available; a successful upgrade removes superseded model files from the managed model directory to avoid retaining unnecessary multi-gigabyte weights.
- The watchdog records functional probe latency and results in `rosie_status.json`; file presence alone is not readiness.
- If the LLM HTTP health check fails, the watchdog starts the LLM host task or recreates it through `start-riverside-llama.ps1`.
- `rosie_ready` is removed when the stack is not fully healthy.

### Insight summaries
- Shared ROSIE insight summaries use the selected ROSIE LLM provider for non-streaming completions.
- Local Gemma still uses the OpenAI-compatible `llama-server` endpoint configured by `ROSIE_LOCAL_LLM_BASE_URL` or legacy `RIVERSIDE_LLAMA_UPSTREAM`.
- Remote LM Studio uses the OpenAI-compatible `ROSIE_REMOTE_LMSTUDIO_BASE_URL` endpoint and does not require a local model file.
- Gemma 4 E4B can spend the response budget in `reasoning_content` and return empty `message.content`; ROSIE insight summaries require usable `message.content`, and the UI shows a visible unavailable note when the summary cannot be produced.
- Help and conversational requests keep reasoning disabled for predictable latency. Analysis can opt into bounded Gemma thinking with `ROSIE_ENABLE_ANALYSIS_REASONING=true`; it remains off by default until the Main Hub benchmark is approved.
- The Host defaults to an explicit 8,192-token context, two slots, 512-token batch, 512-token micro-batch, and continuous batching. Gemma image encoding requires a micro-batch of at least 256 tokens; smaller values can terminate llama.cpp during image input. Override with `RIVERSIDE_LLAMA_CONTEXT_SIZE`, `RIVERSIDE_LLAMA_PARALLEL`, `RIVERSIDE_LLAMA_BATCH_SIZE`, and `RIVERSIDE_LLAMA_UBATCH_SIZE` after benchmarking without reducing the micro-batch below 256.

| `RIVERSIDE_LLAMA_PERF_PROFILE` | Intended host | Enforced llama.cpp launch posture |
|---|---|---|
| `auto` | Installer default | Windows auto-detects i9-12900 vs Ryzen 8840U; Apple Silicon defaults to `apple-m3-pro`; unknown hosts use `portable-cpu`. |
| `intel-i9-12900` | Main Hub i9-12900 | `--threads 8`, `--threads-batch 8`, strict `0xFFFF` P-core logical mask, `--gpu-layers 0`, `--device none`, `--flash-attn on`, `--mmap`, `--mlock`. |
| `minisforum-v3` | Minisforum V3 / Ryzen 7 8840U / 32GB | `--threads 8`, `--threads-batch 8`, strict `0xFFFF` CPU mask, `--gpu-layers 0`, `--device none`, `--flash-attn on`, `--mmap`, `--mlock`. |
| `apple-m3-pro` | MacBook Pro M3 Pro / 18GB | `--threads 6`, `--threads-batch 6`, `--gpu-layers 99` for Metal-capable test speed, `--flash-attn on`, `--mmap`. |
| `apple-m3-pro-cpu` | MacBook Pro M3 Pro CPU-parity testing | `--threads 6`, `--threads-batch 6`, `--gpu-layers 0`, `--device none`, `--flash-attn on`, `--mmap`. |
| `portable-cpu` | Unknown laptops/test hosts | Conservative CPU-only profile: 6 threads, GPU offload disabled, Flash Attention and mmap enabled. |

- Confirm `GET /health` returns `200`.
- Confirm `GET /v1/models` reports `gemma-4-E4B_q4_0-it.gguf`.
- Confirm `POST /api/help/rosie/v1/insight-summary` returns `status: "available"` with 1-3 bullets for a deterministic fact payload.
- Run `node scripts/rosie-model-eval.mjs` against each candidate local model endpoint. The fixture suite checks grounding, Riverside terminology, financial/logistical separation, and refusal of autonomous writes while reporting latency and token usage.
- Candidate weights or runtime pins must not replace production until the fixture pass rate is 100%, Main Hub latency is acceptable, STT/TTS watchdog probes pass, and a staff-reviewed workflow sample shows no regression.
- If the model is healthy but the insight response is still `unavailable`, check for empty `message.content` caused by reasoning output.
- ROSIE request payloads explicitly set the reasoning policy per request; Help and Conversation remain off, while Analysis is opt-in.
- `GET /api/ready` reports `rosie_llm`, `rosie_stt`, and `rosie_tts` as degraded components. Set `ROSIE_REQUIRED_FOR_READINESS=true` only if a deployment should return HTTP 503 when the assistive stack is unhealthy.
- Restart stale API processes after pulling a branch that changes ROSIE routes.

## Failure Behavior

### LLM
- Explicit `local_llm` failure surfaces ROSIE unavailable or a local provider error.
- Explicit `remote_lmstudio` failure surfaces ROSIE unavailable or an LM Studio endpoint error. It must not trigger bundled `llama-server` autostart.
- Explicit `openai` failure surfaces ROSIE unavailable or an OpenAI provider error.
- Explicit `gemini` failure surfaces ROSIE unavailable or a Gemini provider error.
- Auto mode may try `local_llm`, then private `remote_lmstudio`; it fails closed before public cloud under the current policy.
- Cloud fallback must not happen for sensitive requests unless `ROSIE_ALLOW_CLOUD_FOR_SENSITIVE=true`.
- PWA and server-governed calls use the same provider selection; desktop direct/local calls are only for local Gemma.

### STT
- If the selected STT provider is unavailable, voice input is blocked and the reason is shown.
- Remote LM Studio is LLM-only; it is not a speech provider.

### TTS
- If the selected TTS provider is unavailable, voice output is blocked and the reason is shown.
- Remote LM Studio is LLM-only; it is not a speech provider.

## Implemented Now
- Tauri direct/local `llama-server` path
- Server-governed ROSIE Host path
- SenseVoice Small STT wiring in the Tauri voice layer
- Kokoro-82M TTS wiring in the Tauri voice layer
- ROSIE Help Center voice controls and runtime status visibility
- `scripts/verify_rosie_local_stack.sh` local verification helper
- Provider abstraction for local Gemma, private Remote LM Studio, and disabled-unless-explicitly-approved cloud adapters
- Capability registry for ROSIE self-awareness
- E2E API gateway for manual generation and workflow testing
- Provider-governed SSE chat streaming with token telemetry, upstream error propagation, and cancellation when the client disconnects.
- Native Gemma function selection over the server's permission-filtered read-only tool registry. Calls still execute through the existing validation and fail-closed audit path.
- JPEG, PNG, and WebP image input (up to three 8 MB images) through the matching local multimodal projector. Attachments remain request-scoped and are not stored by ROSIE.

## Verified Now
- Gemma 4 E4B local Host runtime can load through the existing ROSIE runtime path.
- SenseVoice can transcribe local speech into the normal Ask ROSIE text path.
- Kokoro can speak ROSIE text responses after the governed ROSIE flow completes.

## Development/Diagnostic Only
- `whisper.cpp` + `ggml-small.en.bin`
- macOS `/usr/bin/say`
- any older tiny bootstrap model such as Qwen 0.5B

These may remain in the codebase for local debugging, but they are not production continuity paths.

## Runtime Expectations

### Host expectations
- The Host must provide the approved production assets or explicit env overrides for them.
- The Host is responsible for running the local ROSIE stack and keeping `rosie_ready` current.
- Runtime assumptions must be explicit in env/config and must match this file.
- For local development, `npm run dev` should auto-start the approved local Gemma Host runtime when the pinned assets are present and no explicit non-loopback upstream override is configured.

### Tauri expectations
- Tauri may use local/direct first when `local_first` is enabled.
- Tauri voice must remain explicit, push-to-talk or manual toggle only.
- Tauri must not create always-listening behavior.

### PWA expectations
- PWA uses the same governed ROSIE server path.
- PWA must not assume direct access to Host binaries.

## Related Files
- `docs/ROSIE_OPERATING_CONTRACT.md`
- `docs/PLAN_LOCAL_LLM_HELP.md`
- `docs/AI_CONTEXT_FOR_ASSISTANTS.md`
- `docs/ROSIE_IMPROVEMENT_PLAN.md`
- `DEVELOPER.md`
- `client/src-tauri/src/llama_server.rs`
- `client/src-tauri/src/rosie_voice.rs`
- `client/src/lib/rosie.ts`
- `client/src-tauri/binaries/README.md`
- `client/.env.example`
- `server/.env.example`
- `scripts/verify_rosie_local_stack.sh`
- `server/src/logic/rosie_gemini.rs` - Gemini API client
- `server/src/logic/rosie_provider.rs` - Provider abstraction
- `server/src/logic/rosie_provider_selection.rs` - Provider selection logic
