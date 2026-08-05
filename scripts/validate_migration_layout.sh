#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

active=()
while IFS= read -r file; do
  active+=("$file")
done < <(find "$ROOT/migrations" -maxdepth 1 -type f -name '[0-9][0-9]*_*.sql' -exec basename {} \; | sort -V)

if [ "${#active[@]}" -eq 0 ]; then
  echo "No active migration files found." >&2
  exit 1
fi

legacy_root_files="$(
  find "$ROOT/migrations" -maxdepth 1 -type f -name '*.sql' \
    ! -name '[0-9][0-9][0-9]_*' \
    -exec basename {} \; \
    | sort
)"
if [ -n "$legacy_root_files" ]; then
  echo "Legacy or non-baseline SQL files found in active migrations folder:" >&2
  printf '%s\n' "$legacy_root_files" >&2
  exit 1
fi

previous_number=0
for file in "${active[@]}"; do
  if [[ ! "$file" =~ ^[0-9]{3}_[a-z0-9_]+\.sql$ ]]; then
    echo "Migration filename must match NNN_lower_snake_case.sql: $file" >&2
    exit 1
  fi

  prefix="${file%%_*}"
  number=$((10#$prefix))
  if [ "$number" -le "$previous_number" ]; then
    echo "Migration numeric prefixes must be unique and increasing: $file" >&2
    exit 1
  fi
  previous_number="$number"
done

# 059 was intentionally retired before the active schema-contract baseline.
for ((number = 1; number <= previous_number; number++)); do
  prefix="$(printf '%03d' "$number")"
  if [ "$prefix" = "059" ]; then
    continue
  fi
  if ! printf '%s\n' "${active[@]}" | grep -q "^${prefix}_"; then
    echo "Unexpected gap in active migration numbering: $prefix" >&2
    exit 1
  fi
done

embedded=()
while IFS= read -r file; do
  embedded+=("$file")
done < <(sed -n 's/^[[:space:]]*("\([^"]*\.sql\)".*/\1/p' server/src/embedded_migrations.rs)

if [ "${active[*]}" != "${embedded[*]}" ]; then
  echo "Active migrations and server/src/embedded_migrations.rs differ." >&2
  echo "Run a server Cargo build/check to regenerate the embedded migration list." >&2
  diff -u \
    <(printf '%s\n' "${active[@]}") \
    <(printf '%s\n' "${embedded[@]}") >&2 || true
  exit 1
fi

seed_hits="$(mktemp)"
trap 'rm -f "$seed_hits"' EXIT
if rg -n "INSERT INTO (public\\.)?(staff\\b|staff_permission|store_settings|products|product_variants|meilisearch_sync_status)" migrations/ \
  --max-depth 1 \
  --glob '*.sql' \
  --glob '!*042_seed_admin_account.sql' \
  --glob '!*049_constant_contact_permissions.sql' \
  --glob '!*089_restore_custom_order_catalog_skus.sql' \
  --glob '!*097_manager_approval_permission.sql' \
  --glob '!*113_system_staff_admin_salesperson.sql' \
  --glob '!*123_staff_accounts.sql' \
  >"$seed_hits"; then
  echo "Seed-like data is not allowed in active schema migrations:" >&2
  cat "$seed_hits" >&2
  exit 1
fi

echo "Migration layout OK: ${#active[@]} active files through $(printf '%03d' "$previous_number")."
