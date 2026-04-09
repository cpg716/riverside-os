#!/usr/bin/env bash
# Download the pinned Gemma 4 E2B-it Q4_K_M GGUF (see tools/ros-gemma/MODEL_PIN.json).
# Usage: from repo root — ./scripts/download-ros-ai-gguf.sh
# Env:
#   ROS_AI_GGUF_DIR  — output directory (default: tools/ros-gemma/models)
#   HF_TOKEN         — optional; set if Hugging Face requires auth for this repo
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIN="$ROOT/tools/ros-gemma/MODEL_PIN.json"
OUT_DIR="${ROS_AI_GGUF_DIR:-$ROOT/tools/ros-gemma/models}"

if [[ ! -f "$PIN" ]]; then
  echo "Missing pin file: $PIN" >&2
  exit 1
fi

read -r MODEL_ID REV FILENAME EXPECT_SHA SIZE_BYTES < <(python3 - "$PIN" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    d = json.load(f)
print(d["huggingface_model_id"], d["revision"], d["filename"], d["sha256"], d["size_bytes"])
PY
)

mkdir -p "$OUT_DIR"
DEST="$OUT_DIR/$FILENAME"
URL="https://huggingface.co/${MODEL_ID}/resolve/${REV}/${FILENAME}"

echo "Pin:     $PIN"
echo "URL:     $URL"
echo "Dest:    $DEST"
echo "SHA256:  $EXPECT_SHA"
echo "Size:    $SIZE_BYTES bytes (approx $(( SIZE_BYTES / 1024 / 1024 / 1024 )) GiB)"
echo ""

if [[ -f "$DEST" ]]; then
  echo "File exists; verifying SHA256..."
  GOT=$(openssl dgst -sha256 "$DEST" | awk '{print $2}')
  if [[ "$GOT" == "$EXPECT_SHA" ]]; then
    echo "OK — already downloaded and matches pin."
    exit 0
  fi
  echo "Existing file hash mismatch (got $GOT). Re-downloading..." >&2
  rm -f "$DEST"
fi

echo "Downloading (resume supported)..."
if [[ -n "${HF_TOKEN:-}" ]]; then
  curl -fL --progress-bar --continue-at - -H "Authorization: Bearer ${HF_TOKEN}" -o "$DEST" "$URL"
else
  curl -fL --progress-bar --continue-at - -o "$DEST" "$URL"
fi

echo "Verifying SHA256..."
GOT=$(openssl dgst -sha256 "$DEST" | awk '{print $2}')

if [[ "$GOT" != "$EXPECT_SHA" ]]; then
  echo "SHA256 mismatch: expected $EXPECT_SHA got $GOT" >&2
  rm -f "$DEST"
  exit 1
fi

echo "OK — $DEST matches MODEL_PIN.json"
echo "Start llama-server with:  -m \"$DEST\""
