#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WARN_SECONDS="${RIVERSIDE_MIGRATION_REPLAY_WARN_SECONDS:-300}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required for a fresh migration replay." >&2
  exit 1
fi

if [[ ! "$WARN_SECONDS" =~ ^[0-9]+$ ]] || [ "$WARN_SECONDS" -eq 0 ]; then
  echo "RIVERSIDE_MIGRATION_REPLAY_WARN_SECONDS must be a positive integer." >&2
  exit 1
fi

public_table_count="$(
  psql -w "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc \
    "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public';" \
    | tr -d '[:space:]'
)"
if [ "$public_table_count" != "0" ]; then
  echo "Fresh migration replay requires an empty public schema; found $public_table_count table(s)." >&2
  exit 1
fi

start_seconds="$(date +%s)"
"$ROOT/scripts/apply-migrations-psql.sh"
elapsed_seconds=$(( $(date +%s) - start_seconds ))
migration_count="$(find "$ROOT/migrations" -maxdepth 1 -type f -name '[0-9][0-9]*_*.sql' | wc -l | tr -d '[:space:]')"

summary="Fresh migration replay applied $migration_count files in ${elapsed_seconds}s (warning threshold: ${WARN_SECONDS}s)."
echo "$summary"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf -- '- %s\n' "$summary" >>"$GITHUB_STEP_SUMMARY"
fi

if [ "$elapsed_seconds" -gt "$WARN_SECONDS" ]; then
  echo "WARNING: Fresh migration replay exceeded ${WARN_SECONDS}s; review baseline performance and migration reliability." >&2
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "::warning title=Migration replay duration::$summary"
  fi
fi
