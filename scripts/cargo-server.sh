#!/usr/bin/env bash
# Run cargo in server/ with Rust 1.91 on PATH (required for ort/fastembed).
# Homebrew rustc/cargo 1.86 often precedes ~/.cargo/bin and ignores rust-toolchain.toml.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUSTC_191="$(rustup which rustc --toolchain 1.91 2>/dev/null || true)"
if [[ -z "$RUSTC_191" ]]; then
  echo "cargo-server.sh: toolchain 1.91 not installed. Run: rustup toolchain install 1.91" >&2
  exit 1
fi
export PATH="$(dirname "$RUSTC_191"):$PATH"
cd "$ROOT/server"
exec cargo "$@"
