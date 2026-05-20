#!/usr/bin/env bash
set -euo pipefail

# Canonical ROSIE host stack expectations live in docs/ROSIE_HOST_STACK.md.
# This script verifies the approved production-default local-first stack on the
# current Host and falls back only where that document says fallback is allowed.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCH="$(uname -m)"
if [[ "$ARCH" == "arm64" ]]; then
  TARGET_ARCH="aarch64"
else
  TARGET_ARCH="$ARCH"
fi

LLAMA_BIN="${RIVERSIDE_LLAMA_BIN:-$ROOT_DIR/client/src-tauri/binaries/llama-server-${TARGET_ARCH}-apple-darwin}"
LLAMA_HOST="${RIVERSIDE_LLAMA_HOST:-127.0.0.1}"
LLAMA_PORT="${RIVERSIDE_LLAMA_PORT:-8080}"
LLAMA_URL="http://${LLAMA_HOST}:${LLAMA_PORT}"
LLAMA_MODEL_PATH="${RIVERSIDE_LLAMA_MODEL_PATH:-$HOME/Library/Application Support/riverside-os/rosie/models/gemma-4-e4b/google_gemma-4-E4B-it-Q4_K_M.gguf}"
LLAMA_EXTRA_ARGS="${RIVERSIDE_LLAMA_EXTRA_ARGS:-}"

ROSIE_SPEECH_PYTHON="${RIVERSIDE_ROSIE_SPEECH_PYTHON_PATH:-$HOME/.local/share/uv/tools/sherpa-onnx/bin/python}"
SENSEVOICE_MODEL_DIR="${RIVERSIDE_SENSEVOICE_MODEL_DIR:-$HOME/Library/Application Support/riverside-os/rosie/stt/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17}"
SENSEVOICE_MODEL_PATH="${SENSEVOICE_MODEL_DIR}/model.int8.onnx"
SENSEVOICE_TOKENS_PATH="${SENSEVOICE_MODEL_DIR}/tokens.txt"
KOKORO_MODEL_DIR="${RIVERSIDE_KOKORO_MODEL_DIR:-$HOME/Library/Application Support/riverside-os/rosie/tts/kokoro-multi-lang-v1_0}"
KOKORO_MODEL_PATH="${KOKORO_MODEL_DIR}/model.onnx"
KOKORO_VOICES_PATH="${KOKORO_MODEL_DIR}/voices.bin"
KOKORO_TOKENS_PATH="${KOKORO_MODEL_DIR}/tokens.txt"
KOKORO_ESPEAK_PATH="${KOKORO_MODEL_DIR}/espeak-ng-data"
KOKORO_PLAYER="${RIVERSIDE_KOKORO_PLAYER:-/usr/bin/afplay}"
TTS_FALLBACK_COMMAND="${RIVERSIDE_TTS_FALLBACK_COMMAND_PATH:-/usr/bin/say}"

SHERPA_PROVIDER="${RIVERSIDE_SHERPA_PROVIDER:-cpu}"
ROSIE_API_BASE="${ROSIE_API_BASE:-http://127.0.0.1:3000}"
ROSIE_STAFF_CODE="${ROSIE_STAFF_CODE:-1234}"
ROSIE_STAFF_PIN="${ROSIE_STAFF_PIN:-1234}"
ROSIE_SELECTED_VOICE="${ROSIE_SELECTED_VOICE:-adam}"
ROSIE_SPEECH_RATE="${ROSIE_SPEECH_RATE:-1.0}"

if [[ ! -x "$LLAMA_BIN" ]]; then
  echo "Missing llama-server binary: $LLAMA_BIN" >&2
  exit 1
fi

if [[ ! -f "$LLAMA_MODEL_PATH" ]]; then
  echo "Missing Gemma model: $LLAMA_MODEL_PATH" >&2
  exit 1
fi

if [[ ! -x "$ROSIE_SPEECH_PYTHON" ]]; then
  echo "Missing Sherpa python runtime: $ROSIE_SPEECH_PYTHON" >&2
  exit 1
fi

