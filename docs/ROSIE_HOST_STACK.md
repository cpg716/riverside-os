# ROSIE Host Stack

## Purpose
This file is the canonical source of truth for the approved ROSIE Host runtime stack.

It defines:
- the Host deployment model
- the approved production LLM / STT / TTS stack
- the fallback story
- what is implemented now vs what is still a constrained fallback

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
- **Response**: Daily tokens, monthly tokens, estimated monthly cost
- **Cost Rate**: Placeholder $0.50 per 1M tokens (configurable for per-provider rates)

### UI Component
- **Location**: `RosieSettingsPanel.tsx` → `RosieTokenMonitor` component
- **Display**: Daily token use, actual monthly usage, estimated monthly cost
- **Access**: Visible to staff with `help.manage` permission

### Operational Notes
- Telemetry is recorded for all ROSIE interactions regardless of provider (local or cloud)
- Cost estimates use placeholder rates and should be configured with actual provider rates before production cloud deployment
- Data supports comparison between local Gemma costs vs cloud API pricing models

## Approval Status Labels
- Approved production default: explicitly approved as the intended production stack baseline.
- Approved fallback/dev fallback: allowed when the production-default component is unavailable, or for constrained development/bootstrap use.
- Temporary implementation: implemented now but not an approved long-term product decision.

## Approved Production Stack

### 1. LLM
- Runtime: Host-based `llama.cpp` `llama-server`
- Model family: Gemma 4 E4B
- Expected file: `google_gemma-4-E4B-it-Q4_K_M.gguf`
- Default Host path: `~/Library/Application Support/riverside-os/rosie/models/gemma-4-e4b/google_gemma-4-E4B-it-Q4_K_M.gguf`
- Desktop path: Tauri direct/local via `rosie_llama_*`
- Server fallback path: `POST /api/help/rosie/v1/chat/completions`
- Approval status: Approved production default

### 1.5. Optional Cloud Provider (Gemini API)
- Runtime: Google Gemini API (cloud-based)
- Model family: Gemini 2.5 Pro
- Configuration: `GEMINI_API_KEY` environment variable
- Provider selection: `ROSIE_PROVIDER_MODE` (local-gemma, gemini-api, auto)
- Privacy mode: `ROSIE_FORCE_LOCAL_FOR_SENSITIVE` (default: true)
- Approval status: Optional cloud provider for performance/multimodal capabilities
- Use case: Faster inference, multimodal understanding, streaming responses
- Fallback: Automatically falls back to local Gemma if unavailable or for sensitive queries

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
- Runtime expectation: local Host playback after ROSIE text is rendered
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

## Approved Fallbacks

### LLM fallback
- Runtime: `RIVERSIDE_LLAMA_UPSTREAM` Axum fallback
- Allowed when the local/direct Host runtime is unavailable
- Must still use the same governed ROSIE tool path
- Approval status: Approved fallback/dev fallback

### Insight summaries
- Shared ROSIE insight summaries use the OpenAI-compatible `llama-server` endpoint configured by `RIVERSIDE_LLAMA_UPSTREAM`.
- Gemma 4 E4B can spend the response budget in `reasoning_content` and return empty `message.content`; ROSIE insight summaries require usable `message.content`, and the UI shows a visible unavailable note when the summary cannot be produced.
- Start the local Gemma Host for insight work with reasoning disabled:

```bash
RIVERSIDE_LLAMA_EXTRA_ARGS="--reasoning off" npm run dev:server
```

- Confirm `GET /health` returns `200`.
- Confirm `GET /v1/models` reports `google_gemma-4-E4B-it-Q4_K_M.gguf`.
- Confirm `POST /api/help/rosie/v1/insight-summary` returns `status: "available"` with 1-3 bullets for a deterministic fact payload.
- If the model is healthy but the insight response is still `unavailable`, check for empty `message.content` caused by reasoning output.
- ROSIE request payloads also set `chat_template_kwargs.enable_thinking=false` and `reasoning=false` so direct API calls do not burn the response budget on hidden reasoning.
- Restart stale API processes after pulling a branch that changes ROSIE routes.

### STT fallback
- Engine: `whisper.cpp` `whisper-cli`
- Expected fallback model: `ggml-small.en.bin`
- Approval status: Approved fallback/dev fallback

### TTS fallback
- Engine: host speech command
- Current macOS fallback: `/usr/bin/say`
- Approval status: Approved fallback/dev fallback

## Fallback Behavior

### LLM
- If the Host local/direct runtime is available, Tauri should prefer it when `local_first` is enabled.
- If local/direct runtime is unavailable, Tauri and PWA use the Axum fallback route.
- If neither local/direct nor configured upstream is available, ROSIE chat is explicitly unavailable.

### STT
- If SenseVoice is unavailable, the explicit voice-input control should fall back to `whisper-cli` when configured.
- If neither SenseVoice nor fallback STT is available, ROSIE remains text-only.

### TTS
- If Kokoro is unavailable, local playback may fall back to the host speech command when configured.
- If neither Kokoro nor fallback TTS is available, ROSIE remains text-only and visible text stays primary.

## Implemented Now
- Tauri direct/local `llama-server` path
- Axum ROSIE fallback path
- SenseVoice Small STT wiring in the Tauri voice layer
- Kokoro-82M TTS wiring in the Tauri voice layer
- ROSIE Help Center voice controls and runtime status visibility
- `scripts/verify_rosie_local_stack.sh` local verification helper
- Provider abstraction for switching between local Gemma and Gemini API
- Capability registry for ROSIE self-awareness
- E2E API gateway for manual generation and workflow testing
- Streaming TTS support with `--stream` flag

## Verified Now
- Gemma 4 E4B local Host runtime can load through the existing ROSIE runtime path.
- SenseVoice can transcribe local speech into the normal Ask ROSIE text path.
- Kokoro can speak ROSIE text responses after the governed ROSIE flow completes.

## Still a Constrained Fallback, Not the Primary Story
- `whisper.cpp` + `ggml-small.en.bin`
- macOS `/usr/bin/say`
- any older tiny bootstrap model such as Qwen 0.5B

These may remain in the codebase as explicit fallback-only paths, but they are not the approved primary stack.

## Runtime Expectations

### Host expectations
- The Host must provide the approved production assets or explicit env overrides for them.
- The Host is responsible for running the local ROSIE stack or an explicitly configured upstream fallback.
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
