#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tag="${1:-v0.50.0-pilot-rc}"
timestamp="$(date +%Y%m%d_%H%M%S)"
package_root="${RIVERSIDE_ENV_PACKAGE_ROOT:-$HOME/riverside-os-secure-deployment-bundles}"
safe_tag="${tag//[^A-Za-z0-9._-]/-}"
bundle_dir="$package_root/ros-${safe_tag}-${timestamp}"
manifest="$bundle_dir/MANIFEST.tsv"
env_key_report="$bundle_dir/ENV_KEYS.txt"

copy_if_exists() {
  local source="$1"
  local destination="$2"

  if [[ -f "$repo_root/$source" ]]; then
    mkdir -p "$(dirname "$bundle_dir/repo/$destination")"
    cp -p "$repo_root/$source" "$bundle_dir/repo/$destination"
  fi
}

record_file() {
  local file="$1"
  local relative="${file#"$bundle_dir"/}"
  local bytes checksum mode

  bytes="$(wc -c < "$file" | tr -d ' ')"
  checksum="$(shasum -a 256 "$file" | awk '{print $1}')"
  mode="$(stat -f '%OLp' "$file" 2>/dev/null || stat -c '%a' "$file")"
  printf '%s\t%s\t%s\t%s\n' "$relative" "$bytes" "$checksum" "$mode" >> "$manifest"
}

record_env_keys() {
  local file="$1"
  local relative="${file#"$bundle_dir/repo/"}"

  {
    printf '[%s]\n' "$relative"
    awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/ { print $1"=<redacted>" }' "$file"
    printf '\n'
  } >> "$env_key_report"
}

mkdir -p "$bundle_dir/repo" "$bundle_dir/scripts"
chmod 700 "$package_root" "$bundle_dir"

copy_if_exists "server/.env" "server/.env"
copy_if_exists "client/.env" "client/.env"
copy_if_exists "client/.env.development" "client/.env.development"
copy_if_exists "client/.env.pwa" "client/.env.pwa"
copy_if_exists "client/.env.pwa.local" "client/.env.pwa.local"
copy_if_exists "client/.env.register" "client/.env.register"
copy_if_exists "client/.env.register.local" "client/.env.register.local"
copy_if_exists ".env" ".env"
copy_if_exists ".env.local" ".env.local"
copy_if_exists "counterpoint-bridge/.env" "counterpoint-bridge/.env"
copy_if_exists "tools/counterpoint-bridge/.env" "tools/counterpoint-bridge/.env"
copy_if_exists "deployment/windows/riverside-deployment.config.json" "deployment/windows/riverside-deployment.config.json"
copy_if_exists "deployment/windows/deployment-package.manifest.json" "deployment/windows/deployment-package.manifest.json"

latest_backup=""
backup_source_dir="$repo_root/server/backups"
if [[ -f "$repo_root/server/.env" ]]; then
  configured_backup_dir="$(awk -F= '$1 == "RIVERSIDE_BACKUP_DIR" { print $2 }' "$repo_root/server/.env" 2>/dev/null | tail -n 1 | sed -e 's/^"//' -e 's/"$//')"
  if [[ -n "$configured_backup_dir" ]]; then
    if [[ "$configured_backup_dir" = /* ]]; then
      backup_source_dir="$configured_backup_dir"
    else
      backup_source_dir="$repo_root/$configured_backup_dir"
    fi
  fi
fi
if compgen -G "$backup_source_dir/*.dump" > /dev/null; then
  latest_backup="$(ls -t "$backup_source_dir"/*.dump | head -n 1)"
  mkdir -p "$bundle_dir/repo/server/backups"
  cp -p "$latest_backup" "$bundle_dir/repo/server/backups/$(basename "$latest_backup")"
fi

cp -p "$repo_root/scripts/restore-rc-environment.sh" "$bundle_dir/scripts/restore-rc-environment.sh"
cp -p "$repo_root/scripts/rc-deployment-bootstrap.sh" "$bundle_dir/scripts/rc-deployment-bootstrap.sh"
chmod 700 "$bundle_dir/scripts/"*.sh

printf 'path\tbytes\tsha256\tmode\n' > "$manifest"
: > "$env_key_report"
while IFS= read -r -d '' file; do
  chmod 600 "$file"
  record_file "$file"
  case "$file" in
    *.env|*.env.*|*/.env|*/.env.*) record_env_keys "$file" ;;
  esac
done < <(find "$bundle_dir/repo" -type f -print0)

while IFS= read -r -d '' file; do
  record_file "$file"
done < <(find "$bundle_dir/scripts" -type f -print0)

cat > "$bundle_dir/RESTORE.md" <<EOF_RESTORE
# Riverside OS RC Environment Restore

Created: $timestamp
Candidate label: $tag
Source repo: $repo_root
Latest database dump copied: ${latest_backup:-none}

Restore environment files:

\`\`\`bash
$bundle_dir/scripts/restore-rc-environment.sh "$bundle_dir" --repo-root "$repo_root"
\`\`\`

Verify only:

\`\`\`bash
$bundle_dir/scripts/restore-rc-environment.sh "$bundle_dir" --repo-root "$repo_root" --verify-only
\`\`\`

Pilot bootstrap check:

\`\`\`bash
$bundle_dir/scripts/rc-deployment-bootstrap.sh "$bundle_dir" --repo-root "$repo_root"
\`\`\`

Database dump restore is intentionally not automatic. The copied dump is under
\`repo/server/backups/\` in this bundle and should be restored only after an
operator confirms the target database and rollback point.
EOF_RESTORE

chmod 600 "$manifest" "$env_key_report" "$bundle_dir/RESTORE.md"
record_file "$bundle_dir/RESTORE.md"
record_file "$manifest"
record_file "$env_key_report"

tarball="$bundle_dir.tar.gz"
tar -czf "$tarball" -C "$package_root" "$(basename "$bundle_dir")"
chmod 600 "$tarball"

printf 'bundle_dir=%s\n' "$bundle_dir"
printf 'bundle_archive=%s\n' "$tarball"
printf 'manifest=%s\n' "$manifest"
printf 'env_key_report=%s\n' "$env_key_report"
