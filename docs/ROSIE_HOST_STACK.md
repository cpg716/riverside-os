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
- `DEVELOPER.md`
- `client/src-tauri/src/llama_server.rs`
- `client/src-tauri/src/rosie_voice.rs`
- `client/src/lib/rosie.ts`
- `client/src-tauri/binaries/README.md`
- `client/.env.example`
- `server/.env.example`
- `scripts/verify_rosie_local_stack.sh`
