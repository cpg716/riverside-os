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
| **STT** | `sherpa-onnx-offline.exe` | `Install-RosieAiStack.ps1` downloads sherpa-onnx v1.13.2 from GitHub Releases |
| **TTS** | `sherpa-onnx-offline-tts.exe` | Same sherpa-onnx release package |
| **LLM** | `llama-server.exe` | Bundled in deployment package or downloaded by `Install-RosieAiStack.ps1` from llama.cpp releases |

**Binary path on Windows:** `C:\RiversideOS\rosie\bin\`

**Model paths on Windows:**

| Asset | Path |
|---|---|
| SenseVoice STT model | `C:\RiversideOS\rosie\stt\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17\` |
| Kokoro TTS model | `C:\RiversideOS\rosie\tts\kokoro-multi-lang-v1_0\` |
| Gemma GGUF | `C:\RiversideOS\rosie\models\gemma-4-e4b\google_gemma-4-E4B-it-Q4_K_M.gguf` |

**Acquisition behaviour:** Binaries and models are **never committed to git**. The deployment ZIP may optionally pre-bundle them for air-gapped installs. If absent, `Install-RosieAiStack.ps1` downloads them automatically on first run. Production install is fail-closed: LLM, STT, TTS, and required binaries must all verify before setup is considered successful.

**Readiness files:**
- `C:\RiversideOS\rosie\rosie_status.json` is the component-level readiness manifest and records LLM/STT/TTS/binary status.
- `C:\RiversideOS\rosie\rosie_ready` is written only when the full ROSIE stack is usable.
- Deployment and audit tools must treat a missing `rosie_ready` as a ROSIE blocker, not as a successful degraded install.

**Version pins** (update the version pin block at the top of `Install-RosieAiStack.ps1`):
- sherpa-onnx: **v1.13.2** (Windows x64)
- llama.cpp Host runtime: **b9512** (`llama-b9512-bin-win-cpu-x64.zip`, SHA256-pinned)
- STT model: `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`
- TTS model: `kokoro-multi-lang-v1_0`
- LLM: `bartowski/google_gemma-4-E4B-it-Q4_K_M.gguf` (SHA256-pinned)

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

### 1. LLM
- Runtime: Host-based `llama.cpp` `llama-server`
- Model family: Gemma 4 E4B
- Expected file: `google_gemma-4-E4B-it-Q4_K_M.gguf`
- Default Host path: `~/Library/Application Support/riverside-os/rosie/models/gemma-4-e4b/google_gemma-4-E4B-it-Q4_K_M.gguf`
- Desktop path: Tauri direct/local via `rosie_llama_*`
- Server-governed Host path: `POST /api/help/rosie/v1/chat/completions`
- Approval status: Approved production default

### 1.5. Optional Cloud Provider (Gemini API)
- Runtime: Google Gemini API (cloud-based)
- Model family: Gemini 2.5 Pro
- Configuration: `GEMINI_API_KEY` environment variable
- Provider selection: `ROSIE_PROVIDER_MODE` (production default: `local-gemma`; `gemini-api` and `auto` require explicit configuration)
- Privacy mode: `ROSIE_FORCE_LOCAL_FOR_SENSITIVE` (default: true)
- Approval status: Optional explicit provider, not production fallback
- Use case: Faster inference, multimodal understanding, streaming responses
- Failure behavior: cloud provider failure returns to local Gemma only when explicitly configured; local Gemma failure blocks ROSIE until the Host stack is healthy.

### 2. STT
- Engine: SenseVoice Small via Sherpa-ONNX
- Mode: explicit one-shot microphone capture only
- Expected assets:
  - `model.int8.onnx`
  - `tokens.txt`
- Default Host path: `~/Library/Application Support/riverside-os/rosie/stt/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/`
- Approval status: Approved production default

### 3. TTS
- Engine: Kokoro-82M via Sherpa-ONNX
- Runtime expectation: local Host synthesis with direct process arguments, then workstation/browser playback through `/api/help/rosie/v1/voice/synthesize`
- Expected assets:
  - `model.onnx`
  - `voices.bin`
  - `tokens.txt`
  - `espeak-ng-data/`
- Default Host path: `~/Library/Application Support/riverside-os/rosie/tts/kokoro-multi-lang-v1_0/`
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
- The watchdog checks required binaries, Gemma GGUF, SenseVoice assets, Kokoro assets, and the LLM `/health` endpoint.
- If the LLM HTTP health check fails, the watchdog starts the LLM host task or recreates it through `start-riverside-llama.ps1`.
- `rosie_ready` is removed when the stack is not fully healthy.

### Insight summaries
- Shared ROSIE insight summaries use the OpenAI-compatible `llama-server` endpoint configured by `RIVERSIDE_LLAMA_UPSTREAM`.
- Gemma 4 E4B can spend the response budget in `reasoning_content` and return empty `message.content`; ROSIE insight summaries require usable `message.content`, and the UI shows a visible unavailable note when the summary cannot be produced.
- Start the local Gemma Host for insight work with reasoning disabled. ROS launchers enforce the selected CPU/GPU performance profile separately.

| `RIVERSIDE_LLAMA_PERF_PROFILE` | Intended host | Enforced llama.cpp launch posture |
|---|---|---|
| `auto` | Installer default | Windows auto-detects i9-12900 vs Ryzen 8840U; Apple Silicon defaults to `apple-m3-pro`; unknown hosts use `portable-cpu`. |
| `intel-i9-12900` | Main Hub i9-12900 | `--threads 8`, `--threads-batch 8`, strict `0xFFFF` P-core logical mask, `--gpu-layers 0`, `--device none`, `--flash-attn on`, `--mmap`, `--mlock`. |
| `minisforum-v3` | Minisforum V3 / Ryzen 7 8840U / 32GB | `--threads 8`, `--threads-batch 8`, strict `0xFFFF` CPU mask, `--gpu-layers 0`, `--device none`, `--flash-attn on`, `--mmap`, `--mlock`. |
| `apple-m3-pro` | MacBook Pro M3 Pro / 18GB | `--threads 6`, `--threads-batch 6`, `--gpu-layers 99` for Metal-capable test speed, `--flash-attn on`, `--mmap`. |
| `apple-m3-pro-cpu` | MacBook Pro M3 Pro CPU-parity testing | `--threads 6`, `--threads-batch 6`, `--gpu-layers 0`, `--device none`, `--flash-attn on`, `--mmap`. |
| `portable-cpu` | Unknown laptops/test hosts | Conservative CPU-only profile: 6 threads, GPU offload disabled, Flash Attention and mmap enabled. |

```bash
RIVERSIDE_LLAMA_EXTRA_ARGS="--reasoning off" npm run dev:server
```

- Confirm `GET /health` returns `200`.
- Confirm `GET /v1/models` reports `google_gemma-4-E4B-it-Q4_K_M.gguf`.
- Confirm `POST /api/help/rosie/v1/insight-summary` returns `status: "available"` with 1-3 bullets for a deterministic fact payload.
- If the model is healthy but the insight response is still `unavailable`, check for empty `message.content` caused by reasoning output.
- ROSIE request payloads also set `chat_template_kwargs.enable_thinking=false` and `reasoning=false` so direct API calls do not burn the response budget on hidden reasoning.
- Restart stale API processes after pulling a branch that changes ROSIE routes.

## Failure Behavior

### LLM
- If the Host local/direct runtime is available, Tauri should use it when `local_first` is enabled.
- If local/direct runtime is unavailable, Tauri blocks the request and surfaces ROSIE unavailable.
- PWA and server-governed calls use `RIVERSIDE_LLAMA_UPSTREAM`, which must point at the healthy Host runtime in production.

### STT
- If SenseVoice is unavailable, voice input is blocked and the stack is unhealthy.

### TTS
- If Kokoro is unavailable, voice output is blocked and the stack is unhealthy.

## Implemented Now
- Tauri direct/local `llama-server` path
- Server-governed ROSIE Host path
- SenseVoice Small STT wiring in the Tauri voice layer
- Kokoro-82M TTS wiring in the Tauri voice layer
- ROSIE Help Center voice controls and runtime status visibility
- `scripts/verify_rosie_local_stack.sh` local verification helper
- Provider abstraction for explicit local Gemma, Gemini API, or auto mode selection
- Capability registry for ROSIE self-awareness
- E2E API gateway for manual generation and workflow testing
- Streaming TTS support with `--stream` flag

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
