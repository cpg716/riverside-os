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

invalid_uuid_casts=""
canonical_uuid_cast_regex="'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'::uuid$"
superseded_202_uuid_cast_regex="/202_repair_verified_rms90_programs[.]sql:[0-9]+:'ff05f632-f43c-4856-813c-c0d41cd1eb4'::uuid$"
while IFS= read -r uuid_cast; do
  if [[ "$uuid_cast" =~ $superseded_202_uuid_cast_regex ]]; then
    continue
  fi
  if [[ ! "$uuid_cast" =~ $canonical_uuid_cast_regex ]]; then
    invalid_uuid_casts+="${uuid_cast}"$'\n'
  fi
done < <(rg -n -o "'[0-9A-Fa-f-]+'::uuid" "$ROOT/migrations" --max-depth 1 --glob '*.sql' || true)

if [ -n "$invalid_uuid_casts" ]; then
  echo "Malformed UUID literals cast to uuid were found in active migrations:" >&2
  printf '%s' "$invalid_uuid_casts" >&2
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
