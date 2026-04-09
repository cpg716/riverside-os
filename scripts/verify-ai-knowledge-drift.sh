#!/usr/bin/env bash
# Wrapper: verify staff corpus manifest vs docs/staff/*.md
# See scripts/verify_ai_knowledge_drift.py

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec python3 "$ROOT/scripts/verify_ai_knowledge_drift.py" "$@"
