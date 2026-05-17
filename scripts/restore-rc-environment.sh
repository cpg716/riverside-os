#!/usr/bin/env bash
set -euo pipefail

repo_root="$(pwd)"
bundle_dir=""
verify_only=0

usage() {
  cat <<'EOF_USAGE'
Usage: scripts/restore-rc-environment.sh <bundle-dir> [--repo-root <path>] [--verify-only]

Copies the allowlisted Riverside OS runtime environment files from an RC bundle
back into a checkout, preserving the existing target files with a timestamped
.pre-restore backup first. This script does not restore a database automatically.
EOF_USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)
      repo_root="$2"
      shift 2
      ;;
    --verify-only)
      verify_only=1
      shift
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
bundle_dir="$(cd "$bundle_dir" && pwd)"
bundle_repo="$bundle_dir/repo"
stamp="$(date +%Y%m%d_%H%M%S)"

allowlist=(
  ".env"
  ".env.local"
  "server/.env"
  "client/.env"
  "client/.env.development"
  "client/.env.pwa"
  "client/.env.pwa.local"
  "client/.env.register"
  "client/.env.register.local"
  "counterpoint-bridge/.env"
  "tools/counterpoint-bridge/.env"
  "deployment/windows/riverside-deployment.config.json"
  "deployment/windows/deployment-package.manifest.json"
)

require_env_keys() {
  local file="$1"
  shift

  if [[ ! -f "$file" ]]; then
    echo "Missing required env file: ${file#"$repo_root"/}" >&2
    return 1
  fi

  local missing=0
  local key
  for key in "$@"; do
    if ! awk -F= -v key="$key" '$1 == key && $0 != key"=" { found = 1 } END { exit found ? 0 : 1 }' "$file"; then
      echo "Missing required key in ${file#"$repo_root"/}: $key" >&2
      missing=1
    fi
  done
  return "$missing"
}

require_env_key_names() {
  local file="$1"
  shift

  if [[ ! -f "$file" ]]; then
    echo "Missing required env file: ${file#"$repo_root"/}" >&2
    return 1
  fi

  local missing=0
  local key
  for key in "$@"; do
    if ! awk -F= -v key="$key" '$1 == key { found = 1 } END { exit found ? 0 : 1 }' "$file"; then
      echo "Missing required key in ${file#"$repo_root"/}: $key" >&2
      missing=1
    fi
  done
  return "$missing"
}

restore_file() {
  local relative="$1"
  local source="$bundle_repo/$relative"
  local target="$repo_root/$relative"

  [[ -f "$source" ]] || return 0

  if [[ "$verify_only" -eq 1 ]]; then
    echo "would_restore=$relative"
    return 0
  fi

  mkdir -p "$(dirname "$target")"
  if [[ -f "$target" ]]; then
    cp -p "$target" "$target.pre-restore-$stamp"
  fi
  cp -p "$source" "$target"
  case "$relative" in
    *.env|*.env.*|*/.env|*/.env.*|deployment/windows/riverside-deployment.config.json)
      chmod 600 "$target"
      ;;
  esac
  echo "restored=$relative"
}

if [[ ! -d "$bundle_repo" ]]; then
  echo "Bundle does not contain repo/: $bundle_dir" >&2
  exit 1
fi

for relative in "${allowlist[@]}"; do
  restore_file "$relative"
done

if [[ -d "$bundle_repo/server/backups" ]]; then
  mkdir -p "$repo_root/server/backups"
  while IFS= read -r -d '' dump; do
    relative="${dump#"$bundle_repo/"}"
    target="$repo_root/$relative"
    if [[ "$verify_only" -eq 1 ]]; then
      echo "would_restore=$relative"
    elif [[ ! -f "$target" ]]; then
      cp -p "$dump" "$target"
      chmod 600 "$target"
      echo "restored=$relative"
    else
      echo "kept_existing=$relative"
    fi
  done < <(find "$bundle_repo/server/backups" -maxdepth 1 -type f -name '*.dump' -print0)
fi

require_env_keys "$repo_root/server/.env" \
  DATABASE_URL \
  RIVERSIDE_CREDENTIALS_KEY \
  RIVERSIDE_STORE_CUSTOMER_JWT_SECRET \
  RIVERSIDE_MEILISEARCH_URL \
  RIVERSIDE_MEILISEARCH_API_KEY

if [[ -f "$repo_root/client/.env.development" ]]; then
  require_env_key_names "$repo_root/client/.env.development" VITE_API_BASE
fi

if [[ -f "$repo_root/counterpoint-bridge/.env" ]]; then
  require_env_keys "$repo_root/counterpoint-bridge/.env" \
    ROS_BASE_URL \
    COUNTERPOINT_SYNC_TOKEN \
    SQL_CONNECTION_STRING
fi

backup_dir="$(awk -F= '$1 == "RIVERSIDE_BACKUP_DIR" { print $2 }' "$repo_root/server/.env" 2>/dev/null | tail -n 1)"
if [[ -n "$backup_dir" && ! -d "$backup_dir" ]]; then
  echo "Configured RIVERSIDE_BACKUP_DIR does not exist: $backup_dir" >&2
  exit 1
fi

echo "environment_restore_ready=$bundle_dir"
