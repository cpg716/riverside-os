#!/usr/bin/env bash
set -euo pipefail

# Lightweight wrapper to run the QA gating script for UI Overhaul
NODE_CMD=$(command -v node || command -v nodejs)
if [ -z "$NODE_CMD" ]; then
  echo "Node.js is not available in PATH" >&2
  exit 1
fi

if [ -f ./qa-ui-overhaul.js ]; then
  echo "Running QA gating script..."
  node ./qa-ui-overhaul.js
else
  echo "QA gating script qa-ui-overhaul.js not found" >&2
  exit 1
fi
