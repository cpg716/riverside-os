#!/usr/bin/env bash
# Download the pinned official Gemma 4 E4B-it QAT Q4_0 GGUF (see tools/ros-gemma/MODEL_PIN.json).
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
read -r MMPROJ_FILENAME MMPROJ_SHA MMPROJ_SIZE < <(python3 - "$PIN" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    d = json.load(f)
print(d["mmproj_filename"], d["mmproj_sha256"], d["mmproj_size_bytes"])
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
  GOT=$(openssl dgst -sha256 -r "$DEST" | awk '{print $1}')
  if [[ "$GOT" == "$EXPECT_SHA" ]]; then
    echo "OK — already downloaded and matches pin."
    MODEL_READY=1
  else
    echo "Existing file hash mismatch (got $GOT). Re-downloading..." >&2
    rm -f "$DEST"
  fi
fi

if [[ "${MODEL_READY:-0}" != "1" ]]; then
  echo "Downloading (resume supported)..."
  if [[ -n "${HF_TOKEN:-}" ]]; then
    curl -fL --progress-bar --continue-at - -H "Authorization: Bearer ${HF_TOKEN}" -o "$DEST" "$URL"
  else
    curl -fL --progress-bar --continue-at - -o "$DEST" "$URL"
  fi

  echo "Verifying SHA256..."
  GOT=$(openssl dgst -sha256 -r "$DEST" | awk '{print $1}')

  if [[ "$GOT" != "$EXPECT_SHA" ]]; then
    echo "SHA256 mismatch: expected $EXPECT_SHA got $GOT" >&2
    rm -f "$DEST"
    exit 1
  fi
fi

echo "OK — $DEST matches MODEL_PIN.json"

MMPROJ_DEST="$OUT_DIR/$MMPROJ_FILENAME"
MMPROJ_URL="https://huggingface.co/${MODEL_ID}/resolve/${REV}/${MMPROJ_FILENAME}"
if [[ ! -f "$MMPROJ_DEST" ]] || [[ "$(openssl dgst -sha256 -r "$MMPROJ_DEST" | awk '{print $1}')" != "$MMPROJ_SHA" ]]; then
  echo "Downloading matching multimodal projector ($MMPROJ_SIZE bytes)..."
  if [[ -n "${HF_TOKEN:-}" ]]; then
    curl -fL --progress-bar -H "Authorization: Bearer ${HF_TOKEN}" -o "$MMPROJ_DEST" "$MMPROJ_URL"
  else
    curl -fL --progress-bar -o "$MMPROJ_DEST" "$MMPROJ_URL"
  fi
fi
MMPROJ_GOT=$(openssl dgst -sha256 -r "$MMPROJ_DEST" | awk '{print $1}')
if [[ "$MMPROJ_GOT" != "$MMPROJ_SHA" ]]; then
  echo "Multimodal projector SHA256 mismatch: expected $MMPROJ_SHA got $MMPROJ_GOT" >&2
  rm -f "$MMPROJ_DEST"
  exit 1
fi
echo "OK — $MMPROJ_DEST matches MODEL_PIN.json"
echo "Start llama-server with: -m \"$DEST\" --mmproj \"$MMPROJ_DEST\" --threads 8 --threads-batch 8 --cpu-mask 0xFFFF --cpu-mask-batch 0xFFFF --cpu-strict 1 --cpu-strict-batch 1 --gpu-layers 0 --device none --flash-attn on --mmap --mlock"