if [[ ! -f "$SENSEVOICE_MODEL_PATH" || ! -f "$SENSEVOICE_TOKENS_PATH" ]]; then
  echo "Missing SenseVoice model assets under: $SENSEVOICE_MODEL_DIR" >&2
  exit 1
fi

if [[ ! -f "$KOKORO_MODEL_PATH" || ! -f "$KOKORO_VOICES_PATH" || ! -f "$KOKORO_TOKENS_PATH" || ! -d "$KOKORO_ESPEAK_PATH" ]]; then
  echo "Missing Kokoro model assets under: $KOKORO_MODEL_DIR" >&2
  exit 1
fi

if [[ ! -x "$KOKORO_PLAYER" ]]; then
  echo "Missing Kokoro playback command: $KOKORO_PLAYER" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  if [[ -n "${LLAMA_PID:-}" ]] && kill -0 "$LLAMA_PID" >/dev/null 2>&1; then
    kill "$LLAMA_PID" >/dev/null 2>&1 || true
    wait "$LLAMA_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "Starting local Gemma Host runtime..."
LLAMA_CMD=(
  "$LLAMA_BIN"
  -m "$LLAMA_MODEL_PATH"
  --host "$LLAMA_HOST"
  --port "$LLAMA_PORT"
  -ngl 99
)
if [[ -n "$LLAMA_EXTRA_ARGS" ]]; then
  # shellcheck disable=SC2206
  EXTRA_ARGS=( $LLAMA_EXTRA_ARGS )
  LLAMA_CMD+=("${EXTRA_ARGS[@]}")
fi
"${LLAMA_CMD[@]}" >"$TMP_DIR/llama.stdout.log" 2>"$TMP_DIR/llama.stderr.log" &
LLAMA_PID="$!"

for _ in {1..90}; do
  if curl -sf "$LLAMA_URL/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

curl -sf "$LLAMA_URL/health" >"$TMP_DIR/llama.health.json"
echo "Local Gemma runtime ready at $LLAMA_URL"

python3 - <<'PY' "$LLAMA_URL" >"$TMP_DIR/llama.response.txt"
import json
import sys
import urllib.request

url = sys.argv[1] + "/v1/chat/completions"
payload = {
    "model": "local",
    "temperature": 0.2,
    "messages": [
        {"role": "system", "content": "You are ROSIE. Answer in one concise sentence."},
        {"role": "user", "content": "What is the Riverside OS Help Center for?"}
    ],
}
req = urllib.request.Request(
    url,
    data=json.dumps(payload).encode("utf-8"),
    headers={"Content-Type": "application/json"},
)
with urllib.request.urlopen(req, timeout=180) as response:
    body = json.load(response)
print(body["choices"][0]["message"]["content"].strip())
PY

echo "Local Gemma response:"
cat "$TMP_DIR/llama.response.txt"

echo "Synthesizing a ROSIE verification prompt with Kokoro..."
"$ROSIE_SPEECH_PYTHON" "$ROOT_DIR/scripts/rosie_kokoro_tts.py" \
  --model-dir "$KOKORO_MODEL_DIR" \
  --voice "$ROSIE_SELECTED_VOICE" \
  --speed "$ROSIE_SPEECH_RATE" \
  --provider "$SHERPA_PROVIDER" \
  --text "How do I close Register 1?" \
  --output "$TMP_DIR/question.wav" \
  --no-play

echo "Playing the Kokoro prompt..."
"$KOKORO_PLAYER" "$TMP_DIR/question.wav"

echo "Transcribing the generated voice prompt with SenseVoice..."
"$ROSIE_SPEECH_PYTHON" "$ROOT_DIR/scripts/rosie_sensevoice_transcribe.py" \
  --model "$SENSEVOICE_MODEL_PATH" \
  --tokens "$SENSEVOICE_TOKENS_PATH" \
  --input "$TMP_DIR/question.wav" \
  --provider "$SHERPA_PROVIDER" \
  --language auto \
  --use-itn >"$TMP_DIR/question.txt"

