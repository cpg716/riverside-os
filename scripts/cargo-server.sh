#!/usr/bin/env bash
# Run cargo in server/ with Rust 1.88 on PATH (required for ort/fastembed).
# Homebrew rustc/cargo 1.86 often precedes ~/.cargo/bin and ignores rust-toolchain.toml.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUSTC_188="$(rustup which rustc --toolchain 1.88 2>/dev/null || true)"
if [[ -z "$RUSTC_188" ]]; then
  echo "cargo-server.sh: toolchain 1.88 not installed. Run: rustup toolchain install 1.88" >&2
  exit 1
fi
export PATH="$(dirname "$RUSTC_188"):$PATH"
cd "$ROOT/server"
exec cargo "$@"
