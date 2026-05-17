#!/usr/bin/env bash
set -euo pipefail

repo_root="$(pwd)"
bundle_dir=""

usage() {
  cat <<'EOF_USAGE'
Usage: scripts/rc-deployment-bootstrap.sh <bundle-dir> [--repo-root <path>]

Restores the RC environment bundle, validates required runtime keys, and runs
the existing Riverside environment security check when available.
EOF_USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)
      repo_root="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$bundle_dir" ]]; then
        bundle_dir="$1"
        shift
      else
        echo "Unexpected argument: $1" >&2
        usage >&2
        exit 2
      fi
      ;;
  esac
done

if [[ -z "$bundle_dir" ]]; then
  usage >&2
  exit 2
fi

repo_root="$(cd "$repo_root" && pwd)"
"$repo_root/scripts/restore-rc-environment.sh" "$bundle_dir" --repo-root "$repo_root"

if [[ -x "$repo_root/scripts/check-env-security.sh" ]]; then
  (cd "$repo_root" && "$repo_root/scripts/check-env-security.sh")
else
  echo "Skipping check-env-security.sh because it is not executable."
fi

git -C "$repo_root" status --short --branch
