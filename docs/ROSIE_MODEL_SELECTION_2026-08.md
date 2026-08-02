# ROSIE Local Model Selection — August 2026

## Decision

ROSIE now pins Google's official `gemma-4-E4B-it-qat-q4_0-gguf` text model and
its matching multimodal projector. This replaces the community post-training
`Q4_K_M` quantization of the same Gemma 4 E4B instruction model.

The choice does not change the model family or require a larger text runtime.
It selects Google's quantization-aware-trained weights, which Google publishes
specifically for low-memory local inference and describes as retaining more
quality than ordinary post-training quantization. The exact repository revision,
byte lengths, and SHA-256 values are recorded in `tools/ros-gemma/MODEL_PIN.json`.

## Storage Comparison

| Asset | Exact bytes | Change from prior text model |
|---|---:|---:|
| Prior community E4B `Q4_K_M` text model | 5,405,168,384 | baseline |
| Official Google E4B QAT `Q4_0` text model | 5,154,941,280 | -250,227,104 (-4.6%) |
| Matching multimodal projector | 991,552,256 | optional vision asset |
| New text model plus projector | 6,146,493,536 | +741,325,152 (+13.7%) |

Text-only inference therefore uses a slightly smaller model file. Vision has a
real cost: the matching projector adds about 992 MB on disk, partly offset by
the smaller text model. Runtime memory varies by llama.cpp backend, context,
batch size, and whether the projector is loaded; it must be measured on the
Main Hub rather than inferred from file size.

## Evidence and Gate

Google's Gemma documentation lists the E4B Q4_0 configuration as a local-runtime
target and gives an environment-dependent memory estimate. Google's QAT release
notes explain that the official QAT models are intended to minimize the quality
loss normally caused by low-bit quantization and are published as llama.cpp-ready
GGUF files.

No trustworthy independent benchmark was found that compares these two exact
GGUF files under the Riverside prompt and llama.cpp configuration. The production
decision therefore combines the strongest available upstream evidence with a
Riverside-specific acceptance gate instead of treating a generic leaderboard as
proof. For development-only comparisons, run:

```bash
ROSIE_EVAL_BASE_URL=http://127.0.0.1:8080 node scripts/rosie-model-eval.mjs
```

The prior model baseline on the development host was 4/4 fixtures passed, 100%
pass rate, and 1,008 ms average latency. On August 2, 2026, the official QAT
model passed the same 4/4 fixtures at 100% with 680 ms average latency on the
Apple M3 Pro development Host, about 32.5% faster than the prior baseline. It
also passed direct and Riverside-proxied text, SSE, native-tool, and image-input
probes with its matching projector. This is development-host evidence, not a
substitute for the Windows Main Hub certificate.

A normal ROSIE Host installation now
downloads and verifies both pinned assets, configures the text model and
projector together, starts the candidate, and certifies text, SSE streaming,
native function selection, and image input before reporting the stack ready.
Failed certification restores the previous model configuration and fails the
installation visibly. Successful certification removes superseded model files
from the managed model directory so the upgrade does not permanently retain two
multi-gigabyte model sets. Operators do not manually switch the model path.

Latency and memory remain machine-dependent operational measurements. The
fixture evaluator is useful for comparisons, but the install-time functional
certificate is the activation gate for the complete Gemma runtime.

## Sources

- Google Gemma 4 model overview: <https://ai.google.dev/gemma/docs/core>
- Google QAT announcement: <https://blog.google/innovation-and-ai/technology/developers-tools/quantization-aware-training-gemma-4/>
- Official pinned QAT repository: <https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf/tree/4b4a2c1d584be7264f87aac328a1bc739ce81b6c>
- Prior community quantization repository: <https://huggingface.co/bartowski/google_gemma-4-E4B-it-GGUF>
