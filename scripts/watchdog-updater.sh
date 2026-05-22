#!/usr/bin/env bash
# Watchdog Updater with Automatic Rollback for Riverside OS.
#
# Usage: ./scripts/watchdog-updater.sh <new_binary> <current_binary> <pre_update_db_backup>
#
# Requirements: DATABASE_URL env var or defined in server/.env, pg_dump, pg_restore, and curl on PATH.

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <new_binary> <current_binary> <pre_update_db_backup>" >&2
  exit 1
fi

NEW_BINARY="$1"
CURRENT_BINARY="$2"
DB_BACKUP_FILE="$3"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Resolve DATABASE_URL from environment or local .env file
if [ -z "${DATABASE_URL:-}" ]; then
  if [ -f "server/.env" ]; then
    # Parse DATABASE_URL from server/.env safely
    DATABASE_URL=$(grep -E "^DATABASE_URL=" server/.env | cut -d'=' -f2- | tr -d '"' | tr -d "'")
    export DATABASE_URL
  elif [ -f ".env" ]; then
    DATABASE_URL=$(grep -E "^DATABASE_URL=" .env | cut -d'=' -f2- | tr -d '"' | tr -d "'")
    export DATABASE_URL
  fi
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "Error: DATABASE_URL is not set and could not be resolved from .env files." >&2
  exit 1
fi

# Ensure binaries exist
if [ ! -f "$NEW_BINARY" ]; then
  echo "Error: New binary '$NEW_BINARY' does not exist." >&2
  exit 1
fi

if [ ! -f "$CURRENT_BINARY" ]; then
  echo "Error: Current binary '$CURRENT_BINARY' does not exist." >&2
  exit 1
fi

if [ ! -f "$DB_BACKUP_FILE" ]; then
  echo "Error: Database backup file '$DB_BACKUP_FILE' does not exist." >&2
  exit 1
fi

# 1. Create a backup of the current database (post-update attempt backup)
echo "Creating diagnostic backup of current database state..."
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DIAG_BACKUP="backups/diag_backup_post_update_${TIMESTAMP}.dump"
mkdir -p backups

if pg_dump -d "$DATABASE_URL" -F c -f "$DIAG_BACKUP" 2>/dev/null; then
  echo "Diagnostic backup created: $DIAG_BACKUP"
else
  echo "pg_dump failed locally. Attempting Docker fallback..."
  if docker exec -i riverside-os-db pg_dump -U postgres -F c riverside_os > "$DIAG_BACKUP" 2>/dev/null; then
    echo "Diagnostic backup created via Docker: $DIAG_BACKUP"
  else
    echo "Warning: Database backup failed. Proceeding with caution..."
  fi
fi

# 2. Launch the new server binary in the background
echo "Launching new binary in the background: $NEW_BINARY"
chmod +x "$NEW_BINARY"
"$NEW_BINARY" > new_server.log 2>&1 &
NEW_PID=$!

# Ensure we cleanup if script is interrupted
cleanup_new_server() {
  if kill -0 "$NEW_PID" 2>/dev/null; then
    echo "Cleaning up new server process..."
    kill -9 "$NEW_PID" 2>/dev/null || true
  fi
}
trap cleanup_new_server INT TERM

# 3. Poll health checks
HEALTH_URL="http://localhost:3000/api/health/ready"
TIMEOUT=120
INTERVAL=5
ELAPSED=0
SUCCESS=false

echo "Polling health endpoint: $HEALTH_URL for $TIMEOUT seconds..."
while [ $ELAPSED -lt $TIMEOUT ]; do
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    echo "Error: New server process crashed!"
    break
  fi

  STATUS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" || echo "000")
  if [ "$STATUS_CODE" = "200" ]; then
    echo "Server successfully booted! Response 200 OK from $HEALTH_URL"
    SUCCESS=true
    break
  fi

  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))
done

if [ "$SUCCESS" = "true" ]; then
  echo "Update verification succeeded. New version is healthy."
  trap - INT TERM
  exit 0
fi

# 4. Rollback procedures
echo "Verification failed! Initiating rollback..."
cleanup_new_server
trap - INT TERM

# Restore the database from the pre-update backup
echo "Restoring database from pre-update backup: $DB_BACKUP_FILE..."
RESTORE_OK=false

if pg_restore -d "$DATABASE_URL" --clean --if-exists --no-owner "$DB_BACKUP_FILE" 2>/dev/null; then
  RESTORE_OK=true
else
  echo "pg_restore failed locally. Attempting Docker fallback..."
  if docker exec -i riverside-os-db pg_restore -U postgres -d riverside_os --clean --if-exists --no-owner < "$DB_BACKUP_FILE" 2>/dev/null; then
    RESTORE_OK=true
  else
    echo "Attempting schema pre-clean restore via Docker fallback..."
    docker exec -i riverside-os-db psql -U postgres -d riverside_os -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO postgres; GRANT USAGE ON SCHEMA public TO public;" >/dev/null 2>&1
    if docker exec -i riverside-os-db pg_restore -U postgres -d riverside_os --no-owner < "$DB_BACKUP_FILE" 2>/dev/null; then
      RESTORE_OK=true
    fi
  fi
fi

if [ "$RESTORE_OK" = "true" ]; then
  echo "Database restored successfully."
else
  echo "Critical: Database restore failed!" >&2
fi

# Restart the previous binary
echo "Restarting current binary: $CURRENT_BINARY"
chmod +x "$CURRENT_BINARY"
"$CURRENT_BINARY" > current_server.log 2>&1 &

# Write rollback message to rollback_error.log
LOG_MSG="[$(date)] ROLLBACK TRIGGERED: New binary '$NEW_BINARY' failed health check. Restored database from '$DB_BACKUP_FILE' and restarted '$CURRENT_BINARY'."
echo "$LOG_MSG" >> rollback_error.log
echo "Rollback completed. Details recorded in rollback_error.log."

exit 1
