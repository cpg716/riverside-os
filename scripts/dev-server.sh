#!/usr/bin/env bash
# Ensure rustc 1.88 is used (ort/fastembed). Homebrew rustc 1.86 on PATH breaks the build even when
# server/rust-toolchain.toml requests 1.88 — build scripts invoke `rustc` from PATH.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUSTC_188="$(rustup which rustc --toolchain 1.88 2>/dev/null || true)"
if [[ -z "$RUSTC_188" ]]; then
  echo "dev-server.sh: no toolchain 1.88. Install: rustup toolchain install 1.88" >&2
  exit 1
fi
export PATH="$(dirname "$RUSTC_188"):$PATH"
cd "$ROOT/server"
exec cargo run "$@"
