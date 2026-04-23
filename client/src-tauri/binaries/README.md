# llama-server sidecar (ROSIE Host LLM runtime)

Tauri bundles `llama-server` from this folder. Spawn/stop behavior lives in [`client/src-tauri/src/llama_server.rs`](../src/llama_server.rs).

The canonical ROSIE stack source of truth is [`docs/ROSIE_HOST_STACK.md`](../../../docs/ROSIE_HOST_STACK.md).
Use that file for approval status, fallback policy, and Host expectations.

## Approved production stack

The approved production Host stack is:

- LLM runtime: `llama.cpp` `llama-server`
- LLM model: Gemma 4 E4B
- STT: SenseVoice Small via Sherpa-ONNX
- TTS: Kokoro-82M via Sherpa-ONNX

Fallback-only paths remain supported where the Host stack file says they are allowed, but they are not the primary story.

## Pinned local asset expectations

- `RIVERSIDE_LLAMA_MODEL_PATH`
  - default: `~/Library/Application Support/riverside-os/rosie/models/gemma-4-e4b/google_gemma-4-E4B-it-Q4_K_M.gguf`
- `RIVERSIDE_SENSEVOICE_MODEL_DIR`
  - default: `~/Library/Application Support/riverside-os/rosie/stt/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`
- `RIVERSIDE_KOKORO_MODEL_DIR`
  - default: `~/Library/Application Support/riverside-os/rosie/tts/kokoro-multi-lang-v1_0`
- `RIVERSIDE_ROSIE_SPEECH_PYTHON_PATH`
  - default on the current workstation flow: `~/.local/share/uv/tools/sherpa-onnx/bin/python`

## Bundling the sidecar on Apple Silicon

On Apple Silicon development machines, this repo can bundle the already-installed Homebrew `llama-server` binary:

```bash
brew install llama.cpp
cp /opt/homebrew/bin/llama-server client/src-tauri/binaries/llama-server-aarch64-apple-darwin
chmod +x client/src-tauri/binaries/llama-server-aarch64-apple-darwin
```

The desktop shell treats that sidecar as the local-first direct runtime path.

## Runtime env

| Variable | Default | Purpose |
|----------|---------|---------|
| `RIVERSIDE_LLAMA_MODEL_PATH` | Gemma path above | Approved primary GGUF for the Host LLM runtime. |
| `RIVERSIDE_LLAMA_HOST` | `127.0.0.1` | Loopback HTTP bind for the OpenAI-compatible runtime. |
| `RIVERSIDE_LLAMA_PORT` | `8080` | Loopback port for the local Host runtime. |
| `RIVERSIDE_LLAMA_EXTRA_ARGS` | unset | Optional extra `llama-server` arguments for Host tuning. |
| `RIVERSIDE_ROSIE_SPEECH_PYTHON_PATH` | `~/.local/share/uv/tools/sherpa-onnx/bin/python` | Python runtime used by the SenseVoice and Kokoro helper scripts. |
| `RIVERSIDE_SENSEVOICE_MODEL_DIR` | SenseVoice path above | Approved primary STT model directory. |
| `RIVERSIDE_KOKORO_MODEL_DIR` | Kokoro path above | Approved primary TTS model directory. |
| `RIVERSIDE_SHERPA_PROVIDER` | `cpu` | Sherpa provider; Host deployments may use OpenVINO where applicable. |
| `RIVERSIDE_WHISPER_CLI_PATH` / `RIVERSIDE_WHISPER_MODEL_PATH` | unset | Fallback-only STT path. |
| `RIVERSIDE_TTS_FALLBACK_COMMAND_PATH` | `/usr/bin/say` | Fallback-only host TTS path. |

## Verification

Run the end-to-end local verifier:

```bash
./scripts/verify_rosie_local_stack.sh
```

That script checks:
- Gemma runtime load + response
- Kokoro speech synthesis
- SenseVoice transcription
- governed Ask ROSIE flow from transcript to answer
- Kokoro interruption behavior

## OpenVINO note

OpenVINO is the preferred Host optimization path where applicable.
Do not assume AVX512.
On macOS workstation verification, `cpu` providers may still be the active local runtime path.