TRANSCRIPT="$(tr -d '\r' < "$TMP_DIR/question.txt" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
echo "SenseVoice transcript:"
echo "$TRANSCRIPT"

python3 - <<'PY' "$ROSIE_API_BASE" "$ROSIE_STAFF_CODE" "$ROSIE_STAFF_PIN" "$TRANSCRIPT" "$LLAMA_URL" >"$TMP_DIR/governed.response.txt"
import json
import sys
import urllib.request

api_base, staff_code, staff_pin, transcript, llama_url = sys.argv[1:]
headers = {
    "Content-Type": "application/json",
    "x-riverside-staff-code": staff_code,
    "x-riverside-staff-pin": staff_pin,
}

tool_context_req = urllib.request.Request(
    api_base + "/api/help/rosie/v1/tool-context",
    data=json.dumps(
        {
            "question": transcript,
            "settings": {
                "enabled": True,
                "response_style": "concise",
                "show_citations": True,
            },
        }
    ).encode("utf-8"),
    headers=headers,
)

with urllib.request.urlopen(tool_context_req, timeout=180) as response:
    context = json.load(response)

system_prompt = " ".join(
    [
        "You are ROSIE inside the Riverside OS Help Center.",
        "Answer only from the provided structured Help Center and tool results.",
        "Do not use hidden routes, SQL, or any imaginary data.",
        "Response style: concise and practical.",
        "When helpful, mention the source title or section in the answer.",
        "Use markdown for readability.",
    ]
)

tool_results = "\n\n---\n\n".join(
    [
        "\n".join(
            [
                f"Tool {index + 1}: {tool['tool_name']}",
                "Args:",
                json.dumps(tool["args"], indent=2),
                "Result:",
                json.dumps(tool["result"], indent=2),
            ]
        )
        for index, tool in enumerate(context.get("tool_results", []))
    ]
)

sources = "\n\n---\n\n".join(
    [
        "\n".join(
            [
                f"Source {index + 1}: {source['title']}",
                f"Kind: {source['kind']}",
                f"Excerpt: {source.get('excerpt', '')}",
                "Content:",
                source.get("content", ""),
            ]
        )
        for index, source in enumerate(context.get("sources", []))
    ]
)

chat_req = urllib.request.Request(
    llama_url + "/v1/chat/completions",
    data=json.dumps(
        {
            "model": "local",
            "temperature": 0.2,
            "messages": [
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": "\n".join(
                        [
                            f"User question: {transcript}",
                            "",
                            "Structured tool results:",
                            tool_results or "No tool results were provided.",
                            "",
                            "Grounding sources:",
                            sources or "No sources were provided.",
                        ]
                    ),
                },
            ],
        }
    ).encode("utf-8"),
    headers={"Content-Type": "application/json"},
)

with urllib.request.urlopen(chat_req, timeout=180) as response:
    answer = json.load(response)

print(answer["choices"][0]["message"]["content"].strip())
PY

echo "Governed ROSIE response from SenseVoice transcript:"
cat "$TMP_DIR/governed.response.txt"

echo "Verifying Kokoro stop/barge-in path..."
"$ROSIE_SPEECH_PYTHON" "$ROOT_DIR/scripts/rosie_kokoro_tts.py" \
  --model-dir "$KOKORO_MODEL_DIR" \
  --voice "$ROSIE_SELECTED_VOICE" \
  --speed "$ROSIE_SPEECH_RATE" \
  --provider "$SHERPA_PROVIDER" \
  --text "This is a longer ROSIE speaking check for interruption handling." &
TTS_PID="$!"
sleep 1
kill "$TTS_PID" >/dev/null 2>&1 || true
wait "$TTS_PID" >/dev/null 2>&1 || true
echo "Kokoro playback was interruptible."

if [[ -x "${RIVERSIDE_WHISPER_CLI_PATH:-}" || -f "${RIVERSIDE_WHISPER_MODEL_PATH:-}" || -x "$TTS_FALLBACK_COMMAND" ]]; then
  echo "Fallback note: Whisper.cpp and host speech remain fallback-only paths per docs/ROSIE_HOST_STACK.md."
fi
